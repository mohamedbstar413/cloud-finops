import { SubNav } from "@/components/SubNav";

export function SettingsNav() {
  return (
    <SubNav
      items={[
        { href: "/settings", label: "General" },
        { href: "/settings/remediation", label: "Remediation & backups" },
        { href: "/settings/notifications", label: "Notifications" },
        { href: "/settings/data", label: "Data & privacy" },
        { href: "/settings/platform", label: "How it works" },
      ]}
    />
  );
}
