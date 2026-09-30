import { z } from "zod";
import { parseJson } from "./db";

/**
 * Per-organization settings. Every field has a default, so an organization
 * created before a setting existed still gets a sensible value.
 */
export const CHANGE_TYPES = {
  rightsizing: "Resize instances and databases",
  storage_tier: "Storage classes and lifecycle rules",
  gp3: "Volume type (gp2 → gp3)",
  delete_unattached: "Delete unattached volumes (after an archive backup)",
  release_ips: "Release unused IP addresses",
  schedules: "Start/stop schedules for non-production",
  architecture: "Architecture changes (serverless, containers, Spot, endpoints)",
  commitments: "Savings Plans / reservations",
} as const;
export type ChangeType = keyof typeof CHANGE_TYPES;
const changeTypes = Object.keys(CHANGE_TYPES) as [ChangeType, ...ChangeType[]];

/** Change types low-risk enough to be applied automatically when a customer opts in. */
export const LOW_RISK_CHANGES: ChangeType[] = ["gp3", "release_ips", "delete_unattached", "storage_tier"];

export const OrgSettings = z.object({
  remediation: z
    .object({
      /** branch: push each change to its own branch · branch_and_pr: also open a pull request · auto_apply: apply allowed low-risk changes after the plan checks pass */
      mode: z.enum(["branch", "branch_and_pr", "auto_apply"]).default("branch"),
      branchPrefix: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._/-]+$/, "Letters, digits, . _ / - only").default("cloud-optimizer/"),
      allowedChanges: z.array(z.enum(changeTypes)).default([...changeTypes]),
    })
    .default({ mode: "branch", branchPrefix: "cloud-optimizer/", allowedChanges: [...changeTypes] }),
  backups: z
    .object({
      /** How long the archive backup of a deleted volume, disk or bucket is kept. null = until someone deletes it. */
      retentionDays: z.number().int().min(30).max(3650).nullable().default(365),
    })
    .default({ retentionDays: 365 }),
  sync: z
    .object({
      enabled: z.boolean().default(true),
      /** UTC hour of the daily sync and analysis. */
      hourUtc: z.number().int().min(0).max(23).default(3),
    })
    .default({ enabled: true, hourUtc: 3 }),
  notifications: z
    .object({
      /** Extra addresses; owners and admins are always included. */
      emails: z.array(z.string().email()).max(20).default([]),
      newHighImpact: z.boolean().default(true),
      syncFailures: z.boolean().default(true),
    })
    .default({ emails: [], newHighImpact: true, syncFailures: true }),
  git: z
    .object({
      provider: z.enum(["github", "gitlab"]).nullable().default(null),
      repository: z.string().trim().max(200).default(""),
      baseBranch: z.string().trim().max(100).default("main"),
      terraformPath: z.string().trim().max(200).default("/"),
    })
    .default({ provider: null, repository: "", baseBranch: "main", terraformPath: "/" }),
});
export type OrgSettings = z.infer<typeof OrgSettings>;

export const parseSettings = (raw: string | null | undefined): OrgSettings => {
  const r = OrgSettings.safeParse(parseJson(raw, {}));
  return r.success ? r.data : OrgSettings.parse({});
};

/** Merge a partial update (one section at a time) into stored settings and validate the result. */
export function mergeSettings(current: OrgSettings, patch: Partial<Record<keyof OrgSettings, unknown>>): OrgSettings {
  const merged: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) merged[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...(current as Record<string, object>)[k], ...v } : v;
  return OrgSettings.parse(merged);
}
