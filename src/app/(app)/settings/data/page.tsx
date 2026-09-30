import { PageHeader } from "@/components/ui";
import { can, pageSession } from "@/lib/auth";
import { DataPanel } from "../forms";
import { SettingsNav } from "../nav";

export default async function DataSettingsPage() {
  const { org, role } = await pageSession();
  return (
    <>
      <PageHeader title="Settings" subtitle="Encryption, export and deletion" />
      <SettingsNav />
      <DataPanel orgName={org.name} canDelete={can(role, "org:delete") && !org.isDemo} isDemo={org.isDemo} hasSubscription={Boolean(org.stripeSubscriptionId && org.planStatus !== "canceled")} />
    </>
  );
}
