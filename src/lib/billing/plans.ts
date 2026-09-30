/** Plans and their limits. `null` means unlimited. */
export type PlanId = "free" | "pro" | "enterprise";

export interface Plan {
  id: PlanId;
  name: string;
  priceMonthly: number | null;
  blurb: string;
  limits: {
    cloudAccounts: number | null;
    resources: number | null;
    members: number | null;
    aiCallsPerMonth: number | null;
    manualSyncsPerDay: number | null;
  };
  features: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    blurb: "One cloud account, to see what the optimizer finds",
    limits: { cloudAccounts: 1, resources: 250, members: 3, aiCallsPerMonth: 20, manualSyncsPerDay: 5 },
    features: ["Daily sync and analysis", "All detectors, usage history", "What-if simulator"],
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceMonthly: 499,
    blurb: "For teams optimizing a production estate across clouds",
    limits: { cloudAccounts: 25, resources: 10_000, members: 50, aiCallsPerMonth: 1_000, manualSyncsPerDay: 50 },
    features: ["Everything in Free", "AI architecture discovery and deep-dives", "Git remediation branches", "Ticketing webhook"],
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    priceMonthly: null,
    blurb: "Unlimited scale, SSO and a dedicated key",
    limits: { cloudAccounts: null, resources: null, members: null, aiCallsPerMonth: null, manualSyncsPerDay: null },
    features: ["Everything in Pro", "Unlimited accounts and resources", "SSO / SAML", "Customer-managed encryption key"],
  },
};

export const planOf = (id: string | null | undefined): Plan => PLANS[(id as PlanId) in PLANS ? (id as PlanId) : "free"];
