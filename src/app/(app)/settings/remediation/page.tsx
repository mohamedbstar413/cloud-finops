import { PageHeader } from "@/components/ui";
import { can, pageSession } from "@/lib/auth";
import { CHANGE_TYPES, LOW_RISK_CHANGES, parseSettings } from "@/lib/settings";
import { RemediationSettings } from "../forms";
import { SettingsNav } from "../nav";

export default async function RemediationSettingsPage() {
  const { org, role } = await pageSession();
  const s = parseSettings(org.settings);
  return (
    <>
      <PageHeader title="Settings" subtitle="How approved changes reach your infrastructure, and what is kept when something is deleted" />
      <SettingsNav />
      <RemediationSettings settings={{ remediation: s.remediation, backups: s.backups, git: s.git }} changeTypes={CHANGE_TYPES} lowRisk={LOW_RISK_CHANGES} canEdit={can(role, "org:manage") && !org.isDemo} />
    </>
  );
}
