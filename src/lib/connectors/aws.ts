import { CloudWatchClient, type Dimension } from "@aws-sdk/client-cloudwatch";
import { CostExplorerClient, GetCostAndUsageCommand, type GetCostAndUsageCommandOutput } from "@aws-sdk/client-cost-explorer";
import { DescribeAddressesCommand, DescribeInstancesCommand, DescribeNatGatewaysCommand, DescribeVolumesCommand, EC2Client, type Instance, type NatGateway, type Volume } from "@aws-sdk/client-ec2";
import { DescribeLoadBalancersCommand, DescribeTagsCommand, ElasticLoadBalancingV2Client, type LoadBalancer } from "@aws-sdk/client-elastic-load-balancing-v2";
import { DescribeDBInstancesCommand, RDSClient, type DBInstance } from "@aws-sdk/client-rds";
import { GetBucketLifecycleConfigurationCommand, GetBucketLocationCommand, ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { resolveVm } from "../pricing/catalog";
import { priceComponent } from "../pricing/components";
import type { Series, Stat, Unit } from "../usage/series";
import { fetchMetrics, listMetricDimensions, memoryDimensionsFor, type MetricSpec } from "./aws-metrics";
import { categorize, normalizeEnvironment, type AwsCredentials, type Connector, type NormalizedCost, type NormalizedResource } from "./types";
import { attempt, collectionWindow, combine, DAILY_DAYS, HOURLY_DAYS, lastDaysTotal, latest, toSeries, withUsage, type CollectionWindow, type Point } from "./usage";

type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
type Tags = { Key?: string; Value?: string }[] | undefined;

async function assume(creds: AwsCredentials): Promise<Credentials> {
  const sts = new STSClient({ region: "us-east-1" });
  const out = await sts.send(
    new AssumeRoleCommand({
      RoleArn: creds.roleArn,
      ExternalId: creds.externalId,
      RoleSessionName: "cloud-price-optimizer",
      DurationSeconds: 3600,
    }),
  );
  const c = out.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error("AssumeRole returned no credentials");
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
}

const tag = (tags: Tags, k: string) => tags?.find((t) => t.Key === k)?.Value;
const tagList = (tags: Tags) => (tags ?? []).filter((t) => !t.Key?.startsWith("aws:")).map((t) => `${t.Key}=${t.Value}`);
const workloadOf = (tags: Tags) => tag(tags, "app") ?? tag(tags, "workload") ?? tag(tags, "Application");
const environmentOf = (tags: Tags) => normalizeEnvironment(tag(tags, "env") ?? tag(tags, "environment") ?? tag(tags, "Environment"));
const isKubernetesNode = (tags: Tags) => Boolean(tags?.some((t) => t.Key === "eks:cluster-name" || t.Key === "eks:nodegroup-name" || t.Key?.startsWith("kubernetes.io/cluster/")));

/** Everything the per-region collectors share. */
interface Ctx {
  region: string;
  credentials: Credentials;
  cw: CloudWatchClient;
  hourly: CollectionWindow;
  warnings: string[];
  /** Workload and environment of each instance, so volumes can inherit them. */
  owners: Map<string, { workload?: string; environment?: string }>;
}

/** Fetch metrics and hand back a lookup that builds aligned series; a failure is a warning, not a failed sync. */
async function measure(ctx: Ctx, what: string, specs: MetricSpec[], w: CollectionWindow = ctx.hourly, cw: CloudWatchClient = ctx.cw) {
  const data = specs.length ? await attempt(ctx.warnings, `${what} in ${ctx.region}`, new Map<string, Point[]>(), () => fetchMetrics(cw, specs, w)) : new Map<string, Point[]>();
  return (id: string, metric: string, stat: Stat, unit: Unit, transform?: (v: number) => number): Series | null => toSeries(metric, stat, unit, w, data.get(id), transform);
}

/* ------------------------------------------------------------------------- */
/* Cost                                                                       */
/* ------------------------------------------------------------------------- */

async function collectCosts(credentials: Credentials, days: number): Promise<NormalizedCost[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const ce = new CostExplorerClient({ region: "us-east-1", credentials });
  const costs: NormalizedCost[] = [];
  let token: string | undefined;
  do {
    const page: GetCostAndUsageCommandOutput = await ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: fmt(start), End: fmt(end) },
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
        GroupBy: [
          { Type: "DIMENSION", Key: "SERVICE" },
          { Type: "DIMENSION", Key: "REGION" },
        ],
        NextPageToken: token,
      }),
    );
    for (const day of page.ResultsByTime ?? []) {
      for (const g of day.Groups ?? []) {
        const cost = Number(g.Metrics?.UnblendedCost?.Amount ?? 0);
        if (cost <= 0) continue;
        const [service, region] = g.Keys ?? ["Other", "global"];
        costs.push({ date: day.TimePeriod!.Start!, service, category: categorize(service), region: region || "global", cost });
      }
    }
    token = page.NextPageToken;
  } while (token);
  return costs;
}

