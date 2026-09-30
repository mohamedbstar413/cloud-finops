# Cloud Price Optimizer

Multi-cloud (AWS, Azure, GCP) cost optimization with an **AI Architecture Advisor**. It covers the usual FinOps work (rightsizing, idle resources, commitments, storage tiering, anomalies). It also proposes **different architectures**, **cross-cloud placements** and **what-if strategies**, and prices every one of them with the same deterministic engine.

## Quick start

```bash
npm install
cp .env.example .env        # optionally add OPENAI_API_KEY; set SEED_PASSWORD to sign in as the Acme users
npm run setup               # create SQLite schema + seed the "Acme Corp" demo organization
npm run dev                 # http://localhost:3000 (the background worker runs inside the dev server)
```

Open the app and either **create an account** (`/signup`: your own organization, then onboarding connects a cloud account or loads sample data) or choose **Explore the live demo** on the sign-in page (a short, read-only visit to Acme Corp). There is no fallback user: without a session every page redirects to `/login`.

In development, emails (invitations, password resets, notifications) are printed to the server log, so the links can be followed locally.

The app works fully without an OpenAI key (rules mode). Add `OPENAI_API_KEY` to unlock the AI features (see [AI design](#ai-design)).

Other scripts: `npm run analyze -- "<organization name or id>"` (print ranked recommendations in the terminal; default: the demo organization), `npm run worker`, `npm run keys:rotate`, `npm run db:reset`, `npm run build`.

## Testing

```bash
npm test               # 202 tests: engine, usage over time, connectors, projection, schemas, complex architectures, diagrams, SaaS foundations, fuzzing
npm run test:stress    # same suite with 10× more fuzz iterations (FUZZ_RUNS=10)
npm run fuzz:seed -- 551   # reproduce a failing fuzz seed and print its recommendations (add --usage for the usage-history fuzz)
```

`tests/saas.test.ts` runs against a real throwaway database (SQLite by default) and covers accounts and sessions (no fallback user, lockout after repeated failures), tenant isolation, invitations, password resets, the read-only demo, per-tenant encryption and master-key rotation, the job queue (no duplicates, one job per organization at a time, retries, crash recovery, the daily schedule), plan limits, settings, Stripe webhooks, and organization export and deletion. To run it on PostgreSQL:

```bash
npx prisma generate --schema prisma/postgres/schema.prisma
TEST_POSTGRES_URL="postgresql://user@localhost:5432/anydb" npx tsx --test tests/saas.test.ts
npx prisma generate      # back to the SQLite client
```

Each run creates its own schema (`test_saas_<pid>`) in that database and drops it afterwards; nothing else in the database is touched.

`tests/diagram.test.ts` proves the diagram layout's guarantees on thousands of random multi-cloud graphs:

- Nodes never overlap.
- Each cloud's components stay inside its boundary, and boundaries never overlap.
- Edges are orthogonal and never pass through a component.

It also covers row wrapping, semantic auto-diagrams and the architecture diff.

`tests/usage.test.ts` covers how usage history drives (or stops) a recommendation:

- **The usage library:** percentiles, the weekday-against-weekday trend and its shrinkage, daily rollups without partial-day dips, hour-of-week profiles, idle windows and schedules (including windows that cross midnight).
- **Every usage-based rule on hand-built histories:**
  - Missing memory, growing usage, short history and short bursts all stop a right-sizing.
  - A month-end peak is respected even though an overall p95 hides it.
  - A host with quiet CPU but live network traffic is not idle.
  - Schedules come from the fleet's own hours; a Saturday job and an overnight job stay on.
  - Serverless is priced at the forecast request volume.
  - Commitments follow the hourly instance floor.
  - Storage tiering is net of retrieval fees, and gp3 is charged for the IOPS actually used.
- **The demo estate end to end:** the same recommendations and the same three held-back resources whatever day the analysis runs.
- **Fuzzing:** 200 random estates with random histories (3 to 60 days, gaps, missing metrics), checked against guardrails such as "never resized without a memory measurement".

`tests/connectors.test.ts` covers everything between "the cloud API answered" and "the engine has a usage profile": CloudWatch batching and paging (with a fake client), aligning sparse samples on the collection grid, combining metrics, unit conversions, Azure and GCP response parsing. The SDK calls themselves need real accounts and are not exercised.

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
| **Usage over time, not a snapshot** | Every sync stores six weeks of hourly utilisation and traffic, and 90 days of daily storage figures, per resource. Changes are sized for the **busiest day's peak projected 90 days ahead**, schedules come from each fleet's own **hour-of-week pattern**, and when a metric is missing or usage is growing the engine **holds back and says why** instead of guessing. See [How usage over time is used](#how-usage-over-time-is-used). |
| **Savings de-duplication** | Recommendations that touch the same resources are alternatives, not additive. The highest-savings one is primary and the others link to it. Totals never double-count. |
| **Commit after optimize** | Savings Plans, Reservations and CUDs are sized on the *post-optimization* baseline, so you don't commit to capacity you are about to remove. For autoscaled fleets only the instances that run **every hour** (the hourly floor) are committed. |
| **What-if simulator** | Ask "what if we moved all possible workloads to serverless?" The AI turns the question into transforms and the simulator applies them in dependency order. You get savings by lever, spend by provider before and after, payback, and a list of workloads that are **not eligible, with the reason** — including resources the usage data did not support changing (memory not measured, usage growing, still serving traffic). |
| **Savings Projection page** | Cost-improvement charts for any suggested architecture, or for **any architecture you describe** (free text or component builder): a waterfall from today's spend, the trajectory with migration ramp and forecast growth, cumulative net savings with break-even, ROI and 3-year NPV. |
| **Anomaly detection** | Weekday-seasonal robust z-score (median/MAD) per service. One-off spikes don't poison the baseline. Anomalies are reported as **spend at risk**, separately from run-rate savings. |
| **Architecture diff diagrams** | Every proposal is drawn by a purpose-built layout engine: one boundary per cloud, crossing reduction, orthogonal edges routed through the gaps (never through a component), buses for many-to-many links, and per-component costs. **Side by side** or as a **unified diff** (removed components struck through, new ones highlighted, "moved from AWS"). Hover or focus a component for its pricing breakdown; expand to full screen or export as SVG. |
| **Role-aware analysis of any architecture** | Free text or a component builder. Each tier (web, batch, stateful, k8s) only gets optimizations that are safe for it. Serverless is evaluated against a computed request **break-even**. Every assumption, estimated SKU rate and unpriced service is surfaced to the user. |

## How usage over time is used

The engine never optimizes a resource from a single average. Each resource carries a usage profile built from its history: average, percentiles, the **busiest day's p95**, a trend, a 90-day forecast and an hour-of-week curve.

| Resource | History used | What it decides |
|---|---|---|
| **Compute** (VMs, fleets, node pools, DBs, app plans) | Hourly CPU (average and maximum), memory, running-instance count | Right-sizing needs CPU *and* memory peaks under the limit today and in 90 days. Kubernetes pools and serverless capacity are replayed hour by hour over the week. Non-prod schedules and batch windows come from the hours the fleet was actually busy. Commitments cover the hourly instance floor. |
| **Storage** (buckets, volumes) | Daily stored GB and reads, hourly IOPS | Lifecycle savings are net of retrieval fees and follow the measured size and growth. gp2 → gp3 adds the IOPS the volume really uses (with 25% burst headroom). |
| **Network** (load balancers, NAT, egress) | Hourly requests, NAT bytes and the share going to object storage, daily transfer | Serverless is priced at today's *and* the six-month forecast request volume, with a break-even. NAT endpoints use the measured storage share. A VM is only idle if its network is quiet too. Load balancers and NAT gateways with no traffic are flagged. |

Rules that apply everywhere:

- **Peak:** the busiest day's p95 of the hourly maximum. A month-end or weekly peak counts. A single odd hour (a patch reboot) does not.
- **Trend:** compared weekday with weekday (a quiet weekend is not a decline) and shrunk by its own uncertainty (six noisy weeks cannot prove +1%/month).
- **Idle hours:** an hour of the week is idle only if it was quiet in every observed week. Schedules keep a one-hour buffer before and after.
- **Minimum history:** 14 days before any usage-based change. Under four weeks the trend is not trusted, and the recommendation says so with lower confidence.
- **Held back, not guessed:** when memory is not measured, the history is too short, usage is growing into the smaller size, or a "quiet" host still moves data, no recommendation is made. The resource appears under **held back** on the Recommendations page with the reason and the next step (for example "install the CloudWatch agent").

Every usage-based recommendation shows the history it used: daily charts with the limit it was compared against, and an hour-of-week heatmap where a schedule is involved. A table view is one click away.

## Screens

| Route | Purpose |
|---|---|
| `/dashboard` | Spend, de-duplicated potential savings, spend trend by provider, top recommendations, savings by lever |
| `/recommendations` | Open recommendations: search, category, provider and sort in one row (account, minimum savings and alternatives under "Filters"), impact filter, 8 per page; re-run analysis; AI architecture discovery |
| `/recommendations/held-back` | Usage-history coverage and the resources the engine **held back**, grouped by reason, with the next step for each |
| `/recommendations/history` | Applied, snoozed and dismissed recommendations |
| `/recommendations/[id]` | Overview (with the **usage history behind the recommendation**) · Architecture Comparison · Cost Impact · Implementation · Terraform · AI Deep-dive, plus Apply / Dismiss / Snooze / Create ticket |
| `/advisor` | Ask a what-if question (or pick a starter); recent scenarios |
| `/advisor/history` | Every scenario the organization has simulated |
| `/advisor/scenarios/[id]` | One scenario: headline numbers, then Summary · Savings breakdown · Changes (and what was left out) · Over time |
| `/savings` | Cost-improvement charts for suggested improvements or any custom architecture |
| `/cost-explorer` | Filters by provider, period, category, region, account and workload tag; donut, stacked bars, daily trend, sparkline table, CSV export |
| `/accounts` | Connect AWS/Azure/GCP (or demo) accounts; sync, health test, read-only / read-write, disconnect; usage-history coverage per account and warnings for data a sync could not read |
| `/signup`, `/login`, `/forgot-password`, `/invite/[token]` | Create an account and organization, sign in (or explore the read-only demo), reset a password, accept an invitation |
| `/onboarding` | A new organization's first steps: connect a cloud account or load sample data, then the first analysis runs in the background |
| `/organization` | Members, roles, email invitations, audit log, permission matrix |
| `/billing` | Plan, usage against the plan's limits, upgrade (Stripe Checkout) and the customer portal |
| `/settings` | Daily sync hour, integration status, pricing catalog, usage-analysis rules, detector list |
| `/settings/remediation` | How changes reach your repository (branch, branch + pull request, or automatic apply of low-risk changes), branch prefix, allowed change types, backup retention, Git connection |
| `/settings/notifications` | Emails for new high-impact savings and sync failures |
| `/settings/data` | Export everything held about the organization; delete the organization |

The sidebar switches between the organizations you belong to.

## Architecture

```
src/
  lib/
    pricing/catalog.ts        list-price snapshot (VMs, serverless, storage tiers, egress, DBs, commitments)
    pricing/components.ts     provider-agnostic component kinds + deterministic priceComponent()
    usage/series.ts           usage time series: percentiles, seasonal trend, forecast, hour-of-week profile, schedules
    usage/summary.ts          summary metrics derived from the series (never the other way round)
    engine/
      signals.ts              time-aware signals for detectors: peak, forecast, usage windows, data gaps, evidence charts
      architecture.ts         serverless, static-site→CDN, NAT→endpoints, serverless DB, PaaS→containers, k8s Spot
      arbitrage.ts            cross-cloud placement incl. egress / data gravity, batch fleets priced for their job window
      standard.ts             rightsizing (+Arm), idle VMs / load balancers / NAT, storage tiering, gp2→gp3, non-prod scheduling
      commitments.ts          post-optimization commitment sizing on the hourly instance floor
      anomaly.ts              seasonal robust z-score
      forecast.ts             trend + weekday seasonality
      whatif.ts               scenario simulator + offline keyword planner
      custom.ts               analysis of arbitrary architectures + free-text parser
      index.ts                runEngine() / runEngineWithCoverage() + overlap resolution
    diagram/                  layout.ts (layered layout, cloud columns, orthogonal routing), diff.ts (architecture diff + cost linking)
    ai/                       OpenAI client, strict JSON schemas, advisor (enrich, discover, plan, narrate, analyze)
    connectors/               aws.ts (STS AssumeRole, Cost Explorer, EC2/ASG, EBS, ELB, NAT, RDS, S3 + CloudWatch),
                              azure.ts (Cost Management, ARM, Azure Monitor), gcp.ts (BigQuery billing export, Compute,
                              Cloud Storage, Cloud Monitoring), usage.ts (aligning and combining samples), demo.ts
    demo/usage.ts             deterministic usage history for the demo estate
    services/                 ingestion (upsert by external id), analysis (fingerprint reconciliation), queries,
                              auth (accounts, sessions, invitations, resets, demo visits), org-lifecycle (export, deletion)
    auth.ts                   request-level session and RBAC (getSession / pageSession / requirePermission)
    jobs/                     queue.ts (Postgres/SQLite-backed, de-duplicated), worker.ts (per-organization fairness, retries
                              with backoff, crash recovery), scheduler.ts (daily sync at each organization's hour), handlers.ts
    billing/                  plans.ts (Free / Pro / Enterprise limits), limits.ts (enforcement and usage meters), stripe.ts
    settings.ts               per-organization settings with defaults (remediation, backups, sync, notifications, Git)
    tenant-crypto.ts          per-organization data keys wrapped by the master key; master-key rotation
    email.ts                  transactional email (Resend, or the server log in development)
    projection.ts             trajectories, break-even, ROI, NPV, waterfall
  app/(app)/…                 pages          app/api/…  route handlers
  proxy.ts                    redirects visitors without a session to /login; refuses cross-site API writes
  instrumentation.ts          starts the worker inside the dev server (WORKER_MODE=inline)
prisma/schema.prisma          Organization, User, Session, Membership(role), CloudAccount, Resource, UsageSeries, CostRecord,
                              Recommendation, AnalysisRun, Ticket, Scenario, AuditLog, Invite, Job, UsageCounter, …
prisma/postgres/              the same model for PostgreSQL (generated) and its migrations
scripts/                      worker.ts, rotate-keys.ts, analyze.ts, prisma-postgres.ts, fuzz-seed.ts
```

**Pipeline:** connector → normalized `Resource` + its `UsageSeries` + daily `CostRecord` (FOCUS-style) → `runEngineWithCoverage()` → recommendations reconciled by **fingerprint**, plus an `AnalysisRun` that records usage coverage and what was held back. Re-analysis keeps your apply, dismiss and snooze decisions and any AI enrichment.

## AI design

Set `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`; the default is `gpt-4.1`, and any model that supports JSON-schema structured outputs works).

- **AI Deep-dive** (recommendation page): narrative, risk register with mitigations, refined migration plan, validation checks, rollback plan, context-aware Terraform.
- **AI architecture discovery** (Recommendations page): proposes new architectures the rules missed. Each one must reference real resource IDs. The pricing engine then prices it, and proposals saving less than 10% are rejected.
- **What-if planning and narration** (`/advisor`): turns a question into simulator transforms and explains the result. Every number comes from the simulator.
- **Custom architecture analysis** (`/savings` → "Analyze any architecture"): interprets free text and proposes 2–3 alternatives, all priced by the engine.

The model sees the same usage history the detectors use. Every resource in the prompt carries a usage summary (busiest-day peak, 90-day forecast, weekly busy window, always-running instance count, and an explicit "not measured" where a metric is missing), and the prompt lists the resources the rules engine **held back** and why. The model is told to size for the forecast peak and not to propose what was deliberately left alone.

Without a key, the same features fall back to rules: a keyword planner, a free-text parser and heuristic proposals.

## Connecting real accounts

| Provider | Access | Data |
|---|---|---|
| AWS | Cross-account IAM role with a unique **External ID**. The CloudFormation template is generated in the wizard. Set `PLATFORM_AWS_ACCOUNT_ID` to the account that assumes the role. | Cost Explorer (daily by service and region). Inventory: EC2 (Auto Scaling groups as fleets), EBS, EIPs, load balancers, NAT gateways, RDS, S3. CloudWatch history: CPU average and maximum, network, memory (CloudWatch agent), instance counts, requests, NAT bytes, IOPS, DB memory and connections, bucket size per storage class. |
| Azure | Service principal with Cost Management Reader, Reader and Monitoring Reader | Cost Management Query API. Inventory: VMs, scale sets (AKS pools), managed disks, storage accounts, SQL databases, App Service plans. Azure Monitor history: CPU, available memory, network, used capacity, egress. |
| GCP | Service account (viewer, billing viewer, BigQuery data viewer and job user, monitoring viewer) + detailed billing export to BigQuery | Billing export. Inventory: Compute Engine (managed groups as fleets), disks, Cloud Storage. Cloud Monitoring history: CPU, memory (Ops Agent), network, bucket size and reads. |

Credentials are validated before they are saved and encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`). Connections are read-only by default. Write permission can be enabled per account.

A sync never fails because one kind of data is unreadable. A missing permission or metric becomes a **warning on the account**, the affected resources are kept without history, and the engine then reports them as held back.

Some things no connector can measure today, and the engine says so instead of assuming:

- **How cold object storage is** (last-access analysis). It needs S3 Storage Lens, Azure last-access tracking or GCS Storage Insights. Large hot buckets without a lifecycle policy are reported as held back.
- **Where NAT traffic goes.** It needs VPC Flow Logs. NAT gateways with heavy traffic are reported as held back.
- **Memory without an agent** on AWS (CloudWatch agent) and GCP (Ops Agent).

## Roles

`owner` / `admin`: everything, including accounts and members. `member`: act on recommendations, run analysis, use AI. `viewer`: read-only. Only an owner can change the plan or delete the organization. Permissions are enforced in every API route.

Sign-in is email and password: passwords are hashed with scrypt, repeated failures lock the address for a while, and unknown addresses get the same answer as wrong passwords. The session cookie holds a random token; only its SHA-256 is stored, and sessions slide forward while in use. SSO / SAML (Enterprise) is not built yet; `src/lib/services/auth.ts` is the place to add it.

## Running in production

- **Database: PostgreSQL.** `prisma/schema.prisma` stays on SQLite for zero-setup development; `prisma/postgres/schema.prisma` is the same model for PostgreSQL, generated by `npm run db:postgres:schema`, with migrations in `prisma/postgres/migrations`. Deploy with:
  ```bash
  npx prisma generate --schema prisma/postgres/schema.prisma
  npx prisma migrate deploy --schema prisma/postgres/schema.prisma
  ```
  After a schema change: `npm run db:postgres:schema`, then `npx prisma migrate dev --schema prisma/postgres/schema.prisma --name <change>` against a development Postgres.
- **Web servers and workers.** Syncs, analyses, the daily schedule and organization deletions run as jobs, never inside a web request. In production the web servers do not run jobs (`WORKER_MODE=separate` is the default); run one or more `npm run worker` processes next to them (`WORKER_CONCURRENCY` jobs each, default 2). Each organization runs one job at a time and organizations take turns, so one large customer cannot hold up the others. Failed jobs retry with backoff, and jobs left behind by a crashed worker are picked up again.
- **Keys.** `ENCRYPTION_KEY` (32 bytes, hex or base64) is required. It wraps each organization's own data key, which encrypts that organization's cloud credentials. To rotate it, stop the web servers and workers, run `OLD_ENCRYPTION_KEY=<current> ENCRYPTION_KEY=<new> npm run keys:rotate` (safe to run again if it stops half way), then start everything with the new key. Deleting an organization destroys its data key.
- **Email:** set `RESEND_API_KEY`, `EMAIL_FROM` and `APP_URL` (used in links).
- **Payments:** set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO` and `STRIPE_WEBHOOK_SECRET`, and point a Stripe webhook at `/api/billing/webhook`. Without them the Billing page shows the plans but cannot charge.
- **Demo:** leave `SEED_PASSWORD` empty so the seeded Acme users cannot sign in; the read-only demo visit still works.
- **Backups:** the application keeps no database backups of its own; use your Postgres provider's point-in-time recovery. A customer's own export is on `/settings/data`.

## Production notes and limits

- **Plan limits:** cloud accounts, members (counting pending invitations), AI requests per month and manual syncs per day are hard limits. The resource allowance is soft: an estate over it is still analysed in full, and its accounts show an upgrade warning. Sample-data accounts never count.
- **Remediation modes:** the settings (branch, branch + pull request, automatic apply, allowed change types, backup retention) are stored and shown throughout the product; pushing branches to the customer's Git provider is not wired up yet.
- **Pricing:** the catalog is a curated snapshot of list prices. It does not include negotiated discounts, tiered egress breaks or every SKU. Swap in AWS Price List, Azure Retail Prices and the GCP Billing Catalog for live prices.
- **Connectors:** the AWS, Azure and GCP connectors are written against the official APIs but have **not been exercised against live accounts** in this repo. Their data handling (batching, paging, alignment, unit conversion) is unit-tested with fake responses. The demo connector generates a realistic 90-day estate with six weeks of hourly usage.
- **Usage history storage:** each series is stored as a JSON array on a `UsageSeries` row (about 1,000 samples for six hourly weeks). That is fine for thousands of resources. For very large estates, move the series to a time-series store or keep hourly data for fewer weeks.
- **Usage history limits:** IOPS history is hourly averages, so short bursts are covered by a fixed headroom rather than measured. On GCP a managed group's history is built from its current members, so a group that replaces instances often shows less history than it has (and is held back rather than resized). A trend estimated from six weeks carries roughly ±2% per month of uncertainty.
- **AI path:** the OpenAI integration is covered by schema, normalization and prompt-input tests, but it has **not been run against the live API** in this repo (no key was configured). Rules mode is what the demo and the tests exercise.
- **Estimates:** workload metadata (`stateless`, `portable`, `interruptible`, data sources) comes from tags. The engine's estimates are only as good as that metadata.
