import { route } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { awsRoleTemplate } from "@/lib/connectors/aws";
import { azureSetupScript } from "@/lib/connectors/azure";
import { gcpSetupScript } from "@/lib/connectors/gcp";
import { newExternalId } from "@/lib/crypto";

/** Onboarding material: a fresh External ID + least-privilege templates per provider. */
export const GET = route(async (req: Request) => {
  const { org } = await requirePermission("account:manage");
  const url = new URL(req.url);
  const externalId = newExternalId(org.id);
  const platformAccount = process.env.PLATFORM_AWS_ACCOUNT_ID ?? "000000000000";
  return {
    aws: { externalId, platformAccount, template: JSON.stringify(awsRoleTemplate(platformAccount, externalId), null, 2) },
    azure: { script: azureSetupScript(url.searchParams.get("subscriptionId") ?? "") },
    gcp: { script: gcpSetupScript(url.searchParams.get("projectId") ?? "") },
  };
});
