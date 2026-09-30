import { usage } from "../billing/limits";
import { prisma, parseJson } from "../db";
import { sendEmail, appUrl } from "../email";
import { runAnalysis } from "../services/analysis";
import { syncAccount } from "../services/ingest";
import { deleteOrganizationData } from "../services/org-lifecycle";
import { parseSettings } from "../settings";
import { usd } from "../format";

type JobRow = { id: string; orgId: string; type: string; payload: string; attempts: number; maxAttempts: number };

/** Owners, admins and the extra addresses in the organization's notification settings. */
async function recipients(orgId: string, extra: string[]) {
  const admins = await prisma.membership.findMany({ where: { orgId, role: { in: ["owner", "admin"] } }, include: { user: true } });
  return [...new Set([...admins.map((m) => m.user.email), ...extra])].filter((e) => !e.endsWith("@cloudpriceoptimizer.dev"));
}

export async function runJob(job: JobRow): Promise<unknown> {
  const payload = parseJson<Record<string, string>>(job.payload, {});
  const org = await prisma.organization.findUnique({ where: { id: job.orgId } });
  if (!org) return { skipped: "organization no longer exists" };
  if (org.deletedAt && job.type !== "delete_org") return { skipped: "organization is being deleted" };
  const settings = parseSettings(org.settings);

  switch (job.type) {
    case "sync_account": {
      const account = await prisma.cloudAccount.findFirst({ where: { id: payload.accountId, orgId: org.id } });
      if (!account) return { skipped: "account was disconnected" };
      const r = await syncAccount(account.id, { analyze: false });
      if (!r.ok) {
        // Tell people once, on the last attempt, not on every retry.
        if (job.attempts >= job.maxAttempts && settings.notifications.syncFailures && !org.isDemo) {
          for (const to of await recipients(org.id, settings.notifications.emails)) {
            await sendEmail({ to, subject: `Sync failed: ${account.name} (${account.provider.toUpperCase()})`, text: `The daily sync of ${account.name} failed:\n\n${r.error}\n\nCheck the connection: ${appUrl("/accounts")}` });
          }
        }
        throw new Error(r.error);
      }
      // The plan's resource allowance is soft: everything is still analysed, and the account says so.
      const u = await usage(org.id);
      const res = u.meters.find((m) => m.id === "resources")!;
      if (!account.isDemo && res.limit !== null && res.used > res.limit) {
        const warning = `This organization has ${res.used.toLocaleString()} resources; the ${u.plan.name} plan includes ${res.limit.toLocaleString()}. Upgrade on the Billing page to stay covered.`;
        await prisma.cloudAccount.update({ where: { id: account.id }, data: { syncWarnings: JSON.stringify([...r.warnings, warning].slice(0, 20)) } });
      }
      return { resources: r.resources, series: r.series, costRows: r.costRows, warnings: r.warnings };
    }
    case "analyze": {
      const r = await runAnalysis(org.id);
      const highImpact = r.created.filter((c) => c.impact === "high");
      if (highImpact.length && settings.notifications.newHighImpact && !org.isDemo) {
        const lines = highImpact.map((c) => `• ${c.title} — ${usd(c.monthlySavings)}/month`).join("\n");
        for (const to of await recipients(org.id, settings.notifications.emails)) {
          await sendEmail({ to, subject: `${highImpact.length} new high-impact saving${highImpact.length > 1 ? "s" : ""} for ${org.name}`, text: `${lines}\n\nReview them: ${appUrl("/recommendations")}` });
        }
      }
      if (!org.onboardedAt) await prisma.organization.update({ where: { id: org.id }, data: { onboardedAt: new Date() } });
      return { recommendations: r.recommendations, monthlySavings: r.monthlySavings, heldBack: r.heldBack, created: r.created.length };
    }
    case "delete_org":
      return deleteOrganizationData(org.id);
    default:
      throw new Error(`Unknown job type ${job.type}`);
  }
}
