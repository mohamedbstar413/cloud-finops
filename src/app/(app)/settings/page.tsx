import { CircleCheck, CircleDashed } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { aiEnabled, aiModel } from "@/lib/ai/client";
import { getSession } from "@/lib/auth";
import { DAILY_DAYS, HOURLY_DAYS } from "@/lib/connectors/usage";
import { FORECAST_DAYS, MIN_HISTORY_DAYS } from "@/lib/engine/signals";
import { ENGINEER_WEEK_COST, PRICES, VM_TYPES } from "@/lib/pricing/catalog";
import { usd } from "@/lib/format";

function Row({ ok, title, children }: { ok: boolean; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-line px-5 py-3.5 last:border-0">
      {ok ? <CircleCheck size={17} className="mt-0.5 shrink-0 text-good" /> : <CircleDashed size={17} className="mt-0.5 shrink-0 text-slate-400" />}
      <div className="text-[13px]">
        <p className="font-medium">{title}</p>
        <div className="mt-0.5 text-muted">{children}</div>
      </div>
    </div>
  );
}

const DETECTORS = [
  ["Serverless modernization", "Always-on VM fleets behind load balancers with bursty, short requests → API gateway + functions + queue, priced at today's and the forecast request volume"],
  ["Cross-cloud arbitrage", "Portable workloads priced on every cloud incl. egress (data gravity), Spot buffer and migration cost; batch fleets are priced for the hours their job actually runs"],
  ["Static site → CDN", "Web servers serving static content → object storage + CDN"],
  ["NAT → gateway endpoints", "The measured share of NAT traffic that goes to object storage → free gateway endpoints"],
  ["Serverless databases", "Provisioned DBs with spiky load → capacity billed from the measured hour-of-week load curve"],
  ["PaaS → consumption containers", "Under-used App Service plans → Container Apps, replicas sized from the hour-of-week load"],
  ["Kubernetes bin-packing + Spot", "Over-requested node pools → on-demand pool sized for the peak + autoscaled Spot pool, replayed hour by hour"],
  ["Rightsizing (+Arm)", "Busiest-day CPU and memory peaks projected 90 days ahead; held back when memory is not measured or usage is growing"],
  ["Idle & orphaned", "VMs with no CPU and no network traffic, load balancers and NAT gateways that carry nothing, unattached disks, unused IPs, stale snapshots"],
  ["Storage tiering", "Lifecycle / Intelligent-Tiering net of retrieval fees, gp2 → gp3 with the IOPS the volume actually uses"],
  ["Non-prod scheduling", "Schedules derived from each fleet's own hour-of-week usage, with a one-hour buffer"],
  ["Commitments", "Savings Plans / Reservations / CUDs sized on the post-optimization baseline and the hourly floor of autoscaled fleets"],
  ["Anomaly detection", "Weekday-seasonal robust z-score (MAD) on daily service spend"],
];

