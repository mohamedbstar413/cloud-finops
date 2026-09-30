import { route } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { getCostExplorer, parseCostFilters } from "@/lib/services/queries";

export const GET = route(async (req: Request) => {
  const { org } = await getSession();
  const url = new URL(req.url);
  const data = await getCostExplorer(org.id, parseCostFilters(url.searchParams));
  if (url.searchParams.get("format") === "csv") {
    const lines = [
      "service,provider,category,cost_usd,percent_of_total,change_vs_previous_pct",
      ...data.rows.map((r) => [JSON.stringify(r.service), r.provider, r.category, r.cost.toFixed(2), r.pct.toFixed(2), r.changePct ?? ""].join(",")),
    ];
    return new Response(lines.join("\n"), {
      headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="cost-explorer-${new Date().toISOString().slice(0, 10)}.csv"` },
    });
  }
  return data;
});
