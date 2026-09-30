/**
 * SaaS foundations against a real (temporary) database: accounts and sessions,
 * tenant isolation, invitations, password resets, the read-only demo, per-tenant
 * encryption, the job queue and scheduler, plan limits, settings, billing
 * webhooks, and organization export and deletion.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";

// Runs on a throwaway SQLite file by default; set TEST_POSTGRES_URL (with the Postgres client generated)
// to run the same tests against PostgreSQL. Each Postgres run gets its own schema, dropped afterwards,
// so existing data in that database is never touched.
const PG = process.env.TEST_POSTGRES_URL;
const DB_FILE = `test-saas-${process.pid}.db`;
const PG_SCHEMA = `test_saas_${process.pid}`;
const pgUrl = (url: string) => {
  const u = new URL(url);
  u.searchParams.set("schema", PG_SCHEMA);
  return u.toString();
};
process.env.DATABASE_URL = PG ? pgUrl(PG) : `file:./${DB_FILE}`;
(process.env as Record<string, string>).NODE_ENV = "test";

type Mods = {
  prisma: typeof import("../src/lib/db").prisma;
  auth: typeof import("../src/lib/services/auth");
  crypto: typeof import("../src/lib/tenant-crypto");
  legacy: typeof import("../src/lib/crypto");
  queue: typeof import("../src/lib/jobs/queue");
  worker: typeof import("../src/lib/jobs/worker");
  scheduler: typeof import("../src/lib/jobs/scheduler");
  limits: typeof import("../src/lib/billing/limits");
  settings: typeof import("../src/lib/settings");
  stripe: typeof import("../src/lib/billing/stripe");
  lifecycle: typeof import("../src/lib/services/org-lifecycle");
  email: typeof import("../src/lib/email");
  tokens: typeof import("../src/lib/security/tokens");
  demo: typeof import("../src/lib/demo/estate");
};
let m: Mods;

before(async () => {
  execSync(PG ? "npx prisma db push --skip-generate --schema prisma/postgres/schema.prisma" : "npx prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: "ignore",
  });
  m = {
    prisma: (await import("../src/lib/db")).prisma,
    auth: await import("../src/lib/services/auth"),
    crypto: await import("../src/lib/tenant-crypto"),
    legacy: await import("../src/lib/crypto"),
    queue: await import("../src/lib/jobs/queue"),
    worker: await import("../src/lib/jobs/worker"),
    scheduler: await import("../src/lib/jobs/scheduler"),
    limits: await import("../src/lib/billing/limits"),
    settings: await import("../src/lib/settings"),
    stripe: await import("../src/lib/billing/stripe"),
    lifecycle: await import("../src/lib/services/org-lifecycle"),
    email: await import("../src/lib/email"),
    tokens: await import("../src/lib/security/tokens"),
    demo: await import("../src/lib/demo/estate"),
  };
});

after(async () => {
  if (PG) await m?.prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${PG_SCHEMA}" CASCADE`);
  await m?.prisma.$disconnect();
  if (!PG) for (const f of [DB_FILE, `${DB_FILE}-journal`]) rmSync(`prisma/${f}`, { force: true });
});

let n = 0;
const uniq = () => `u${process.pid}-${++n}`;
const PASSWORD = "correct horse battery";

async function signUp(org = "Globex") {
  const email = `${uniq()}@example.com`;
  const r = await m.auth.signUp({ name: "Test Person", email, password: PASSWORD, organization: org });
  return { ...r, email };
}

const expectStatus = async (p: Promise<unknown>, status: number, message?: RegExp) => {
  await assert.rejects(p, (e: Error & { status?: number }) => {
    assert.equal(e.status, status, `expected ${status}, got ${e.status}: ${e.message}`);
    if (message) assert.match(e.message, message);
    return true;
  });
};

/* ------------------------------------------------------------------------- */

