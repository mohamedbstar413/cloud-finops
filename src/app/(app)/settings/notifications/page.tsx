import { PageHeader } from "@/components/ui";
import { can, pageSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseSettings } from "@/lib/settings";
import { NotificationSettings } from "../forms";
import { SettingsNav } from "../nav";

export default async function NotificationSettingsPage() {
  const { org, role } = await pageSession();
  const admins = await prisma.membership.findMany({ where: { orgId: org.id, role: { in: ["owner", "admin"] } }, include: { user: { select: { email: true } } } });
  return (
    <>
      <PageHeader title="Settings" subtitle="Who hears about new savings and failed syncs" />
      <SettingsNav />
      <NotificationSettings notifications={parseSettings(org.settings).notifications} admins={admins.map((a) => a.user.email)} canEdit={can(role, "org:manage") && !org.isDemo} />
    </>
  );
}