export default async function SettingsPage() {
  const { org } = await getSession();
  const ai = aiEnabled();
  return (
    <>
      <PageHeader title="Settings" subtitle={`Platform configuration for ${org.name}`} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Integrations" />
          <div className="mt-2">
            <Row ok={ai} title={ai ? `OpenAI connected · ${aiModel()}` : "OpenAI not configured"}>
              Powers AI deep-dives, generative architecture discovery, what-if planning and free-text architecture analysis. Set <code>OPENAI_API_KEY</code> and optionally <code>OPENAI_MODEL</code>. The LLM only proposes; prices always come from the deterministic engine.
            </Row>
            <Row ok={Boolean(process.env.ENCRYPTION_KEY)} title="Credential encryption">
              {process.env.ENCRYPTION_KEY ? "AES-256-GCM with ENCRYPTION_KEY." : "Using a development key — set ENCRYPTION_KEY before storing real credentials."}
            </Row>
            <Row ok={Boolean(process.env.TICKET_WEBHOOK_URL)} title="Ticketing webhook">
              {process.env.TICKET_WEBHOOK_URL ? "Tickets are pushed to your webhook (Jira / Linear / ServiceNow bridge)." : "Tickets are stored internally. Set TICKET_WEBHOOK_URL to push them to your tracker."}
            </Row>
            <Row ok={Boolean(process.env.PLATFORM_AWS_ACCOUNT_ID)} title="AWS platform account">
              {process.env.PLATFORM_AWS_ACCOUNT_ID ? `Role trust policies reference ${process.env.PLATFORM_AWS_ACCOUNT_ID}.` : "Set PLATFORM_AWS_ACCOUNT_ID so generated IAM trust policies point at your platform account."}
            </Row>
          </div>
        </Card>

        <Card>
          <CardHeader title="Pricing engine" subtitle="Deterministic list-price catalog used for every estimate" />
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 px-5 pb-5 text-[13px]">
            <dt className="text-muted">VM types priced</dt>
            <dd>{VM_TYPES.length} across AWS, Azure, GCP</dd>
            <dt className="text-muted">Lambda</dt>
            <dd>${PRICES.serverlessFunction.aws.perMillionRequests}/M req · ${PRICES.serverlessFunction.aws.perGbSecond}/GB-s</dd>
            <dt className="text-muted">Internet egress</dt>
            <dd>AWS ${PRICES.egressInternet.aws} · Azure ${PRICES.egressInternet.azure} · GCP ${PRICES.egressInternet.gcp} /GB</dd>
            <dt className="text-muted">1-year commitments</dt>
            <dd>AWS {Math.round(PRICES.commitment.aws["1y"] * 100)}% · Azure {Math.round(PRICES.commitment.azure["1y"] * 100)}% · GCP {Math.round(PRICES.commitment.gcp["1y"] * 100)}%</dd>
            <dt className="text-muted">Migration cost model</dt>
            <dd>{usd(ENGINEER_WEEK_COST)} per engineer-week</dd>
            <dt className="text-muted">Spot interruption buffer</dt>
            <dd>+10% capacity</dd>
          </dl>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Usage over time" subtitle="How utilisation and traffic history turns into a recommendation — or into a reason not to make one" />
        <dl className="mt-3 grid gap-x-8 gap-y-2 px-5 pb-5 text-[13px] md:grid-cols-[220px_1fr]">
          <dt className="text-muted">History collected per sync</dt>
          <dd>
            {HOURLY_DAYS} days hourly (CPU, memory, network, requests, IOPS, instance counts) · {DAILY_DAYS} days daily (storage, transfer)
          </dd>
          <dt className="text-muted">Peak a change is sized for</dt>
          <dd>The busiest day&apos;s p95 of the hourly maximum, projected {FORECAST_DAYS} days ahead at the measured trend — a month-end peak counts, a single odd hour does not</dd>
          <dt className="text-muted">Trend</dt>
          <dd>Compared weekday with weekday and shrunk by its own uncertainty, so a weekly rhythm or day-to-day noise is not reported as growth</dd>
          <dt className="text-muted">Weekly pattern</dt>
          <dd>An hour of the week counts as idle only if it was quiet in every observed week; schedules keep a one-hour buffer</dd>
          <dt className="text-muted">Minimum history</dt>
          <dd>{MIN_HISTORY_DAYS} days before any usage-based change; with less, or with a metric missing, the resource is held back and the reason is shown on the Recommendations page</dd>
        </dl>
      </Card>

      <Card className="mt-4">
        <CardHeader title="Optimization detectors" subtitle="Run on every sync; results are reconciled by fingerprint so your decisions persist" />
        <div className="mt-3 grid gap-x-8 px-5 pb-5 md:grid-cols-2">
          {DETECTORS.map(([name, desc]) => (
            <div key={name} className="border-b border-line py-2.5 text-[13px]">
              <p className="font-medium">{name}</p>
              <p className="text-muted">{desc}</p>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
