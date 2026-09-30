import { LinkButton } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="grid place-items-center py-24 text-center">
      <p className="text-[15px] font-semibold">Not found</p>
      <p className="mt-1 text-[13px] text-muted">This item may have been resolved, dismissed or removed by a re-analysis.</p>
      <LinkButton href="/recommendations" variant="primary" className="mt-4">
        Back to recommendations
      </LinkButton>
    </div>
  );
}
