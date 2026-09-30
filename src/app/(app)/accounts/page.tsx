import { Info, TriangleAlert } from "lucide-react";
import { Fragment } from "react";
import { ProviderLogo } from "@/components/ProviderLogo";
import { Card, PageHeader, Pill } from "@/components/ui";
import { can, getSession } from "@/lib/auth";
import { DEMO_ACCOUNTS } from "@/lib/demo/estate";
import { timeAgo, usd } from "@/lib/format";
import type { Provider } from "@/lib/pricing/catalog";
import { listAccounts } from "@/lib/services/queries";
import { AccountRowActions, AddAccountButton } from "./actions";

const TITLES: Record<Provider, string> = { aws: "AWS", azure: "Azure", gcp: "Google Cloud" };
const ID_LABEL: Record<Provider, string> = { aws: "Account ID", azure: "Subscription ID", gcp: "Project ID" };

export default async function AccountsPage() {
  const { org, role } = await getSession();
  const accounts = await listAccounts(org.id);
  const manage = can(role, "account:manage");
  const sync = can(role, "analysis:run");
  const connectedDemo = new Set(accounts.filter((a) => a.isDemo).map((a) => a.externalId));
  const demoOptions = DEMO_ACCOUNTS.filter((d) => !connectedDemo.has(d.externalId)).map((d) => ({ key: d.key, label: `${d.provider.toUpperCase()} ${d.name}` }));

  return (
    <>
      <PageHeader
        title={
          <>
            <span className="block text-[13px] font-medium text-muted">Accounts</span>
            Connected Cloud Accounts
          </>
        }
        subtitle="Manage your cloud provider connections"
        actions={manage && <AddAccountButton demoOptions={demoOptions} />}
      />

      <div className="space-y-4">
        {(["aws", "azure", "gcp"] as Provider[]).map((p) => {
          const list = accounts.filter((a) => a.provider === p);
          const healthy = list.every((a) => a.status === "connected");
          return (
            <Card key={p}>
              <div className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-lg bg-slate-50 ring-1 ring-line">
                    <ProviderLogo provider={p} size={22} />
                  </span>
                  <div>
                    <p className="text-[14px] font-semibold">{TITLES[p]}</p>
                    <p className="text-xs text-muted">
                      {list.length} account{list.length === 1 ? "" : "s"} connected
                    </p>
                  </div>
                </div>
                {list.length > 0 && (
                  <Pill className={healthy ? "bg-green-50 text-green-700 ring-green-200" : "bg-red-50 text-red-700 ring-red-200"}>{healthy ? "✓ Connected" : "Needs attention"}</Pill>
                )}
              </div>
              {list.length ? (
                <div>
                  <table className="w-full text-[13px]">
                    <thead className="whitespace-nowrap border-y border-line bg-slate-50 text-left text-[11px] text-muted">
                      <tr>
                        <th className="px-5 py-2 font-medium">Account Name</th>
                        <th className="px-3 py-2 font-medium">{ID_LABEL[p]}</th>
                        <th className="px-3 py-2 font-medium">Region</th>
                        <th className="px-3 py-2 font-medium">Permissions</th>
                        <th className="px-3 py-2 font-medium">Resources</th>
                        <th className="px-3 py-2 font-medium" title="Resources whose optimization depends on usage data, and how many of them have usage history">
                          Usage history
                        </th>
                        <th className="px-3 py-2 font-medium">30-day cost</th>
                        <th className="px-3 py-2 font-medium">Last sync</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-5 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((a) => (
                        <Fragment key={a.id}>
                          <tr className={a.warnings.length ? undefined : "border-b border-line last:border-0"}>
                            <td className="px-5 py-3 font-medium">
                              {a.name}
                              {a.isDemo && <span className="ml-2 rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium text-muted">demo</span>}
                            </td>
                            <td className="tabular px-3 py-3 text-muted">{a.externalId.length > 24 ? `${a.externalId.slice(0, 22)}…` : a.externalId}</td>
                            <td className="px-3 py-3">{a.region}</td>
                            <td className="px-3 py-3">{a.permissions === "read_only" ? "Read Only" : "Read / Write"}</td>
                            <td className="tabular px-3 py-3">{a.resources}</td>
                            <td className="px-3 py-3">
                              {a.usage.measurable ? (
                                <span className="inline-flex items-center gap-2 whitespace-nowrap" title={`${a.usage.withHistory} of ${a.usage.measurable} resources that need usage data have history`}>
                                  <span className="h-1.5 w-12 overflow-hidden rounded-full bg-blue-100" aria-hidden>
                                    <span className="block h-full rounded-full bg-brand" style={{ width: `${(a.usage.withHistory / a.usage.measurable) * 100}%` }} />
                                  </span>
                                  <span className="tabular text-[12.5px]">
                                    {a.usage.withHistory} / {a.usage.measurable}
                                  </span>
                                </span>
                              ) : (
                                <span className="text-muted">—</span>
                              )}
                            </td>
                            <td className="tabular px-3 py-3">{usd(a.cost30d)}</td>
                            <td className="whitespace-nowrap px-3 py-3 text-muted">{timeAgo(a.lastSyncAt)}</td>
                            <td className="px-3 py-3">
                              {a.status === "connected" ? (
                                <Pill className="bg-green-50 text-green-700 ring-green-200">● Healthy</Pill>
                              ) : a.status === "pending" ? (
                                <Pill className="bg-amber-50 text-amber-700 ring-amber-200">● Syncing</Pill>
                              ) : (
                                <span title={a.lastError ?? ""}>
                                  <Pill className="bg-red-50 text-red-700 ring-red-200">● Error</Pill>
                                </span>
                              )}
                            </td>
                            <td className="px-5 py-3 text-right">
                              <AccountRowActions account={{ id: a.id, name: a.name, permissions: a.permissions }} canManage={manage} canSync={sync} />
                            </td>
                          </tr>
                          {a.warnings.length > 0 && (
                            <tr className="border-b border-line last:border-0">
                              <td colSpan={10} className="px-5 pb-3">
                                <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800 ring-1 ring-inset ring-amber-200">
                                  <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                                  <div>
                                    <p className="font-medium">Some usage data could not be collected in the last sync</p>
                                    <ul className="mt-0.5 list-disc pl-4">
                                      {a.warnings.map((w) => (
                                        <li key={w}>{w}</li>
                                      ))}
                                    </ul>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="border-t border-line px-5 py-4 text-[13px] text-muted">No {TITLES[p]} accounts connected yet.</p>
              )}
            </Card>
          );
        })}

        <div className="flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50/60 px-5 py-4 text-[13px] text-slate-700">
          <Info size={16} className="mt-0.5 shrink-0 text-brand" />
          <p>
            All connections are <b>read-only by default</b> (billing, inventory and metrics). Each sync collects six weeks of hourly utilisation and traffic (and 90 days of daily storage figures), so recommendations are sized on how resources are actually used over time. You can enable write permissions per account later, when you&apos;re ready to apply low-risk recommendations automatically.
            Credentials are encrypted at rest with AES-256-GCM; AWS access uses a cross-account IAM role with a unique External ID.
          </p>
        </div>
      </div>
    </>
  );
}
