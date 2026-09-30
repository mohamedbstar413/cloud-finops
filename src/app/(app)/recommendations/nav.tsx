import { SubNav } from "@/components/SubNav";
import type { RecRow } from "@/lib/services/queries";

export const isActive = (r: Pick<RecRow, "status">) => r.status === "open" || r.status === "in_progress";

/** Open · Held back · History — three focused pages instead of one crowded one. */
export function RecommendationsNav({ recs, heldBack }: { recs: RecRow[]; heldBack: number }) {
  return (
    <SubNav
      items={[
        { href: "/recommendations", label: "Open", count: recs.filter(isActive).length },
        { href: "/recommendations/held-back", label: "Held back", count: heldBack },
        { href: "/recommendations/history", label: "History", count: recs.filter((r) => !isActive(r)).length },
      ]}
    />
  );
}