/* ------------------------------------------------------------------------- */
/* EC2: Auto Scaling groups as fleets, other instances one by one             */
/* ------------------------------------------------------------------------- */

const MEMORY_METRICS = ["mem_used_percent", "Memory % Committed Bytes In Use"]; // Linux, Windows

async function collectInstances(ctx: Ctx): Promise<NormalizedResource[]> {
  const ec2 = new EC2Client({ region: ctx.region, credentials: ctx.credentials });
  const instances: Instance[] = [];
  let token: string | undefined;
  do {
    const page = await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: "instance-state-name", Values: ["running", "stopped"] }], NextToken: token }));
    for (const r of page.Reservations ?? []) instances.push(...(r.Instances ?? []));
    token = page.NextToken;
  } while (token);
  for (const x of instances) ctx.owners.set(x.InstanceId!, { workload: workloadOf(x.Tags), environment: environmentOf(x.Tags) });

  // Instances in an Auto Scaling group come and go: their history lives on the group, not on the instance.
  const running = instances.filter((x) => x.State?.Name === "running");
  const fleets = new Map<string, Instance[]>();
  const single: Instance[] = [];
  for (const x of running) {
    const group = tag(x.Tags, "aws:autoscaling:groupName");
    if (group) fleets.set(group, [...(fleets.get(group) ?? []), x]);
    else single.push(x);
  }

  const specs: MetricSpec[] = [];
  const utilisation = (key: string, dimensions: Dimension[]) =>
    specs.push(
      { id: `${key}|cpu`, namespace: "AWS/EC2", metric: "CPUUtilization", dimensions, stat: "Average" },
      { id: `${key}|cpu_max`, namespace: "AWS/EC2", metric: "CPUUtilization", dimensions, stat: "Maximum" },
      { id: `${key}|net_in`, namespace: "AWS/EC2", metric: "NetworkIn", dimensions, stat: "Sum" },
      { id: `${key}|net_out`, namespace: "AWS/EC2", metric: "NetworkOut", dimensions, stat: "Sum" },
    );
  for (const name of fleets.keys()) {
    const dimensions = [{ Name: "AutoScalingGroupName", Value: name }];
    utilisation(`asg:${name}`, dimensions);
    specs.push(
      { id: `asg:${name}|inservice`, namespace: "AWS/AutoScaling", metric: "GroupInServiceInstances", dimensions, stat: "Average" },
      { id: `asg:${name}|samples`, namespace: "AWS/EC2", metric: "CPUUtilization", dimensions, stat: "SampleCount" },
    );
  }
  for (const x of single) utilisation(`i:${x.InstanceId}`, [{ Name: "InstanceId", Value: x.InstanceId! }]);

  // Memory is only published by the CloudWatch agent, under whatever dimensions it was configured with.
  const memory = await attempt(ctx.warnings, `Memory metrics (CloudWatch agent) in ${ctx.region}`, [] as { metric: string; sets: Dimension[][] }[], async () => {
    const found: { metric: string; sets: Dimension[][] }[] = [];
    for (const metric of MEMORY_METRICS) found.push({ metric, sets: await listMetricDimensions(ctx.cw, "CWAgent", metric) });
    return found;
  });
  const memorySpec = (id: string, target: { instanceId?: string; autoScalingGroup?: string }) => {
    for (const { metric, sets } of memory) {
      const dimensions = memoryDimensionsFor(sets, target);
      if (!dimensions) continue;
      specs.push({ id, namespace: "CWAgent", metric, dimensions, stat: "Average" });
      return true;
    }
    return false;
  };
  for (const [name, members] of fleets) {
    // Prefer the agent's group-level aggregate; otherwise average the members that report.
    if (!memorySpec(`asg:${name}|mem`, { autoScalingGroup: name })) members.forEach((x) => memorySpec(`member:${x.InstanceId}|mem`, { instanceId: x.InstanceId! }));
  }
  for (const x of single) memorySpec(`i:${x.InstanceId}|mem`, { instanceId: x.InstanceId! });

  const s = await measure(ctx, "EC2 utilisation metrics", specs);
  const price = (x: Instance) => {
    const sku = x.InstanceType ?? "m5.large";
    return priceComponent({ id: x.InstanceId!, kind: "compute.vm", provider: "aws", label: sku, sku, region: ctx.region, usage: { spot: x.InstanceLifecycle === "spot" } }).monthlyCost;
  };
  const configOf = (tags: Tags, members: Instance[]) => ({
    stateless: tag(tags, "stateless") === "true",
    interruptible: tag(tags, "interruptible") === "true" || members.every((x) => x.InstanceLifecycle === "spot"),
    portable: tag(tags, "portable") === "true",
    ...(tag(tags, "arm-compatible") === "true" ? { armCompatible: true } : {}),
    ...(isKubernetesNode(tags) ? { role: "k8s-node" } : {}),
  });

  const out: NormalizedResource[] = [];
  for (const [name, members] of fleets) {
    const key = `asg:${name}`;
    const tags = members[0].Tags;
    const types = new Map<string, number>();
    for (const x of members) types.set(x.InstanceType ?? "m5.large", (types.get(x.InstanceType ?? "m5.large") ?? 0) + 1);
    const sku = [...types.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // Running instances per hour: the group's own metric when group metrics are enabled, otherwise the
    // number of CPU samples divided by what one instance reports in an hour (60 with detailed monitoring, 12 without).
    const perInstanceHour = members.filter((x) => x.Monitoring?.State === "enabled").length * 2 >= members.length ? 60 : 12;
    const instances = s(`${key}|inservice`, "instances", "avg", "count") ?? s(`${key}|samples`, "instances", "avg", "count", (v) => v / perInstanceHour);
    const mem = s(`${key}|mem`, "mem", "avg", "percent") ?? combine("mem", "avg", "percent", members.map((x) => s(`member:${x.InstanceId}|mem`, "mem", "avg", "percent")), "avg");
    const usage = withUsage({}, [s(`${key}|cpu`, "cpu", "avg", "percent"), s(`${key}|cpu_max`, "cpu_max", "max", "percent"), mem, s(`${key}|net_in`, "net_in", "sum", "bytes"), s(`${key}|net_out`, "net_out", "sum", "bytes"), instances]);
    out.push({
      externalId: `asg/${name}`,
      name,
      kind: "compute.vm",
      service: "EC2 Auto Scaling",
      sku,
      region: ctx.region,
      workload: workloadOf(tags),
      environment: environmentOf(tags),
      state: "running",
      quantity: members.length,
      monthlyCost: members.reduce((sum, x) => sum + price(x), 0),
      config: configOf(tags, members),
      tags: tagList(tags),
      ...usage,
    });
  }
  for (const x of instances) {
    if (fleets.has(tag(x.Tags, "aws:autoscaling:groupName") ?? "") && x.State?.Name === "running") continue;
    const runningNow = x.State?.Name === "running";
    const key = `i:${x.InstanceId}`;
    const usage = runningNow
      ? withUsage({}, [s(`${key}|cpu`, "cpu", "avg", "percent"), s(`${key}|cpu_max`, "cpu_max", "max", "percent"), s(`${key}|mem`, "mem", "avg", "percent"), s(`${key}|net_in`, "net_in", "sum", "bytes"), s(`${key}|net_out`, "net_out", "sum", "bytes")])
      : { metrics: {}, series: [] };
    out.push({
      externalId: x.InstanceId!,
      name: tag(x.Tags, "Name") ?? x.InstanceId!,
      kind: "compute.vm",
      service: "EC2",
      sku: x.InstanceType ?? "m5.large",
      region: ctx.region,
      workload: workloadOf(x.Tags),
      environment: environmentOf(x.Tags),
      state: runningNow ? "running" : "stopped",
      quantity: 1,
      monthlyCost: runningNow ? price(x) : 0,
      config: configOf(x.Tags, [x]),
      tags: tagList(x.Tags),
      ...usage,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* EBS volumes and Elastic IPs                                                */
/* ------------------------------------------------------------------------- */

async function collectVolumes(ctx: Ctx): Promise<NormalizedResource[]> {
  const ec2 = new EC2Client({ region: ctx.region, credentials: ctx.credentials });
  const volumes: Volume[] = [];
  let token: string | undefined;
  do {
    const page = await ec2.send(new DescribeVolumesCommand({ NextToken: token }));
    volumes.push(...(page.Volumes ?? []));
    token = page.NextToken;
  } while (token);

  // IOPS only matter for the gp2 → gp3 decision, so only attached gp2 volumes are measured.
  const measured = volumes.filter((v) => v.VolumeType === "gp2" && (v.Attachments ?? []).length > 0);
  const s = await measure(
    ctx,
    "EBS volume metrics",
    measured.flatMap((v) => {
      const dimensions = [{ Name: "VolumeId", Value: v.VolumeId! }];
      return [
        { id: `${v.VolumeId}|read`, namespace: "AWS/EBS", metric: "VolumeReadOps", dimensions, stat: "Sum" },
        { id: `${v.VolumeId}|write`, namespace: "AWS/EBS", metric: "VolumeWriteOps", dimensions, stat: "Sum" },
      ];
    }),
  );

  return volumes.map((v) => {
    const gb = v.Size ?? 0;
    const type = v.VolumeType ?? "gp3";
    const owner = ctx.owners.get(v.Attachments?.[0]?.InstanceId ?? "");
    // Operations per hour → average IOPS in that hour.
    const iops = combine("iops", "avg", "iops", [s(`${v.VolumeId}|read`, "iops", "avg", "iops", (n) => n / 3600), s(`${v.VolumeId}|write`, "iops", "avg", "iops", (n) => n / 3600)], "sum");
    return {
      externalId: v.VolumeId!,
      name: tag(v.Tags, "Name") ?? v.VolumeId!,
      kind: "storage.block" as const,
      service: "EBS",
      region: ctx.region,
      workload: workloadOf(v.Tags) ?? owner?.workload,
      environment: environmentOf(v.Tags) ?? owner?.environment,
      state: v.State ?? "in-use",
      quantity: 1,
      monthlyCost: priceComponent({ id: v.VolumeId!, kind: "storage.block", provider: "aws", label: "ebs", region: ctx.region, usage: { gb, tier: type === "gp2" || type === "io1" ? "premium" : "standard" } }).monthlyCost,
      metrics: {},
      config: { sizeGb: gb, volumeType: type, attached: (v.Attachments ?? []).length > 0 },
      tags: tagList(v.Tags),
      series: iops ? [iops] : [],
    };
  });
}

async function collectAddresses(ctx: Ctx): Promise<NormalizedResource[]> {
  const ec2 = new EC2Client({ region: ctx.region, credentials: ctx.credentials });
  const addrs = await ec2.send(new DescribeAddressesCommand({}));
  return (addrs.Addresses ?? []).map((a) => ({
    externalId: a.AllocationId ?? a.PublicIp!,
    name: a.PublicIp!,
    kind: "network.public_ip" as const,
    service: "Public IPv4",
    region: ctx.region,
    state: "allocated",
    quantity: 1,
    monthlyCost: 3.65,
    metrics: {},
    config: { attached: Boolean(a.AssociationId) },
    tags: tagList(a.Tags),
  }));
}

/* ------------------------------------------------------------------------- */
/* Load balancers and NAT gateways: traffic over time                         */
/* ------------------------------------------------------------------------- */

async function collectLoadBalancers(ctx: Ctx): Promise<NormalizedResource[]> {
  const elb = new ElasticLoadBalancingV2Client({ region: ctx.region, credentials: ctx.credentials });
  const lbs: LoadBalancer[] = [];
  let marker: string | undefined;
  do {
    const page = await elb.send(new DescribeLoadBalancersCommand({ Marker: marker }));
    lbs.push(...(page.LoadBalancers ?? []));
    marker = page.NextMarker;
  } while (marker);
  const active = lbs.filter((l) => l.State?.Code === "active" && (l.Type === "application" || l.Type === "network") && l.LoadBalancerArn);

  const tags = new Map<string, Tags>();
  for (let i = 0; i < active.length; i += 20) {
    const res = await attempt(ctx.warnings, `Load balancer tags in ${ctx.region}`, undefined, () => elb.send(new DescribeTagsCommand({ ResourceArns: active.slice(i, i + 20).map((l) => l.LoadBalancerArn!) })));
    for (const d of res?.TagDescriptions ?? []) tags.set(d.ResourceArn!, d.Tags);
  }

  const dimension = (l: LoadBalancer) => [{ Name: "LoadBalancer", Value: l.LoadBalancerArn!.split(":loadbalancer/")[1] }];
  const s = await measure(
    ctx,
    "Load balancer traffic metrics",
    active.flatMap((l) => {
      const dimensions = dimension(l);
      const id = l.LoadBalancerArn!;
      return l.Type === "application"
        ? [
            { id: `${id}|requests`, namespace: "AWS/ApplicationELB", metric: "RequestCount", dimensions, stat: "Sum" },
            { id: `${id}|bytes`, namespace: "AWS/ApplicationELB", metric: "ProcessedBytes", dimensions, stat: "Sum" },
            { id: `${id}|latency`, namespace: "AWS/ApplicationELB", metric: "TargetResponseTime", dimensions, stat: "Average" },
          ]
        : [{ id: `${id}|bytes`, namespace: "AWS/NetworkELB", metric: "ProcessedBytes", dimensions, stat: "Sum" }];
    }),
  );

  return active.map((l) => {
    const id = l.LoadBalancerArn!;
    const t = tags.get(id);
    const latency = s(`${id}|latency`, "latency_avg", "avg", "ms", (sec) => sec * 1000);
    const present = (latency?.values ?? []).filter((v): v is number => v !== null);
    const usage = withUsage(present.length ? { avgDurationMs: Math.round(present.reduce((a, b) => a + b, 0) / present.length) } : {}, [s(`${id}|requests`, "requests", "sum", "count"), latency]);
    return {
      externalId: id,
      name: l.LoadBalancerName ?? id,
      kind: "network.load_balancer" as const,
      service: l.Type === "application" ? "ALB" : "NLB",
      region: ctx.region,
      workload: workloadOf(t),
      environment: environmentOf(t),
      state: "running",
      quantity: 1,
      monthlyCost: priceComponent({ id, kind: "network.load_balancer", provider: "aws", label: l.LoadBalancerName ?? "lb", region: ctx.region, usage: { count: 1, gb: lastDaysTotal(s(`${id}|bytes`, "bytes", "sum", "bytes")) / 1e9 } }).monthlyCost,
      config: {},
      tags: tagList(t),
      ...usage,
    };
  });
}

async function collectNatGateways(ctx: Ctx): Promise<NormalizedResource[]> {
  const ec2 = new EC2Client({ region: ctx.region, credentials: ctx.credentials });
  const nats: NatGateway[] = [];
  let token: string | undefined;
  do {
    const page = await ec2.send(new DescribeNatGatewaysCommand({ Filter: [{ Name: "state", Values: ["available"] }], NextToken: token }));
    nats.push(...(page.NatGateways ?? []));
    token = page.NextToken;
  } while (token);

  const s = await measure(
    ctx,
    "NAT gateway traffic metrics",
    nats.flatMap((n) => {
      const dimensions = [{ Name: "NatGatewayId", Value: n.NatGatewayId! }];
      return [
        { id: `${n.NatGatewayId}|out`, namespace: "AWS/NATGateway", metric: "BytesOutToDestination", dimensions, stat: "Sum" },
        { id: `${n.NatGatewayId}|in`, namespace: "AWS/NATGateway", metric: "BytesInFromDestination", dimensions, stat: "Sum" },
      ];
    }),
  );

  return nats.map((n) => {
    const id = n.NatGatewayId!;
    // Every byte is billed once, whichever way it flows.
    const bytes = combine("nat_bytes", "sum", "bytes", [s(`${id}|out`, "nat_bytes", "sum", "bytes"), s(`${id}|in`, "nat_bytes", "sum", "bytes")], "sum");
    return {
      externalId: id,
      name: tag(n.Tags, "Name") ?? id,
      kind: "network.nat_gateway" as const,
      service: "NAT Gateway",
      region: ctx.region,
      workload: workloadOf(n.Tags),
      environment: environmentOf(n.Tags),
      state: "running",
      quantity: 1,
      monthlyCost: priceComponent({ id, kind: "network.nat_gateway", provider: "aws", label: id, region: ctx.region, usage: { count: 1, gb: lastDaysTotal(bytes) / 1e9 } }).monthlyCost,
      // Where the traffic goes (the share to S3) needs VPC Flow Logs; without it the engine reports a gap.
      config: n.VpcId ? { role: n.VpcId } : {},
      tags: tagList(n.Tags),
      ...withUsage({}, [bytes]),
    };
  });
}

/* ------------------------------------------------------------------------- */
/* RDS                                                                        */
/* ------------------------------------------------------------------------- */

async function collectDatabases(ctx: Ctx): Promise<NormalizedResource[]> {
  const rds = new RDSClient({ region: ctx.region, credentials: ctx.credentials });
  const dbs: DBInstance[] = [];
  let marker: string | undefined;
  do {
    const page = await rds.send(new DescribeDBInstancesCommand({ Marker: marker }));
    dbs.push(...(page.DBInstances ?? []));
    marker = page.Marker;
  } while (marker);
  const available = dbs.filter((d) => d.DBInstanceIdentifier && d.DBInstanceStatus === "available");

  const s = await measure(
    ctx,
    "RDS utilisation metrics",
    available.flatMap((d) => {
      const dimensions = [{ Name: "DBInstanceIdentifier", Value: d.DBInstanceIdentifier! }];
      const id = d.DBInstanceIdentifier!;
      return [
        { id: `${id}|cpu`, namespace: "AWS/RDS", metric: "CPUUtilization", dimensions, stat: "Average" },
        { id: `${id}|cpu_max`, namespace: "AWS/RDS", metric: "CPUUtilization", dimensions, stat: "Maximum" },
        { id: `${id}|free`, namespace: "AWS/RDS", metric: "FreeableMemory", dimensions, stat: "Average" },
        { id: `${id}|connections`, namespace: "AWS/RDS", metric: "DatabaseConnections", dimensions, stat: "Average" },
      ];
    }),
  );

  return available.map((d) => {
    const id = d.DBInstanceIdentifier!;
    const sku = d.DBInstanceClass ?? "db.m5.large";
    // FreeableMemory is bytes free; the instance class tells us how much there is in total.
    const totalBytes = (resolveVm(sku.replace(/^db\./, ""))?.memGiB ?? 0) * 2 ** 30;
    const mem = totalBytes > 0 ? s(`${id}|free`, "mem", "avg", "percent", (free) => Math.min(100, Math.max(0, 100 * (1 - free / totalBytes)))) : null;
    const tags = d.TagList;
    return {
      externalId: d.DBInstanceArn ?? id,
      name: id,
      kind: "db.instance" as const,
      service: `RDS ${d.Engine ?? ""}`.trim(),
      sku,
      region: ctx.region,
      workload: workloadOf(tags),
      environment: environmentOf(tags),
      state: "running",
      quantity: 1,
      monthlyCost: priceComponent({ id, kind: "db.instance", provider: "aws", label: id, sku, region: ctx.region, usage: { multiAz: d.MultiAZ, storageGb: d.AllocatedStorage } }).monthlyCost,
      config: { multiAz: Boolean(d.MultiAZ), sizeGb: d.AllocatedStorage },
      tags: tagList(tags),
      ...withUsage({}, [s(`${id}|cpu`, "cpu", "avg", "percent"), s(`${id}|cpu_max`, "cpu_max", "max", "percent"), mem, s(`${id}|connections`, "connections", "avg", "count")]),
    };
  });
}

/* ------------------------------------------------------------------------- */
/* S3: size per storage class and reads, day by day                           */
/* ------------------------------------------------------------------------- */

const MAX_BUCKETS = 300;
/** CloudWatch storage types, mapped to the three price tiers the engine knows. */
const STORAGE_TYPES: Record<string, "hot" | "cool" | "cold"> = {
  StandardStorage: "hot",
  ReducedRedundancyStorage: "hot",
  IntelligentTieringFAStorage: "hot",
  StandardIAStorage: "cool",
  OneZoneIAStorage: "cool",
  IntelligentTieringIAStorage: "cool",
  GlacierInstantRetrievalStorage: "cold",
  IntelligentTieringAIAStorage: "cold",
  IntelligentTieringAAStorage: "cold",
  IntelligentTieringDAAStorage: "cold",
  GlacierStorage: "cold",
  DeepArchiveStorage: "cold",
};

async function collectBuckets(credentials: Credentials, warnings: string[]): Promise<NormalizedResource[]> {
  const s3 = new S3Client({ region: "us-east-1", credentials, followRegionRedirects: true });
  const listed = (await s3.send(new ListBucketsCommand({}))).Buckets ?? [];
  if (listed.length > MAX_BUCKETS) warnings.push(`S3: ${listed.length} buckets found; only the first ${MAX_BUCKETS} were analysed`);

  const byRegion = new Map<string, string[]>();
  for (const b of listed.slice(0, MAX_BUCKETS)) {
    if (!b.Name) continue;
    let region = b.BucketRegion;
    if (!region) {
      const loc = await attempt(warnings, `S3 bucket location (${b.Name})`, undefined, () => s3.send(new GetBucketLocationCommand({ Bucket: b.Name })));
      if (!loc) continue;
      region = !loc.LocationConstraint ? "us-east-1" : loc.LocationConstraint === "EU" ? "eu-west-1" : loc.LocationConstraint;
    }
    byRegion.set(region, [...(byRegion.get(region) ?? []), b.Name]);
  }

  const daily = collectionWindow(DAILY_DAYS, 1440);
  const out: NormalizedResource[] = [];
  for (const [region, names] of byRegion) {
    const cw = new CloudWatchClient({ region, credentials });
    const regional = new S3Client({ region, credentials });
    const ctx: Ctx = { region, credentials, cw, hourly: daily, warnings, owners: new Map() };
    const s = await measure(
      ctx,
      "S3 storage metrics",
      names.flatMap((name) => [
        ...Object.keys(STORAGE_TYPES).map((type) => ({ id: `${name}|${type}`, namespace: "AWS/S3", metric: "BucketSizeBytes", dimensions: [{ Name: "BucketName", Value: name }, { Name: "StorageType", Value: type }], stat: "Average" })),
        { id: `${name}|objects`, namespace: "AWS/S3", metric: "NumberOfObjects", dimensions: [{ Name: "BucketName", Value: name }, { Name: "StorageType", Value: "AllStorageTypes" }], stat: "Average" },
        // Request metrics are opt-in per bucket; when they are off there is simply no read series.
        { id: `${name}|read`, namespace: "AWS/S3", metric: "BytesDownloaded", dimensions: [{ Name: "BucketName", Value: name }, { Name: "FilterId", Value: "EntireBucket" }], stat: "Sum" },
      ]),
      daily,
    );

    for (const name of names) {
      const classes = Object.entries(STORAGE_TYPES).map(([type, tier]) => ({ tier, series: s(`${name}|${type}`, "stored_gb", "avg", "gb", (bytes) => bytes / 1e9) }));
      const stored = combine("stored_gb", "avg", "gb", classes.map((c) => c.series), "sum");
      if (!stored) continue; // empty bucket, or storage metrics not yet published
      const gbIn = (tier: string) => classes.filter((c) => c.tier === tier).reduce((sum, c) => sum + (latest(c.series) ?? 0), 0);
      const total = gbIn("hot") + gbIn("cool") + gbIn("cold");
      if (total <= 0) continue;
      const cost = (tier: "hot" | "cool" | "cold") => priceComponent({ id: name, kind: "storage.object", provider: "aws", label: name, region, usage: { gb: gbIn(tier), tier } }).monthlyCost;
      const lifecycle = await regional
        .send(new GetBucketLifecycleConfigurationCommand({ Bucket: name }))
        .then((r) => (r.Rules ?? []).some((rule) => rule.Status === "Enabled"))
        .catch(() => false); // no lifecycle configuration (or not readable): treated as none
      const objects = latest(s(`${name}|objects`, "objects", "avg", "count"));
      out.push({
        externalId: `arn:aws:s3:::${name}`,
        name,
        kind: "storage.object",
        service: "S3",
        region,
        state: "running",
        quantity: 1,
        monthlyCost: cost("hot") + cost("cool") + cost("cold"),
        // How much of the data is cold (last-access analysis) is not available from CloudWatch: the engine
        // reports a gap for large hot buckets without a lifecycle policy instead of guessing.
        config: { sizeGb: Math.round(total), tier: gbIn("hot") / total >= 0.8 ? "hot" : "mixed", lifecyclePolicy: lifecycle },
        tags: [],
        ...withUsage(objects !== undefined ? { objectCount: Math.round(objects) } : {}, [stored, s(`${name}|read`, "read_gb", "sum", "gb", (bytes) => bytes / 1e9)]),
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- */

export const awsConnector: Connector<AwsCredentials> = {
  provider: "aws",

  async validate(creds) {
    try {
      const credentials = await assume(creds);
      const id = await new STSClient({ region: "us-east-1", credentials }).send(new GetCallerIdentityCommand({}));
      return { ok: true, message: "Role assumed successfully", identity: id.Arn };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },

  async collect(creds, { days }) {
    const credentials = await assume(creds);
    // 1) Daily cost by service (Cost Explorer)
    const costs = await collectCosts(credentials, days);

    // 2) Inventory, with six weeks of hourly utilisation and traffic for everything that has any.
    //    Each part is independent: a missing permission becomes a warning on the account, not a failed sync.
    const warnings: string[] = [];
    const resources: NormalizedResource[] = [];
    const hourly = collectionWindow(HOURLY_DAYS);
    for (const region of creds.regions?.length ? creds.regions : ["us-east-1"]) {
      const ctx: Ctx = { region, credentials, cw: new CloudWatchClient({ region, credentials }), hourly, warnings, owners: new Map() };
      const part = async (what: string, collect: (ctx: Ctx) => Promise<NormalizedResource[]>) => resources.push(...(await attempt(warnings, `${what} in ${region}`, [], () => collect(ctx))));
      await part("EC2 instances", collectInstances);
      await part("EBS volumes", collectVolumes); // after instances: volumes inherit their instance's workload
      await part("Elastic IPs", collectAddresses);
      await part("Load balancers", collectLoadBalancers);
      await part("NAT gateways", collectNatGateways);
      await part("RDS databases", collectDatabases);
    }
    resources.push(...(await attempt(warnings, "S3 buckets", [], () => collectBuckets(credentials, warnings))));
    return { resources, costs, warnings };
  },
};

/** CloudFormation template customers deploy to grant read-only access. */
export function awsRoleTemplate(platformAccountId: string, externalId: string) {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Cloud Price Optimizer read-only access",
    Resources: {
      CloudPriceOptimizerRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: "CloudPriceOptimizerReadOnly",
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${platformAccountId}:root` },
                Action: "sts:AssumeRole",
                Condition: { StringEquals: { "sts:ExternalId": externalId } },
              },
            ],
          },
          ManagedPolicyArns: ["arn:aws:iam::aws:policy/job-function/ViewOnlyAccess", "arn:aws:iam::aws:policy/AWSBillingReadOnlyAccess"],
          Policies: [
            {
              PolicyName: "CostAndMetrics",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  { Effect: "Allow", Action: ["ce:Get*", "ce:Describe*", "cur:Describe*", "compute-optimizer:Get*", "pricing:GetProducts"], Resource: "*" },
                  // Usage history: utilisation and traffic metrics (read-only), and the inventory they belong to.
                  {
                    Effect: "Allow",
                    Action: [
                      "cloudwatch:GetMetricData",
                      "cloudwatch:ListMetrics",
                      "ec2:Describe*",
                      "autoscaling:Describe*",
                      "elasticloadbalancing:Describe*",
                      "rds:Describe*",
                      "rds:ListTagsForResource",
                      "s3:ListAllMyBuckets",
                      "s3:GetBucketLocation",
                      "s3:GetLifecycleConfiguration",
                    ],
                    Resource: "*",
                  },
                ],
              },
            },
          ],
        },
      },
    },
    Outputs: { RoleArn: { Value: { "Fn::GetAtt": ["CloudPriceOptimizerRole", "Arn"] } } },
  };
}
