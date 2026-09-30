import { cheapestEquivalentVm, PRICES, resolveVm, type Provider } from "../pricing/catalog";
import { COMPONENT_KINDS, type Component, type ComponentUsage } from "../pricing/components";

const PROVIDERS = ["aws", "azure", "gcp"];
const TIERS = new Set(["hot", "cool", "cold", "archive", "premium", "standard", "http", "rest", "gateway", "interface"]);
const DESTINATIONS = new Set(["internet", "inter_region", "inter_cloud"]);
const ROLES = new Set(["web", "batch", "stateful", "k8s"]);
const NUMERIC: (keyof ComponentUsage)[] = ["count", "hours", "requestsM", "avgDurationMs", "memoryMb", "vcpu", "memGb", "activeHours", "gb", "storageGb", "capacityUnits", "vcores", "monthlyCost"];
/** Upper bounds that catch unit mistakes (e.g. bytes instead of GB) before they reach pricing. */
const MAX: Partial<Record<keyof ComponentUsage, number>> = { count: 10_000, hours: 744 * 1.2, activeHours: 744 * 1000, avgDurationMs: 900_000, memoryMb: 10_240, vcpu: 64, memGb: 512, vcores: 512 };

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v.replace(/[, ]/g, "")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Coerce model output into components the pricing engine can price safely:
 * drops unknown kinds, fixes providers, resolves or substitutes VM types, and
 * clamps every numeric field to a finite, non-negative, plausible range.
 */
export function normalizeComponents(raw: unknown[], fallbackProvider: Provider): Component[] {
  const out: Component[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const c = item as Record<string, unknown>;
    const kind = c.kind as Component["kind"];
    if (!(COMPONENT_KINDS as readonly string[]).includes(kind)) return;
    const provider = (PROVIDERS.includes(String(c.provider)) ? c.provider : fallbackProvider) as Provider;
    let label = typeof c.label === "string" && c.label.trim() ? c.label.trim().slice(0, 120) : kind;
    let sku = typeof c.sku === "string" && c.sku.trim() ? c.sku.trim() : undefined;

    const rawUsage = (c.usage && typeof c.usage === "object" ? c.usage : {}) as Record<string, unknown>;
    const usage: ComponentUsage = {};
    for (const k of NUMERIC) {
      const n = num(rawUsage[k]);
      if (n === undefined) continue;
      // Only a commitment credit (other.fixed) may be negative.
      const v = k === "monthlyCost" && kind === "other.fixed" ? n : Math.max(0, n);
      (usage as Record<string, number>)[k] = MAX[k] !== undefined ? Math.min(v, MAX[k]!) : v;
    }
    if (typeof rawUsage.spot === "boolean") usage.spot = rawUsage.spot;
    if (typeof rawUsage.multiAz === "boolean") usage.multiAz = rawUsage.multiAz;
    if (TIERS.has(String(rawUsage.tier))) usage.tier = rawUsage.tier as ComponentUsage["tier"];
    if (DESTINATIONS.has(String(rawUsage.destination))) usage.destination = rawUsage.destination as ComponentUsage["destination"];

    if (kind === "compute.vm") {
      const vm = resolveVm(sku);
      if (!vm || vm.provider !== provider) {
        const eq = cheapestEquivalentVm(provider, vm?.vcpu ?? 4, vm?.memGiB ?? 16);
        label = `${label} (≈ ${eq?.sku})`;
        sku = eq?.sku;
      }
      usage.count = Math.max(1, Math.round(usage.count ?? 1));
    }
    if (kind === "db.instance" && (!sku || !PRICES.dbInstance[sku])) sku = "db.r5.xlarge";
    if (kind === "app.plan" && (!sku || !PRICES.appPlatformPlan[sku])) sku = "P1v3";

    out.push({
      id: typeof c.id === "string" && c.id ? c.id : `ai-${i}`,
      kind,
      provider,
      label,
      sku,
      region: typeof c.region === "string" ? c.region : undefined,
      role: ROLES.has(String(c.role)) ? (c.role as Component["role"]) : undefined,
      usage,
    });
  });
  return out;
}