describe("accounts and sessions", () => {
  it("signs up: a hashed password, a new organization with you as owner, and a session", async () => {
    const { user, org, token, email } = await signUp("Initech");
    const stored = await m.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.ok(stored.passwordHash?.startsWith("scrypt$") && !stored.passwordHash.includes(PASSWORD));
    assert.equal(org.plan, "free");
    const s = await m.auth.resolveSession(token);
    assert.equal(s?.user.email, email);
    assert.equal(s?.org?.id, org.id);
    assert.equal(s?.role, "owner");
    // Only the token's hash is stored.
    assert.equal(await m.prisma.session.count({ where: { tokenHash: token } }), 0);
    assert.equal(await m.prisma.session.count({ where: { tokenHash: m.tokens.hashToken(token) } }), 1);
  });

  it("refuses duplicate accounts and weak passwords", async () => {
    const { email } = await signUp();
    await expectStatus(m.auth.signUp({ name: "Again", email: email.toUpperCase(), password: PASSWORD, organization: "X Co" }), 409);
    await expectStatus(m.auth.signUp({ name: "Weak", email: `${uniq()}@example.com`, password: "short", organization: "X Co" }), 400, /at least 10/);
    await expectStatus(m.auth.signUp({ name: "", email: `${uniq()}@example.com`, password: PASSWORD, organization: "X Co" }), 400);
  });

  it("signs in with the right password only, with the same answer for unknown emails", async () => {
    const { email, org } = await signUp();
    const ok = await m.auth.signIn({ email: ` ${email.toUpperCase()} `, password: PASSWORD, client: "1.1.1.1" });
    assert.equal(ok.orgId, org.id);
    await expectStatus(m.auth.signIn({ email, password: "wrong password!", client: "1.1.1.1" }), 401, /Email or password is incorrect/);
    await expectStatus(m.auth.signIn({ email: `${uniq()}@example.com`, password: PASSWORD, client: "1.1.1.1" }), 401, /Email or password is incorrect/);
  });

  it("locks an email out after repeated failures", async () => {
    const { email } = await signUp();
    for (let i = 0; i < 8; i++) await expectStatus(m.auth.signIn({ email, password: "wrong password!", client: `10.0.0.${i}` }), 401);
    await expectStatus(m.auth.signIn({ email, password: PASSWORD, client: "10.0.1.1" }), 429);
  });

  it("has no fallback user: unknown, expired and ended sessions resolve to nobody", async () => {
    assert.equal(await m.auth.resolveSession("not-a-token"), null);
    const { user, org, token } = await signUp();
    await m.prisma.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal(await m.auth.resolveSession(token), null);
    const fresh = await m.auth.createSession(user.id, org.id);
    assert.ok(await m.auth.resolveSession(fresh.token));
    await m.auth.endSession(fresh.token);
    assert.equal(await m.auth.resolveSession(fresh.token), null);
  });
});

describe("tenant isolation", () => {
  it("never lets a user into an organization they don't belong to", async () => {
    const a = await signUp("Tenant A");
    const b = await signUp("Tenant B");
    const sa = (await m.auth.resolveSession(a.token))!;
    await expectStatus(m.auth.switchOrganization(sa.sessionId, a.user.id, b.org.id), 404);
    // A session pointing at an organization the user left is dropped from that organization.
    await m.prisma.session.update({ where: { id: sa.sessionId }, data: { orgId: b.org.id } });
    const s = await m.auth.resolveSession(a.token);
    assert.equal(s?.org, null);
    assert.equal((await m.prisma.session.findUniqueOrThrow({ where: { id: sa.sessionId } })).orgId, null);
  });

  it("switches between organizations the user belongs to", async () => {
    const a = await signUp("First Org");
    const second = await m.auth.createOrganization(a.user.id, "Second Org");
    const s = (await m.auth.resolveSession(a.token))!;
    await m.auth.switchOrganization(s.sessionId, a.user.id, second.id);
    assert.equal((await m.auth.resolveSession(a.token))?.org?.name, "Second Org");
    assert.deepEqual((await m.auth.organizationsOf(a.user.id)).map((o) => o.name), ["First Org", "Second Org"]);
  });
});

