import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AIUnavailableError } from "./ai/client";
import { HttpError } from "./auth";

/** Uniform JSON error handling for route handlers. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A) => {
    try {
      const out = await fn(...args);
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof ZodError) return NextResponse.json({ error: "Invalid request", issues: e.issues }, { status: 400 });
      if (e instanceof AIUnavailableError) return NextResponse.json({ error: e.message, code: "ai_unavailable" }, { status: 412 });
      console.error(e);
      return NextResponse.json({ error: (e as Error).message ?? "Internal error" }, { status: 500 });
    }
  };
}

export type Ctx<P extends Record<string, string>> = { params: Promise<P> };
