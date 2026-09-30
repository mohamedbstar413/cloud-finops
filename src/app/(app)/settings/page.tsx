import { PageHeader } from "@/components/ui";
import { can, pageSession } from "@/lib/auth";
import { parseSettings } from "@/lib/settings";
import { GeneralSettings } from "./forms";
import { SettingsNav } from "./nav";

export default async function SettingsPage() {
  const { org, role } = await pageSession();
  const settings = parseSettings(org.settings);
  return (
    <>
      <PageHeader title="Settings" subtitle={`Settings for ${org.name}`} />
      <SettingsNav />
      <GeneralSettings name={org.name} sync={settings.sync} canEdit={can(role, "org:manage") && !org.isDemo} nextSyncAt={org.nextSyncAt?.toISOString() ?? null} />
    </>
  );
}
