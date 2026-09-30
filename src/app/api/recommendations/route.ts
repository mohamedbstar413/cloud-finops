import { route } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { listRecommendations, potentialSavings } from "@/lib/services/queries";

export const GET = route(async (req: Request) => {
  const { org } = await getSession();
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");
  const category = url.searchParams.get("category");
  const status = url.searchParams.get("status") ?? "active";
  let recs = await listRecommendations(org.id);
  if (provider) recs = recs.filter((r) => r.provider === provider || r.targetProvider === provider);
  if (category) recs = recs.filter((r) => r.category === category);
  if (status === "active") recs = recs.filter((r) => r.status === "open" || r.status === "in_progress");
  else if (status !== "all") recs = recs.filter((r) => r.status === status);
  return { recommendations: recs, potentialSavings: potentialSavings(recs) };
});
