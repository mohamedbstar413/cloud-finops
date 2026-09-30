import OpenAI from "openai";

let client: OpenAI | null | undefined;

export function aiEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function aiModel(): string {
  return process.env.OPENAI_MODEL || "gpt-4.1";
}

function getClient(): OpenAI | null {
  if (client !== undefined) return client;
  client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  return client;
}

export class AIUnavailableError extends Error {
  constructor() {
    super("OPENAI_API_KEY is not configured");
  }
}

/**
 * Structured generation with OpenAI JSON-schema strict mode. The schema is the
 * contract: the model can only answer in shapes our pricing engine can price.
 */
export async function generateStructured<T>(opts: {
  name: string;
  schema: Record<string, unknown>;
  system: string;
  user: string;
  temperature?: number;
}): Promise<{ data: T; model: string }> {
  const c = getClient();
  if (!c) throw new AIUnavailableError();
  const model = aiModel();
  const res = await c.chat.completions.create({
    model,
    temperature: opts.temperature ?? 0.2,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: opts.name, schema: opts.schema, strict: true },
    },
  });
  const msg = res.choices[0]?.message;
  if (msg?.refusal) throw new Error(`Model refused: ${msg.refusal}`);
  if (!msg?.content) throw new Error("Empty response from model");
  return { data: JSON.parse(msg.content) as T, model: res.model ?? model };
}

/* ---------------- JSON-schema helpers (strict mode) ---------------- */

export const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
export const num = (description?: string) => ({ type: "number", ...(description ? { description } : {}) });
export const bool = () => ({ type: "boolean" });
export const nullable = (s: Record<string, unknown>) => ({ ...s, type: [s.type as string, "null"] });
export const enumOf = (values: readonly string[], description?: string) => ({ type: "string", enum: values, ...(description ? { description } : {}) });
export const arr = (items: Record<string, unknown>, description?: string) => ({ type: "array", items, ...(description ? { description } : {}) });
export const obj = (properties: Record<string, Record<string, unknown>>, description?: string) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
  ...(description ? { description } : {}),
});

/** Recursively drop nulls produced by strict-mode nullable fields. */
export function stripNulls<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripNulls) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== null) out[k] = stripNulls(x);
    return out as T;
  }
  return v;
}
