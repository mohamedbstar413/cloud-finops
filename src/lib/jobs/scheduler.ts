import { prisma } from "../db";
import { parseSettings } from "../settings";
import { enqueue } from "./queue";

/** Next time the given UTC hour comes round, strictly after `from`. */
export function nextRunAt(hourUtc: number, from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hourUtc));
  if (d <= from) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * The daily sync: for every organization whose time has come, sync each cloud
 * account, then analyse once. Runs every minute from the worker; organizations
 * are spread over the day by their own configured hour.
 */
export async function scheduleDueSyncs(now = new Date()) {
  const orgs = await prisma.organization.findMany({
    where: { deletedAt: null, OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }] },
    select: { id: true, settings: true, nextSyncAt: true, accounts: { select: { id: true } } },
  });
  let queued = 0;
  for (const org of orgs) {
    const sync = parseSettings(org.settings).sync;
    const next = nextRunAt(sync.hourUtc, now);
    // First sighting of an organization only sets its schedule; it already synced when it connected.
    if (org.nextSyncAt && sync.enabled && org.accounts.length) {
      for (const a of org.accounts) await enqueue(org.id, "sync_account", { accountId: a.id });
      await enqueue(org.id, "analyze", {});
      queued++;
    }
    await prisma.organization.update({ where: { id: org.id }, data: { nextSyncAt: next } });
  }
  return queued;
}
