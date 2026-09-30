import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { CostExplorerClient, GetCostAndUsageCommand, type GetCostAndUsageCommandOutput } from "@aws-sdk/client-cost-explorer";
import { DescribeAddressesCommand, DescribeInstancesCommand, DescribeVolumesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { priceComponent } from "../pricing/components";
import { categorize, type AwsCredentials, type Connector, type NormalizedCost, type NormalizedResource } from "./types";

async function assume(creds: AwsCredentials) {
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

const tag = (tags: { Key?: string; Value?: string }[] | undefined, k: string) => tags?.find((t) => t.Key === k)?.Value;

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
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    // 1) Daily cost by service (Cost Explorer)
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

    // 2) Inventory + utilisation per region
    const regions = creds.regions?.length ? creds.regions : ["us-east-1"];
    const resources: NormalizedResource[] = [];
    for (const region of regions) {
      const ec2 = new EC2Client({ region, credentials });
      const cw = new CloudWatchClient({ region, credentials });
      const inst = await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: "instance-state-name", Values: ["running", "stopped"] }] }));
      const instances = (inst.Reservations ?? []).flatMap((r) => r.Instances ?? []);

      const cpu = new Map<string, { avg: number; max: number; p95: number }>();
      for (let i = 0; i < instances.length; i += 100) {
        const batch = instances.slice(i, i + 100);
        const res = await cw.send(
          new GetMetricDataCommand({
            StartTime: new Date(Date.now() - 14 * 86_400_000),
            EndTime: new Date(),
            MetricDataQueries: batch.map((x, j) => ({
              Id: `c${j}`,
              MetricStat: {
                Metric: { Namespace: "AWS/EC2", MetricName: "CPUUtilization", Dimensions: [{ Name: "InstanceId", Value: x.InstanceId! }] },
                Period: 3600,
                Stat: "Average",
              },
            })),
          }),
        );
        for (const r of res.MetricDataResults ?? []) {
          const idx = Number(r.Id!.slice(1));
          const v = (r.Values ?? []).slice().sort((a, b) => a - b);
          if (!v.length) continue;
          cpu.set(batch[idx].InstanceId!, {
            avg: v.reduce((a, b) => a + b, 0) / v.length,
            max: v[v.length - 1],
            p95: v[Math.floor(v.length * 0.95)],
          });
        }
      }

      for (const x of instances) {
        const m = cpu.get(x.InstanceId!);
        const sku = x.InstanceType ?? "m5.large";
        const running = x.State?.Name === "running";
        resources.push({
          externalId: x.InstanceId!,
          name: tag(x.Tags, "Name") ?? x.InstanceId!,
          kind: "compute.vm",
          service: "EC2",
          sku,
          region,
          workload: tag(x.Tags, "app") ?? tag(x.Tags, "workload"),
          environment: tag(x.Tags, "env") ?? tag(x.Tags, "environment"),
          state: running ? "running" : "stopped",
          quantity: 1,
          monthlyCost: running ? priceComponent({ id: x.InstanceId!, kind: "compute.vm", provider: "aws", label: sku, sku, region, usage: {} }).monthlyCost : 0,
          metrics: m ? { cpuAvg: m.avg, cpuP95: m.p95, cpuMax: m.max, dutyCycle: m.avg > 5 ? Math.min(1, m.avg / Math.max(m.p95, 1)) : 0 } : {},
          config: { stateless: tag(x.Tags, "stateless") === "true", interruptible: tag(x.Tags, "interruptible") === "true", portable: tag(x.Tags, "portable") === "true" },
          tags: (x.Tags ?? []).map((t) => `${t.Key}=${t.Value}`),
        });
      }

      const vols = await ec2.send(new DescribeVolumesCommand({}));
      for (const v of vols.Volumes ?? []) {
        const gb = v.Size ?? 0;
        const type = v.VolumeType ?? "gp3";
        resources.push({
          externalId: v.VolumeId!,
          name: tag(v.Tags, "Name") ?? v.VolumeId!,
          kind: "storage.block",
          service: "EBS",
          region,
          state: v.State ?? "in-use",
          quantity: 1,
          monthlyCost: priceComponent({ id: v.VolumeId!, kind: "storage.block", provider: "aws", label: "ebs", region, usage: { gb, tier: type === "gp2" || type === "io1" ? "premium" : "standard" } }).monthlyCost,
          metrics: {},
          config: { sizeGb: gb, volumeType: type, attached: (v.Attachments ?? []).length > 0 },
          tags: (v.Tags ?? []).map((t) => `${t.Key}=${t.Value}`),
        });
      }

      const addrs = await ec2.send(new DescribeAddressesCommand({}));
      for (const a of addrs.Addresses ?? []) {
        resources.push({
          externalId: a.AllocationId ?? a.PublicIp!,
          name: a.PublicIp!,
          kind: "network.public_ip",
          service: "Public IPv4",
          region,
          state: "allocated",
          quantity: 1,
          monthlyCost: 3.65,
          metrics: {},
          config: { attached: Boolean(a.AssociationId) },
          tags: [],
        });
      }
    }
    return { resources, costs };
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
                  { Effect: "Allow", Action: ["ce:Get*", "ce:Describe*", "cur:Describe*", "cloudwatch:GetMetricData", "compute-optimizer:Get*", "pricing:GetProducts"], Resource: "*" },
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
