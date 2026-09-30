import { ENGINEER_WEEK_COST, Provider } from "../pricing/catalog";
import { Component, ComponentKind, PricedComponent, priceComponent, priceComponents } from "../pricing/components";
import type {
  ArchitectureSpec,
  DiagramEdge,
  DiagramNode,
  Level,
  RecommendationDetails,
  RecommendationDraft,
  ResourceRow,
} from "./types";

export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export const money = (n: number) =>
  `$${Math.round(n).toLocaleString("en-US")}`;

export const pct = (n: number) => `${Math.round(n)}%`;

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export function median(values: number[]): number {
  return percentile(values, 50);
}

export function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export const sumCost = (rs: { monthlyCost: number }[]) => sum(rs.map((r) => r.monthlyCost));

export function weightedAvg(rs: ResourceRow[], pick: (r: ResourceRow) => number | undefined): number {
  let w = 0;
  let t = 0;
  for (const r of rs) {
    const v = pick(r);
    if (v === undefined) continue;
    w += r.quantity;
    t += v * r.quantity;
  }
  return w ? t / w : 0;
}

export function impactFor(savings: number, pctSaved: number): Level {
  if (savings >= 2500 || (savings >= 1500 && pctSaved >= 50)) return "high";
  if (savings >= 400) return "medium";
  return "low";
}

export function migrationCostFromWeeks(engineerWeeks: number) {
  return engineerWeeks * ENGINEER_WEEK_COST;
}

export function buildArchitecture(
  title: string,
  provider: Provider,
  components: Component[],
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  bullets: string[],
): ArchitectureSpec {
  const priced = priceComponents(components);
  return {
    title,
    provider,
    monthlyCost: priced.total,
    components: priced.components,
    nodes,
    edges,
    bullets,
  };
}

/** Existing resources expressed as already-priced components (uses billed cost). */
export function resourcesAsComponents(rs: ResourceRow[]): PricedComponent[] {
  return rs.map((r) => ({
    id: r.id,
    kind: (r.kind as Component["kind"]) ?? "other.fixed",
    provider: r.provider,
    label: r.name,
    sku: r.sku ?? undefined,
    region: r.region,
    usage: { count: r.quantity },
    monthlyCost: round(r.monthlyCost),
    pricingNote: `${r.quantity > 1 ? `${r.quantity} × ` : ""}${r.service}${r.sku ? ` ${r.sku}` : ""} (billed)`,
  }));
}

export function specFromResources(
  title: string,
  provider: Provider,
  rs: ResourceRow[],
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  bullets: string[],
): ArchitectureSpec {
  const components = resourcesAsComponents(rs);
  return {
    title,
    provider,
    monthlyCost: round(sumCost(rs)),
    components,
    nodes,
    edges,
    bullets,
  };
}

interface DraftInput extends Omit<RecommendationDraft, "monthlySavings" | "savingsPct" | "projectedMonthlyCost" | "details" | "impact"> {
  projectedMonthlyCost: number;
  details: Omit<RecommendationDetails, "evidence" | "benefits" | "risks" | "implementation"> &
    Partial<Pick<RecommendationDetails, "evidence" | "benefits" | "risks" | "implementation">>;
}

export function makeDraft(input: DraftInput): RecommendationDraft {
  const current = round(input.currentMonthlyCost);
  const projected = round(Math.max(0, input.projectedMonthlyCost));
  const savings = round(Math.max(0, current - projected));
  const savingsPct = current > 0 ? round((savings / current) * 100, 1) : 0;
  return {
    ...input,
    currentMonthlyCost: current,
    projectedMonthlyCost: projected,
    monthlySavings: savings,
    savingsPct,
    impact: impactFor(savings, savingsPct),
    details: {
      evidence: [],
      benefits: [],
      risks: [],
      implementation: [],
      ...input.details,
    },
  };
}

export function tagValue(r: ResourceRow, key: string): string | undefined {
  const t = r.tags.find((x) => x.startsWith(`${key}=`));
  return t?.slice(key.length + 1);
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export const countOf = (rs: ResourceRow[]) => sum(rs.map((r) => r.quantity));

/** Guard against NaN/Infinity from degenerate inputs (zero-sized fleets, empty metrics). */
export function isFiniteDraft(d: Pick<RecommendationDraft, "currentMonthlyCost" | "projectedMonthlyCost" | "monthlySavings" | "migrationCost" | "title">): boolean {
  const ok = [d.currentMonthlyCost, d.projectedMonthlyCost, d.monthlySavings, d.migrationCost].every(Number.isFinite);
  if (!ok) console.warn(`[engine] dropped non-finite recommendation: ${d.title}`);
  return ok;
}

/**
 * Billed ÷ list price for a set of resources — captures enterprise discounts,
 * reserved capacity and negotiated rates. Like-for-like changes (rightsizing,
 * Arm) are priced at this rate so existing discounts carry over. 1 when unknown.
 */
export function effectiveRate(rs: ResourceRow[]): number {
  let billed = 0;
  let list = 0;
  for (const r of rs) {
    const l = priceComponent({
      id: r.id,
      kind: r.kind as ComponentKind,
      provider: r.provider,
      label: r.name,
      sku: r.sku ?? undefined,
      region: r.region,
      usage: { count: r.quantity, multiAz: r.config.multiAz, storageGb: r.kind === "db.instance" ? r.config.sizeGb : undefined },
    }).monthlyCost;
    if (l > 0 && r.monthlyCost > 0) {
      billed += r.monthlyCost;
      list += l;
    }
  }
  return list > 0 ? Math.min(2, Math.max(0.2, billed / list)) : 1;
}

export function atEffectiveRate(spec: ArchitectureSpec, rate: number): ArchitectureSpec {
  if (Math.abs(rate - 1) < 0.005) return spec;
  const components = spec.components.map((c) => ({ ...c, monthlyCost: round(c.monthlyCost * rate), pricingNote: `${c.pricingNote} × ${Math.round(rate * 100)}% effective rate` }));
  return { ...spec, components, monthlyCost: round(components.reduce((s, c) => s + c.monthlyCost, 0)) };
}