describe("invitations", () => {
  it("emails a link, and joins the organization with the invited role", async () => {
    const owner = await signUp("Invites Inc");
    const email = `${uniq()}@example.com`;
    const { token } = await m.auth.inviteMember({ orgId: owner.org.id, email: email.toUpperCase(), role: "admin", invitedBy: "Test Person" });
    const mail = m.email.outbox.at(-1)!;
    assert.equal(mail.to, email);
    assert.ok(mail.text.includes(`/invite/${token}`));
    assert.equal((await m.auth.findInvite(token))?.org.name, "Invites Inc");

    const joined = await m.auth.signUpWithInvite({ token, name: "New Admin", password: PASSWORD });
    assert.equal(joined.orgId, owner.org.id);
    const s = await m.auth.resolveSession(joined.token);
    assert.equal(s?.role, "admin");
    assert.ok(s?.user.emailVerifiedAt, "following the link proves the address");
    assert.equal(await m.auth.findInvite(token), null, "a link works once");
  });

  it("only the invited address can accept, and old links expire", async () => {
    const owner = await signUp();
    const other = await signUp();
    const { token } = await m.auth.inviteMember({ orgId: owner.org.id, email: `${uniq()}@example.com`, role: "member", invitedBy: "x" });
    await expectStatus(m.auth.acceptInvite(token, other.user.id), 403, /was sent to/);
    await m.prisma.invite.updateMany({ where: { orgId: owner.org.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal(await m.auth.findInvite(token), null);
  });

  it("counts pending invitations against the plan's member limit", async () => {
    const owner = await signUp(); // Free: 3 members
    await m.auth.inviteMember({ orgId: owner.org.id, email: `${uniq()}@example.com`, role: "member", invitedBy: "x" });
    await m.auth.inviteMember({ orgId: owner.org.id, email: `${uniq()}@example.com`, role: "member", invitedBy: "x" });
    await expectStatus(m.auth.inviteMember({ orgId: owner.org.id, email: `${uniq()}@example.com`, role: "member", invitedBy: "x" }), 402, /3 members/);
  });
});

describe("password reset", () => {
  it("sends nothing for unknown addresses, and resets once for known ones", async () => {
    const before = m.email.outbox.length;
    await m.auth.requestPasswordReset(`${uniq()}@example.com`);
    assert.equal(m.email.outbox.length, before);

    const { email, token: session } = await signUp();
    await m.auth.requestPasswordReset(email);
    const link = m.email.outbox.at(-1)!.text.match(/reset-password\/([\w-]+)/)![1];
    await expectStatus(m.auth.resetPassword(link, "short"), 400);
    await m.auth.resetPassword(link, "a brand new passphrase");
    assert.equal(await m.auth.resolveSession(session), null, "existing sessions end");
    await expectStatus(m.auth.signIn({ email, password: PASSWORD }), 401);
    assert.ok(await m.auth.signIn({ email, password: "a brand new passphrase" }));
    await expectStatus(m.auth.resetPassword(link, "yet another passphrase"), 400, /no longer valid/);
  });
});

describe("the public demo", () => {
  it("is a short, read-only visit to the demo organization", async () => {
    await expectStatus(m.auth.startDemoSession(), 404);
    const demo = await m.prisma.organization.create({ data: { name: "Demo Corp", isDemo: true } });
    const { token, expiresAt } = await m.auth.startDemoSession();
    const s = await m.auth.resolveSession(token);
    assert.equal(s?.org?.id, demo.id);
    assert.equal(s?.role, "viewer");
    assert.ok(expiresAt.getTime() - Date.now() <= 4 * 3_600_000 + 1000);
    const { can } = await import("../src/lib/auth-permissions");
    for (const perm of ["analysis:run", "account:manage", "ai:use", "recommendation:act", "org:manage", "billing:manage", "org:delete"] as const) assert.equal(can("viewer", perm), false, perm);
    await expectStatus(m.auth.inviteMember({ orgId: demo.id, email: "x@example.com", role: "member", invitedBy: "x" }), 403);
    await expectStatus(m.lifecycle.requestOrganizationDeletion(demo.id, "Demo Corp", "x"), 403);
    await m.prisma.organization.delete({ where: { id: demo.id } });
  });
});

describe("per-tenant encryption", () => {
  it("encrypts with the organization's own key, which never decrypts another's secrets", async () => {
    const a = await signUp();
    const b = await signUp();
    const secret = { clientSecret: "s3cr3t-value" };
    const blob = await m.crypto.encryptForOrg(a.org.id, secret);
    assert.ok(blob.startsWith(`v2.${a.org.id}.`) && !blob.includes("s3cr3t"));
    assert.deepEqual(await m.crypto.decryptForOrg(a.org.id, blob), secret);
    await assert.rejects(m.crypto.decryptForOrg(b.org.id, blob), /another organization/);
    // Swapping the owner id in the blob does not help: the id is authenticated.
    await assert.rejects(m.crypto.decryptForOrg(b.org.id, blob.replace(a.org.id, b.org.id)));
    // The data key is stored wrapped by the master key, never in the clear.
    const stored = await m.prisma.organization.findUniqueOrThrow({ where: { id: a.org.id } });
    assert.ok(stored.dataKey?.startsWith("v1."));
    // Credentials stored before per-tenant keys existed still decrypt.
    assert.deepEqual(await m.crypto.decryptForOrg(a.org.id, m.legacy.encryptJson(secret)), secret);
  });

  it("rotates the master key by re-wrapping data keys, and moves legacy credentials to the organization's key", async () => {
    const { org } = await signUp();
    const current = process.env.ENCRYPTION_KEY;
    const next = randomBytes(32).toString("hex");
    const account = (name: string, credentials: string) =>
      m.prisma.cloudAccount.create({ data: { orgId: org.id, provider: "azure", name, externalId: uniq(), region: "eastus", authType: "service_principal", credentials } });
    const modernBlob = await m.crypto.encryptForOrg(org.id, { clientSecret: "modern" });
    const modern = await account("Modern", modernBlob);
    const legacy = await account("Legacy", m.legacy.encryptJson({ clientSecret: "legacy" }));

    const r = await m.crypto.rotateMasterKey(current, next);
    assert.ok(r.rewrapped >= 1);
    assert.equal(r.credentialsUpgraded, 1);
    const reread = (id: string) => m.prisma.cloudAccount.findUniqueOrThrow({ where: { id } }).then((a) => a.credentials!);
    assert.equal(await reread(modern.id), modernBlob, "credentials under a data key are not re-encrypted");
    const upgraded = await reread(legacy.id);
    assert.ok(upgraded.startsWith(`v2.${org.id}.`));
    // The old master key no longer opens the organization's data key.
    await assert.rejects(m.crypto.decryptForOrg(org.id, modernBlob));
    process.env.ENCRYPTION_KEY = next;
    try {
      m.crypto.forgetOrgKey();
      assert.deepEqual(await m.crypto.decryptForOrg(org.id, modernBlob), { clientSecret: "modern" });
      assert.deepEqual(await m.crypto.decryptForOrg(org.id, upgraded), { clientSecret: "legacy" });
      // A second run (e.g. after an interruption) finds nothing left to do.
      const again = await m.crypto.rotateMasterKey(current, next);
      assert.equal(again.rewrapped + again.credentialsUpgraded, 0);
      assert.ok(again.alreadyCurrent >= 1);
    } finally {
      // Put every organization back on the original key for the tests that follow.
      await m.crypto.rotateMasterKey(next, current);
      if (current === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = current;
      m.crypto.forgetOrgKey();
    }
    assert.deepEqual(await m.crypto.decryptForOrg(org.id, modernBlob), { clientSecret: "modern" });
  });
});

describe("background jobs", () => {
  it("does not queue the same work twice", async () => {
    const { org } = await signUp();
    const a = await m.queue.enqueue(org.id, "analyze", {});
    const b = await m.queue.enqueue(org.id, "analyze", {});
    assert.equal(a.id, b.id);
    const c = await m.queue.enqueue(org.id, "sync_account", { accountId: "x" });
    assert.notEqual(c.id, a.id);
    await m.prisma.job.deleteMany({ where: { orgId: org.id } });
  });

  it("runs one job per organization at a time, in order, without starving others", async () => {
    await m.prisma.job.deleteMany({});
    const one = await signUp();
    const two = await signUp();
    const first = await m.queue.enqueue(one.org.id, "sync_account", { accountId: "a" });
    const second = await m.queue.enqueue(one.org.id, "analyze", {});
    const other = await m.queue.enqueue(two.org.id, "analyze", {});
    const c1 = await m.worker.claimNext("w1");
    const c2 = await m.worker.claimNext("w2");
    assert.equal(c1?.id, first.id);
    assert.equal(c2?.id, other.id, "the second organization is not blocked by the first");
    assert.equal(await m.worker.claimNext("w3"), null, "the first organization's next job waits for its running one");
    await m.prisma.job.update({ where: { id: first.id }, data: { status: "succeeded" } });
    assert.equal((await m.worker.claimNext("w3"))?.id, second.id);
    await m.prisma.job.deleteMany({});
  });

  it("retries with backoff, then fails; recovers jobs from a crashed worker", async () => {
    await m.prisma.job.deleteMany({});
    const { org } = await signUp();
    const job = await m.prisma.job.create({ data: { orgId: org.id, type: "unknown_type", maxAttempts: 2 } });
    assert.equal(await m.worker.workOnce("w"), true);
    let row = await m.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(row.status, "queued");
    assert.ok(row.runAt > new Date(), "retried later, not immediately");
    assert.match(row.error ?? "", /Unknown job type/);
    await m.prisma.job.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 1) } });
    await m.worker.workOnce("w");
    row = await m.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 2);

    const stuck = await m.prisma.job.create({ data: { orgId: org.id, type: "analyze", status: "running", attempts: 1, lockedAt: new Date(Date.now() - 60 * 60_000) } });
    assert.equal(await m.worker.recoverStale(), 1);
    assert.equal((await m.prisma.job.findUniqueOrThrow({ where: { id: stuck.id } })).status, "queued");
    await m.prisma.job.deleteMany({});
  });

  it("syncs, analyses and notifies — the whole first run of a new customer", async () => {
    await m.prisma.job.deleteMany({});
    const { org, email } = await signUp("Sample Co");
    const spec = m.demo.DEMO_ACCOUNTS[0];
    const account = await m.prisma.cloudAccount.create({ data: { orgId: org.id, provider: spec.provider, name: spec.name, externalId: spec.externalId, region: spec.region, authType: spec.authType, isDemo: true } });
    await m.queue.enqueue(org.id, "sync_account", { accountId: account.id });
    await m.queue.enqueue(org.id, "analyze", {});
    const mails = m.email.outbox.length;
    while (await m.worker.workOnce("w")) {
      /* drain */
    }
    const jobs = await m.prisma.job.findMany({ where: { orgId: org.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(jobs.map((j) => [j.type, j.status]), [["sync_account", "succeeded"], ["analyze", "succeeded"]]);
    assert.ok((await m.prisma.resource.count({ where: { accountId: account.id } })) > 20);
    assert.ok((await m.prisma.recommendation.count({ where: { orgId: org.id } })) > 5);
    assert.ok((await m.prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).onboardedAt);
    const note = m.email.outbox.slice(mails).find((e) => e.to === email);
    assert.match(note?.subject ?? "", /new high-impact saving/);
  });

  it("schedules the daily sync at each organization's own hour", async () => {
    await m.prisma.job.deleteMany({});
    assert.equal(m.scheduler.nextRunAt(3, new Date("2026-10-01T02:30:00Z")).toISOString(), "2026-10-01T03:00:00.000Z");
    assert.equal(m.scheduler.nextRunAt(3, new Date("2026-10-01T03:00:00Z")).toISOString(), "2026-10-02T03:00:00.000Z");
    const { org } = await signUp();
    await m.prisma.cloudAccount.create({ data: { orgId: org.id, provider: "aws", name: "a", externalId: "1", region: "us-east-1", authType: "iam_role", status: "connected" } });
    await m.prisma.organization.updateMany({ where: { id: { not: org.id } }, data: { nextSyncAt: new Date(Date.now() + 86_400_000) } });
    // First sighting: only sets the schedule.
    await m.scheduler.scheduleDueSyncs();
    assert.equal(await m.prisma.job.count({ where: { orgId: org.id } }), 0);
    // Due: one sync per account, then one analysis.
    await m.prisma.organization.update({ where: { id: org.id }, data: { nextSyncAt: new Date(Date.now() - 1000) } });
    await m.scheduler.scheduleDueSyncs();
    assert.deepEqual((await m.prisma.job.findMany({ where: { orgId: org.id }, orderBy: { createdAt: "asc" } })).map((j) => j.type), ["sync_account", "analyze"]);
    const next = (await m.prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).nextSyncAt!;
    assert.equal(next.getUTCHours(), 3);
    await m.prisma.job.deleteMany({});
  });
});

describe("plans and limits", () => {
  it("enforces cloud accounts and AI requests per plan; sample data is free", async () => {
    const { org } = await signUp();
    const add = (isDemo: boolean) => m.prisma.cloudAccount.create({ data: { orgId: org.id, provider: "aws", name: "a", externalId: uniq(), region: "us-east-1", authType: "iam_role", isDemo } });
    await add(true);
    await add(true);
    await m.limits.assertCanAddAccount(org.id);
    await add(false);
    await expectStatus(m.limits.assertCanAddAccount(org.id), 402, /1 cloud account/);

    for (let i = 0; i < 20; i++) await m.limits.consume(org.id, "ai_calls");
    await expectStatus(m.limits.consume(org.id, "ai_calls"), 402, /20 AI requests/);
    await m.prisma.organization.update({ where: { id: org.id }, data: { plan: "pro" } });
    await m.limits.assertCanAddAccount(org.id);
    await m.limits.consume(org.id, "ai_calls");
    // A lapsed subscription falls back to Free limits.
    await m.prisma.organization.update({ where: { id: org.id }, data: { planStatus: "past_due" } });
    await expectStatus(m.limits.assertCanAddAccount(org.id), 402);
    const u = await m.limits.usage(org.id);
    assert.equal(u.plan.id, "free");
    assert.equal(u.meters.find((x) => x.id === "cloudAccounts")?.used, 1);
  });
});

describe("organization settings", () => {
  it("fills in defaults, merges one section at a time, and validates", () => {
    const d = m.settings.parseSettings(null);
    assert.equal(d.remediation.mode, "branch");
    assert.equal(d.backups.retentionDays, 365);
    assert.equal(d.sync.hourUtc, 3);
    const next = m.settings.mergeSettings(d, { backups: { retentionDays: null }, sync: { hourUtc: 22 } });
    assert.equal(next.backups.retentionDays, null);
    assert.equal(next.sync.hourUtc, 22);
    assert.equal(next.sync.enabled, true, "untouched fields keep their value");
    assert.throws(() => m.settings.mergeSettings(d, { remediation: { branchPrefix: "bad prefix; rm -rf" } }));
    assert.throws(() => m.settings.mergeSettings(d, { backups: { retentionDays: 5 } }));
    assert.equal(m.settings.parseSettings("{not json").remediation.mode, "branch");
  });

  it("puts the backup retention into recommendations that delete storage", async () => {
    const { org } = await signUp();
    const account = await m.prisma.cloudAccount.create({ data: { orgId: org.id, provider: "aws", name: "a", externalId: uniq(), region: "us-east-1", authType: "iam_role", status: "connected" } });
    await m.prisma.resource.create({ data: { accountId: account.id, provider: "aws", externalId: "vol-1", name: "old-volumes", kind: "storage.block", service: "EBS", region: "us-east-1", quantity: 4, monthlyCost: 200, config: JSON.stringify({ sizeGb: 500, volumeType: "gp2", attached: false }) } });
    await m.prisma.organization.update({ where: { id: org.id }, data: { settings: JSON.stringify({ backups: { retentionDays: 2555 } }) } });
    const { runAnalysis } = await import("../src/lib/services/analysis");
    await runAnalysis(org.id);
    const rec = await m.prisma.recommendation.findFirstOrThrow({ where: { orgId: org.id, detector: "idle.volume" } });
    assert.match(rec.details, /kept for 7 years/);
    assert.ok(rec.projectedMonthlyCost > 0, "the backup is paid for, so savings are net of it");
  });
});

describe("billing", () => {
  it("encodes Stripe's nested form parameters", () => {
    assert.equal(m.stripe.formEncode({ mode: "subscription", line_items: [{ price: "price_1", quantity: 1 }], metadata: { orgId: "o 1" } }), "mode=subscription&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5BorgId%5D=o%201");
  });

  it("accepts only correctly signed, recent webhooks", async () => {
    const { createHmac } = await import("node:crypto");
    const payload = JSON.stringify({ type: "x" });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", "whsec_test").update(`${t}.${payload}`).digest("hex");
    assert.equal(m.stripe.verifyWebhook(payload, `t=${t},v1=${sig}`, "whsec_test"), true);
    assert.equal(m.stripe.verifyWebhook(payload, `t=${t},v1=${sig}`, "whsec_other"), false);
    assert.equal(m.stripe.verifyWebhook(payload + " ", `t=${t},v1=${sig}`, "whsec_test"), false);
    assert.equal(m.stripe.verifyWebhook(payload, `t=${t},v1=${sig}`, "whsec_test", 300, (t + 3600) * 1000), false, "replayed an hour later");
    assert.equal(m.stripe.verifyWebhook(payload, null, "whsec_test"), false);
  });

  it("keeps the plan in step with the subscription", async () => {
    const { org } = await signUp();
    await m.stripe.applyStripeEvent({ type: "checkout.session.completed", data: { object: { id: "cs_1", customer: "cus_1", subscription: "sub_1", client_reference_id: org.id } } });
    let o = await m.prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    assert.deepEqual([o.plan, o.planStatus, o.stripeCustomerId, o.stripeSubscriptionId], ["pro", "active", "cus_1", "sub_1"]);
    await m.stripe.applyStripeEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "past_due" } } });
    o = await m.prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    assert.equal(o.planStatus, "past_due");
    await m.stripe.applyStripeEvent({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1" } } });
    o = await m.prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    assert.deepEqual([o.plan, o.planStatus, o.stripeSubscriptionId], ["free", "canceled", null]);
    assert.deepEqual(await m.stripe.applyStripeEvent({ type: "customer.subscription.deleted", data: { object: { id: "sub_x", customer: "cus_unknown" } } }), { ignored: "no matching organization" });
  });
});

