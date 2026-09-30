import { Check, Minus } from "lucide-react";
import { Card, CardHeader, PageHeader, Pill } from "@/components/ui";
import { can, pageSession, PERMISSIONS, ROLES } from "@/lib/auth";
import { timeAgo } from "@/lib/format";
import { getOrganization } from "@/lib/services/queries";
import { InviteForm, MemberRoleSelect, RemoveInvite } from "./members";

const PERM_LABEL: Record<string, string> = {
  "recommendation:act": "Apply, dismiss, snooze & ticket recommendations",
  "analysis:run": "Run analysis & sync accounts",
  "ai:use": "Use the AI advisor (what-if, deep-dives, discovery)",
  "account:manage": "Connect & manage cloud accounts",
  "org:manage": "Manage members, roles & organization settings",
  "billing:manage": "Change plan & billing",
  "org:delete": "Export or delete the organization",
};

export default async function OrganizationPage() {
  const { org, user, role } = await pageSession();
  const o = await getOrganization(org.id);
  const manage = can(role, "org:manage");

  return (
    <>
      <PageHeader title="Organization" subtitle={`${o.name} · ${o.plan} plan · ${o.members.length} members · ${o.stats.accounts} cloud accounts`} />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Members" subtitle="Role-based access control" />
          <table className="mt-3 w-full text-[13px]">
            <thead className="border-y border-line bg-slate-50 text-left text-[11px] text-muted">
              <tr>
                <th className="px-5 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-5 py-2 font-medium">Member since</th>
              </tr>
            </thead>
            <tbody>
              {o.members.map((m) => (
                <tr key={m.id} className="border-b border-line last:border-0">
                  <td className="px-5 py-2.5 font-medium">
                    {m.name} {m.userId === user.id && <span className="ml-1 text-xs font-normal text-muted">(you)</span>}
                  </td>
                  <td className="px-3 py-2.5 text-muted">{m.email}</td>
                  <td className="px-3 py-2.5">{manage && m.userId !== user.id ? <MemberRoleSelect id={m.id} role={m.role} /> : <span className="capitalize">{m.role}</span>}</td>
                  <td className="px-5 py-2.5 text-muted">{new Date(m.since).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {o.invites.length > 0 && (
            <div className="border-t border-line px-5 py-3">
              <p className="text-xs font-semibold text-muted">Pending invites</p>
              <ul className="mt-2 space-y-1 text-[13px]">
                {o.invites.map((i) => (
                  <li key={i.id} className="flex items-center justify-between">
                    <span>
                      {i.email} <Pill className="ml-2 bg-slate-100 capitalize text-slate-600 ring-slate-200">{i.role}</Pill>
                      {i.expired && <Pill className="ml-1 bg-amber-50 text-amber-700 ring-amber-200">expired</Pill>}
                    </span>
                    {manage && <RemoveInvite id={i.id} />}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {manage && !org.isDemo && (
            <div className="border-t border-line px-5 py-4">
              <InviteForm canInviteOwner={role === "owner"} />
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Activity" subtitle="Audit log" />
          <ul className="mt-2 max-h-[460px] space-y-0.5 overflow-auto px-5 pb-4">
            {o.audit.map((a) => (
              <li key={a.id} className="border-b border-line py-2 text-[12.5px] last:border-0">
                <b className="font-medium">{a.actor}</b> {a.action}
                {a.target && <span className="text-muted"> · {a.target}</span>}
                <p className="text-[11px] text-muted">{timeAgo(a.createdAt)}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Roles & permissions" />
        <table className="mt-3 w-full text-[13px]">
          <thead className="border-y border-line bg-slate-50 text-left text-[11px] text-muted">
            <tr>
              <th className="px-5 py-2 font-medium">Permission</th>
              {ROLES.map((r) => (
                <th key={r} className="px-3 py-2 text-center font-medium capitalize">
                  {r}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(PERMISSIONS).map(([perm, roles]) => (
              <tr key={perm} className="border-b border-line last:border-0">
                <td className="px-5 py-2.5">{PERM_LABEL[perm] ?? perm}</td>
                {ROLES.map((r) => (
                  <td key={r} className="px-3 py-2.5 text-center">
                    {(roles as readonly string[]).includes(r) ? <Check size={15} className="mx-auto text-good" /> : <Minus size={15} className="mx-auto text-slate-300" />}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td className="px-5 py-2.5">View dashboards, costs, recommendations & scenarios</td>
              {ROLES.map((r) => (
                <td key={r} className="px-3 py-2.5 text-center">
                  <Check size={15} className="mx-auto text-good" />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}
