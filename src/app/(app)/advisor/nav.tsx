import { SubNav } from "@/components/SubNav";

export function AdvisorNav({ scenarios }: { scenarios: number }) {
  return (
    <SubNav
      items={[
        { href: "/advisor", label: "Ask a question" },
        { href: "/advisor/history", label: "Scenarios", count: scenarios, alsoFor: ["/advisor/scenarios/"] },
      ]}
    />
  );
}
