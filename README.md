# Cloud Price Optimizer

Multi-cloud (AWS, Azure, GCP) cost optimization with an **AI Architecture Advisor**. It covers the usual FinOps work (rightsizing, idle resources, commitments, storage tiering, anomalies). It also proposes **different architectures**, **cross-cloud placements** and **what-if strategies**, and prices every one of them with the same deterministic engine.

## Quick start

```bash
npm install
cp .env.example .env        # optionally add OPENAI_API_KEY
npm run setup               # create SQLite schema + seed the "Acme Corp" demo estate
npm run dev                 # http://localhost:3000
```

The app works fully without an OpenAI key (rules mode). Add `OPENAI_API_KEY` to unlock the AI features (see [AI design](#ai-design)).

Other scripts: `npm run analyze` (print ranked recommendations in the terminal), `npm run db:reset`, `npm run build`.

## Testing

```bash
npm test               # 57 tests: engine, projection, schemas, complex architectures, fuzzing
npm run test:stress    # same suite with 10× more fuzz iterations (FUZZ_RUNS=10)
npm run fuzz:seed -- 551   # reproduce a failing fuzz seed and print its recommendations
```

`tests/complex-architectures.test.ts` covers:

- **Realistic multi-tier and multi-cloud scenarios:** e-commerce, trading, hybrid GCP/Azure, enterprise Azure, already-serverless.
- **Tier-level guardrails:**
  - Spot only for batch tiers.
  - No serverless for latency-sensitive paths.
  - No serverless without a known request volume.
  - Stateful tiers kept.
  - Databases never dropped.
  - Storage conserved.
  - Nothing that fails to pay back within 36 months.
- **Property-based fuzzing** over hundreds of random estates, architectures and free-text descriptions. It checks for finite prices, no double-counted resources, a balanced what-if arithmetic and deterministic output.
- **Robustness:**
  - Instance types outside the price catalog (shape inference).
  - Customers with negotiated discounts (effective-rate pricing).
  - Malformed LLM output.

## What makes it different

| Capability | How it works |
|---|---|
| **Architecture Advisor** | Graph-level detectors look for costly *patterns*, not single resources. Examples: an always-on VM fleet behind a load balancer becomes API Gateway + Lambda + SQS; a static site on VMs becomes S3 + CDN; S3 traffic through NAT moves to gateway endpoints; a spiky provisioned DB becomes a serverless DB; App Service becomes Container Apps; Kubernetes pools get bin-packed plus a Spot pool. Each finding includes current vs. proposed diagrams, a component-level cost breakdown, a comparison table, a migration plan, risks and a Terraform sketch. |
| **Data-gravity-aware cross-cloud arbitrage** | Each portable workload is priced on every cloud. The price includes compute (with a 10% Spot re-run buffer), storage, the **egress it creates or removes**, and migration cost. Same-cloud Spot is always evaluated, so a cross-cloud move is only recommended when it beats the simpler option. |
| **LLM proposes, engine prices** | OpenAI (strict JSON-schema structured outputs) can only describe architectures using ~20 provider-agnostic component kinds. The pricing engine prices every proposal, so the AI cannot invent savings. |
| **Savings de-duplication** | Recommendations that touch the same resources are alternatives, not additive. The highest-savings one is primary and the others link to it. Totals never double-count. |
| **Commit after optimize** | Savings Plans, Reservations and CUDs are sized on the *post-optimization* baseline, so you don't commit to capacity you are about to remove. |
| **What-if simulator** | Ask "what if we moved all possible workloads to serverless?" The AI turns the question into transforms and the simulator applies them in dependency order. You get savings by lever, spend by provider before and after, payback, and a list of workloads that are **not eligible, with the reason**. |
| **Savings Projection page** | Cost-improvement charts for any suggested architecture, or for **any architecture you describe** (free text or component builder): a waterfall from today's spend, the trajectory with migration ramp and forecast growth, cumulative net savings with break-even, ROI and 3-year NPV. |
| **Anomaly detection** | Weekday-seasonal robust z-score (median/MAD) per service. One-off spikes don't poison the baseline. Anomalies are reported as **spend at risk**, separately from run-rate savings. |
| **Role-aware analysis of any architecture** | Free text or a component builder. Each tier (web, batch, stateful, k8s) only gets optimizations that are safe for it. Serverless is evaluated against a computed request **break-even**. Every assumption, estimated SKU rate and unpriced service is surfaced to the user. |

## Screens

| Route | Purpose |
|---|---|
| `/dashboard` | Spend, de-duplicated potential savings, spend trend by provider, top recommendations, savings by lever |
| `/recommendations` | Filter by provider, category, account, savings, status; re-run analysis; AI architecture discovery |
| `/recommendations/[id]` | Overview · Architecture Comparison · Cost Impact · Implementation · Terraform · AI Deep-dive, plus Apply / Dismiss / Snooze / Create ticket |
| `/advisor` | What-if scenario simulator with shared history |
| `/savings` | Cost-improvement charts for suggested improvements or any custom architecture |
| `/cost-explorer` | Filters by provider, period, category, region, account and workload tag; donut, stacked bars, daily trend, sparkline table, CSV export |
| `/accounts` | Connect AWS/Azure/GCP (or demo) accounts; sync, health test, read-only / read-write, disconnect |
| `/organization` | Members, roles, invites, audit log, permission matrix, "view as" role preview |
| `/settings` | Integration status, pricing catalog, detector list |

## Architecture

```
src/
  lib/
    pricing/catalog.ts        list-price snapshot (VMs, serverless, storage tiers, egress, DBs, commitments)
    pricing/components.ts     provider-agnostic component kinds + deterministic priceComponent()
    engine/
      architecture.ts         serverless, static-site→CDN, NAT→endpoints, serverless DB, PaaS→containers, k8s Spot
      arbitrage.ts            cross-cloud placement incl. egress / data gravity
      standard.ts             rightsizing (+Arm), idle, storage tiering, gp2→gp3, non-prod scheduling
      commitments.ts          post-optimization commitment sizing
      anomaly.ts              seasonal robust z-score
      forecast.ts             trend + weekday seasonality
      whatif.ts               scenario simulator + offline keyword planner
      custom.ts               analysis of arbitrary architectures + free-text parser
      index.ts                runEngine() + overlap resolution
    ai/                       OpenAI client, strict JSON schemas, advisor (enrich, discover, plan, narrate, analyze)
    connectors/               aws.ts (STS AssumeRole + Cost Explorer + EC2/CloudWatch), azure.ts (Cost Management + ARM),
                              gcp.ts (BigQuery billing export + Compute), demo.ts
    services/                 ingestion (upsert by external id), analysis (fingerprint reconciliation), queries
    projection.ts             trajectories, break-even, ROI, NPV, waterfall
  app/(app)/…                 pages          app/api/…  route handlers
prisma/schema.prisma          Organization, User, Membership(role), CloudAccount, Resource, CostRecord,
                              Recommendation, Ticket, Scenario, AuditLog, Invite
```

**Pipeline:** connector → normalized `Resource` + daily `CostRecord` (FOCUS-style) → `runEngine()` → recommendations reconciled by **fingerprint**. Re-analysis keeps your apply, dismiss and snooze decisions and any AI enrichment.

## AI design

Set `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`; the default is `gpt-4.1`, and any model that supports JSON-schema structured outputs works).

- **AI Deep-dive** (recommendation page): narrative, risk register with mitigations, refined migration plan, validation checks, rollback plan, context-aware Terraform.
- **AI architecture discovery** (Recommendations page): proposes new architectures the rules missed. Each one must reference real resource IDs. The pricing engine then prices it, and proposals saving less than 10% are rejected.
- **What-if planning and narration** (`/advisor`): turns a question into simulator transforms and explains the result. Every number comes from the simulator.
- **Custom architecture analysis** (`/savings` → "Analyze any architecture"): interprets free text and proposes 2–3 alternatives, all priced by the engine.

Without a key, the same features fall back to rules: a keyword planner, a free-text parser and heuristic proposals.

## Connecting real accounts

| Provider | Access | Data |
|---|---|---|
| AWS | Cross-account IAM role with a unique **External ID**. The CloudFormation template is generated in the wizard. Set `PLATFORM_AWS_ACCOUNT_ID` to the account that assumes the role. | Cost Explorer (daily by service and region), EC2, EBS, EIPs, CloudWatch CPU |
| Azure | Service principal with Cost Management Reader, Reader and Monitoring Reader | Cost Management Query API, VMs and metrics, managed disks |
| GCP | Service account (viewer, billing viewer, BigQuery data viewer and job user) + detailed billing export to BigQuery | Billing export, Compute Engine inventory |

Credentials are validated before they are saved and encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`). Connections are read-only by default. Write permission can be enabled per account.

## Roles

`owner` / `admin`: everything, including accounts and members. `member`: act on recommendations, run analysis, use AI. `viewer`: read-only. Permissions are enforced in every API route. The demo resolves the current user from a cookie (use "View as" on `/organization`). Replace `getSession()` in `src/lib/auth.ts` with Auth.js, Clerk or WorkOS for production.

## Production notes and limits

- **Database:** switch `provider` in `prisma/schema.prisma` to `postgresql`.
- **Sync:** runs inline in the request. Move `syncAccount()` to a queue or cron worker (e.g. nightly) for large estates.
- **Pricing:** the catalog is a curated snapshot of list prices. It does not include negotiated discounts, tiered egress breaks or every SKU. Swap in AWS Price List, Azure Retail Prices and the GCP Billing Catalog for live prices.
- **Connectors:** the AWS, Azure and GCP connectors are written against the official APIs but have **not been exercised against live accounts** in this repo. The demo connector generates a realistic 90-day estate.
- **Estimates:** workload metadata (`stateless`, `portable`, `interruptible`, data sources) comes from tags. The engine's estimates are only as good as that metadata.