describe("leaving the platform", () => {
  it("exports everything except credentials, then deletes the organization and its key", async () => {
    await m.prisma.job.deleteMany({});
    const owner = await signUp("Leaving Ltd");
    const member = await signUp("Their Own Org");
    await m.prisma.membership.create({ data: { userId: member.user.id, orgId: owner.org.id, role: "member" } });
    const account = await m.prisma.cloudAccount.create({
      data: { orgId: owner.org.id, provider: "azure", name: "Sub", externalId: uniq(), region: "eastus", authType: "service_principal", credentials: await m.crypto.encryptForOrg(owner.org.id, { clientSecret: "top-secret" }) },
    });
    await m.prisma.resource.create({ data: { accountId: account.id, provider: "azure", externalId: "vm-1", name: "vm", kind: "compute.vm", service: "VM", region: "eastus", monthlyCost: 100 } });

    const data = await m.lifecycle.exportOrganization(owner.org.id);
    assert.equal(data.accounts.length, 1);
    assert.equal(data.resources.length, 1);
    assert.equal(data.members.length, 2);
    assert.ok(!JSON.stringify(data).includes("top-secret") && !JSON.stringify(data).includes("credentials\":\"v"), "credentials never leave");

    await expectStatus(m.lifecycle.requestOrganizationDeletion(owner.org.id, "leaving ltd", "x"), 400, /exactly/);
    await m.lifecycle.requestOrganizationDeletion(owner.org.id, "Leaving Ltd", "Test Person");
    // Immediately: inaccessible, sessions dropped, credentials wiped.
    assert.equal((await m.auth.resolveSession(owner.token))?.org, null);
    assert.equal((await m.prisma.cloudAccount.findUniqueOrThrow({ where: { id: account.id } })).credentials, null);
    // The job removes the data; people keep their logins and other organizations.
    while (await m.worker.workOnce("w")) {
      /* drain */
    }
    assert.equal(await m.prisma.organization.count({ where: { id: owner.org.id } }), 0);
    assert.equal(await m.prisma.resource.count({ where: { accountId: account.id } }), 0);
    assert.equal(await m.prisma.user.count({ where: { id: { in: [owner.user.id, member.user.id] } } }), 2);
    assert.deepEqual((await m.auth.organizationsOf(member.user.id)).map((o) => o.name), ["Their Own Org"]);
  });

  it("refuses to delete while a subscription is active", async () => {
    const { org } = await signUp("Paying Co");
    await m.prisma.organization.update({ where: { id: org.id }, data: { stripeSubscriptionId: "sub_live", planStatus: "active" } });
    await expectStatus(m.lifecycle.requestOrganizationDeletion(org.id, "Paying Co", "x"), 409, /Cancel the subscription/);
  });
});
