import { z } from "zod";
import { route } from "@/lib/api";
import { audit, getSession, HttpError, requirePermission } from "@/lib/auth";
import { encryptJson } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { DEMO_ACCOUNTS } from "@/lib/demo/estate";
import { syncAccount, validateCredentials } from "@/lib/services/ingest";
import { listAccounts } from "@/lib/services/queries";

export const maxDuration = 300;

export const GET = route(async () => {
  const { org } = await getSession();
  return { accounts: await listAccounts(org.id) };
});

const Body = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("aws"),
    name: z.string().min(1).max(80),
    accountId: z.string().regex(/^\d{12}$/, "AWS account IDs have 12 digits"),
    roleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/.+$/, "Expected arn:aws:iam::<account>:role/<name>"),
    externalId: z.string().min(8),
    region: z.string().default("us-east-1"),
  }),
  z.object({
    provider: z.literal("azure"),
    name: z.string().min(1).max(80),
    tenantId: z.string().uuid(),
    clientId: z.string().uuid(),
    clientSecret: z.string().min(8),
    subscriptionId: z.string().uuid(),
    region: z.string().default("eastus"),
  }),
  z.object({
    provider: z.literal("gcp"),
    name: z.string().min(1).max(80),
    projectId: z.string().min(4),
    serviceAccountKey: z.string().min(20),
    billingTable: z.string().optional(),
    region: z.string().default("us-central1"),
  }),
  z.object({ provider: z.literal("demo"), key: z.string() }),
]);

export const POST = route(async (req: Request) => {
  const { org, user } = await requirePermission("account:manage");
  const body = Body.parse(await req.json());

  if (body.provider === "demo") {
    const spec = DEMO_ACCOUNTS.find((a) => a.key === body.key);
    if (!spec) throw new HttpError(400, "Unknown demo account");
    const exists = await prisma.cloudAccount.findFirst({ where: { orgId: org.id, externalId: spec.externalId } });
    if (exists) throw new HttpError(409, "This demo account is already connected");
    const account = await prisma.cloudAccount.create({
      data: { orgId: org.id, provider: spec.provider, name: spec.name, externalId: spec.externalId, region: spec.region, authType: spec.authType, isDemo: true, status: "pending" },
    });
    const sync = await syncAccount(account.id);
    await audit(org.id, user.name, "connected account", `${spec.provider.toUpperCase()} ${spec.name} (demo)`);
    return { account: { id: account.id }, sync };
  }

  const { name, region } = body;
  let externalId: string;
  let creds: unknown;
  let authType: string;
  if (body.provider === "aws") {
    externalId = body.accountId;
    creds = { roleArn: body.roleArn, externalId: body.externalId, regions: [region] };
    authType = "iam_role";
  } else if (body.provider === "azure") {
    externalId = body.subscriptionId;
    creds = { tenantId: body.tenantId, clientId: body.clientId, clientSecret: body.clientSecret, subscriptionId: body.subscriptionId };
    authType = "service_principal";
  } else {
    try {
      JSON.parse(body.serviceAccountKey);
    } catch {
      throw new HttpError(400, "Service account key must be the JSON key file contents");
    }
    externalId = body.projectId;
    creds = { projectId: body.projectId, serviceAccountKey: body.serviceAccountKey, billingTable: body.billingTable };
    authType = "service_account";
  }

  const check = await validateCredentials(body.provider, creds);
  if (!check.ok) throw new HttpError(422, `Connection test failed: ${check.message}`);

  const account = await prisma.cloudAccount.create({
    data: { orgId: org.id, provider: body.provider, name, externalId, region, authType, credentials: encryptJson(creds), status: "pending" },
  });
  await audit(org.id, user.name, "connected account", `${body.provider.toUpperCase()} ${name}`);
  const sync = await syncAccount(account.id);
  return { account: { id: account.id }, identity: check.identity, sync };
});
