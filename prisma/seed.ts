import { PrismaClient } from "@prisma/client";
import { DEMO_ACCOUNTS } from "../src/lib/demo/estate";
import { demoSnapshot } from "../src/lib/connectors/demo";
import { persistSnapshot } from "../src/lib/services/ingest";
import { runAnalysis } from "../src/lib/services/analysis";
import { hashPassword } from "../src/lib/security/password";

const prisma = new PrismaClient();

/**
 * Seeds (or refreshes) the shared demo organization that visitors explore
 * read-only from the sign-in page. Customer organizations are never touched.
 * The seeded Acme users can sign in with SEED_PASSWORD (see .env).
 */
async function main() {
  console.log("Resetting the demo organization…");
  await prisma.organization.deleteMany({ where: { isDemo: true } });
  const emails = ["mohamed@acme.com", "sara@acme.com", "diego@acme.com", "priya@acme.com", "finance@acme.com"];
  await prisma.user.deleteMany({ where: { email: { in: emails } } });

  const password = process.env.SEED_PASSWORD;
  const passwordHash = password ? await hashPassword(password) : null;
  const org = await prisma.organization.create({ data: { name: "Acme Corp", plan: "enterprise", isDemo: true, onboardedAt: new Date() } });
  const people = [
    { name: "Mohamed Abdelsattar", email: "mohamed@acme.com", role: "owner" },
    { name: "Sara Kim", email: "sara@acme.com", role: "admin" },
    { name: "Diego Alvarez", email: "diego@acme.com", role: "member" },
    { name: "Priya Nair", email: "priya@acme.com", role: "member" },
    { name: "Finance Viewer", email: "finance@acme.com", role: "viewer" },
  ];
  for (const p of people) {
    const u = await prisma.user.create({ data: { name: p.name, email: p.email, passwordHash } });
    await prisma.membership.create({ data: { userId: u.id, orgId: org.id, role: p.role } });
  }
  if (!passwordHash) console.log("  SEED_PASSWORD is not set: the Acme users cannot sign in (the read-only demo still works).");

  for (const spec of DEMO_ACCOUNTS) {
    const account = await prisma.cloudAccount.create({
      data: {
        orgId: org.id,
        provider: spec.provider,
        name: spec.name,
        externalId: spec.externalId,
        region: spec.region,
        status: "connected",
        permissions: "read_only",
        authType: spec.authType,
        isDemo: true,
        lastSyncAt: new Date(),
      },
    });
    const stats = await persistSnapshot(account.id, spec.provider, demoSnapshot(spec.key, spec.externalId));
    console.log(`  ${spec.provider.toUpperCase()} ${spec.name}: ${stats.resources} resources, ${stats.costRows} cost rows, ${stats.series} usage series`);
  }

  const result = await runAnalysis(org.id);
  console.log(`Analysis: ${result.recommendations} recommendations (${result.architecture} architecture), $${Math.round(result.monthlySavings).toLocaleString()}/mo potential savings`);
  console.log(`Usage history for ${result.coverage.withHistory} of ${result.coverage.measurable} measurable resources; ${result.heldBack} held back instead of guessed`);

  await prisma.auditLog.createMany({
    data: [
      { orgId: org.id, actor: "Mohamed Abdelsattar", action: "connected account", target: "AWS Production" },
      { orgId: org.id, actor: "Sara Kim", action: "connected account", target: "Azure Main Subscription" },
      { orgId: org.id, actor: "Sara Kim", action: "connected account", target: "GCP Production Project" },
      { orgId: org.id, actor: "System", action: "completed analysis", target: `${result.recommendations} recommendations` },
    ],
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
