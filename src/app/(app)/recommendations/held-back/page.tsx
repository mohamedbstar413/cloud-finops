import { HeldBackList } from "@/components/HeldBack";
import { Card, Empty, PageHeader } from "@/components/ui";
import { pageSession } from "@/lib/auth";
import { timeAgo, usd } from "@/lib/format";
import { getDataCoverage, listRecommendations } from "@/lib/services/queries";
import { RecommendationsNav } from "../nav";

export default async function HeldBackPage() {
  const { org } = await pageSession();
  const [recs, data] = await Promise.all([listRecommendations(org.id), getDataCoverage(org.id)]);
  const gaps = data?.gaps ?? [];
  const c = data?.coverage;
  const range = c && (c.minDays === c.maxDays ? `${c.maxDays} days` : `${c.minDays}–${c.maxDays} days`);
  return (
    <>
      <PageHeader title="Recommendations" subtitle="Resources the engine deliberately left alone, and what would let it decide" />
      <RecommendationsNav recs={recs} heldBack={gaps.length} />

      {data && c && (
        <div className="mb-6 grid gap-4 sm:grid-cols-3">
          <Card className="px-5 py-4">
            <p className="text-xs font-medium text-muted">Usage history</p>
            <p className="mt-1.5 text-[24px] font-semibold tracking-tight">
              {c.withHistory} <span className="text-[15px] font-normal text-muted">of {c.measurable} resources</span>
            </p>
            <p className="mt-1 text-xs text-muted">{c.withHistory ? range : "No history collected yet"}</p>
          </Card>
          <Card className="px-5 py-4">
            <p className="text-xs font-medium text-muted">Held back</p>
            <p className="mt-1.5 text-[24px] font-semibold tracking-tight">{gaps.length}</p>
            <p className="mt-1 text-xs text-muted">{c.unmeasured ? `${c.unmeasured} more with no usage data at all` : "Instead of a guess"}</p>
          </Card>
          <Card className="px-5 py-4">
            <p className="text-xs font-medium text-muted">Spend not optimized</p>
            <p className="mt-1.5 text-[24px] font-semibold tracking-tight">{usd(data.heldBackCost)}</p>
            <p className="mt-1 text-xs text-muted">per month · analysed {timeAgo(data.at)}</p>
          </Card>
        </div>
      )}

      {gaps.length ? (
        <>
          <p className="mb-4 max-w-3xl text-[13px] leading-relaxed text-muted">
            These resources looked like candidates, but the data did not support a safe recommendation: a metric is not collected, the history is too short, usage is growing, or a
            host that looks idle still moves data. Each one says what would let the engine decide next time.
          </p>
          <HeldBackList gaps={gaps} />
        </>
      ) : (
        <Empty title="Nothing held back">Every candidate had the usage data it needed.</Empty>
      )}
    </>
  );
}
