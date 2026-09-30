/**
 * Terraform sketches attached to recommendations. They are intentionally
 * minimal, readable starting points — the AI enrichment step can expand them
 * with context-specific details.
 */
import type { ScheduleTransition } from "../usage/series";

export function tfServerless(p: { name: string; region: string; memoryMb: number; asyncShare: number }) {
  return `# ${p.name}: ALB + EC2 fleet  →  API Gateway (HTTP) + Lambda + SQS
provider "aws" { region = "${p.region}" }

resource "aws_lambda_function" "api" {
  function_name = "${p.name}-api"
  role          = aws_iam_role.lambda.arn
  runtime       = "nodejs20.x"
  architectures = ["arm64"]          # Graviton: ~20% cheaper per GB-s
  handler       = "index.handler"
  filename      = "build/api.zip"
  memory_size   = ${p.memoryMb}
  timeout       = 29
}

resource "aws_apigatewayv2_api" "http" {
  name          = "${p.name}"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "proxy" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/\${aws_apigatewayv2_integration.api.id}"
}

# ~${Math.round(p.asyncShare * 100)}% of requests do background work — decouple it
resource "aws_sqs_queue" "jobs" {
  name                       = "${p.name}-jobs"
  visibility_timeout_seconds = 120
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue" "jobs_dlq" { name = "${p.name}-jobs-dlq" }

resource "aws_lambda_event_source_mapping" "worker" {
  event_source_arn = aws_sqs_queue.jobs.arn
  function_name    = aws_lambda_function.worker.arn
  batch_size       = 10
}

resource "aws_lambda_function" "worker" {
  function_name = "${p.name}-worker"
  role          = aws_iam_role.lambda.arn
  runtime       = "nodejs20.x"
  architectures = ["arm64"]
  handler       = "worker.handler"
  filename      = "build/worker.zip"
  memory_size   = 1024
  timeout       = 110
}
`;
}

export function tfGcpSpot(p: { name: string; machineType: string; count: number; region: string; spot?: boolean; window?: string }) {
  const spot = p.spot ?? true;
  return `# ${p.name}: move batch fleet to GCP ${spot ? "Spot" : "on-demand"} VMs, co-located with its data
${p.window ? `# Observed busy window: ${p.window}. Keep target_size at 0 and let the job scheduler resize the group for each run.\n` : ""}provider "google" { region = "${p.region}" }

resource "google_compute_instance_template" "${p.name.replace(/-/g, "_")}" {
  name_prefix  = "${p.name}-"
  machine_type = "${p.machineType}"

${
  spot
    ? `  scheduling {
    provisioning_model          = "SPOT"
    preemptible                 = true
    automatic_restart           = false
    instance_termination_action = "DELETE"
  }
`
    : ""
}
  disk {
    source_image = "cos-cloud/cos-stable"
    disk_type    = "pd-balanced"
    disk_size_gb = 200
  }

  network_interface { network = "default" }
  service_account {
    email  = google_service_account.batch.email
    scopes = ["cloud-platform"]
  }
}

resource "google_compute_region_instance_group_manager" "${p.name.replace(/-/g, "_")}" {
  name               = "${p.name}"
  region             = "${p.region}"
  base_instance_name = "${p.name}"
  target_size        = ${p.window ? `0 # ${p.count} while a run is in progress` : p.count}
  version {
    instance_template = google_compute_instance_template.${p.name.replace(/-/g, "_")}.id
  }
}

# Tip: prefer Cloud Batch / GKE Autopilot Spot pods for job-level checkpointing.
`;
}

export function tfAwsSpot(p: { name: string; instanceType: string; count: number; region: string; spot?: boolean; window?: string }) {
  const spot = p.spot ?? true;
  return `# ${p.name}: ${spot ? "run the fleet on EC2 Spot with capacity-optimized allocation" : "run the fleet only while the job runs"}
${p.window ? `# Observed busy window: ${p.window}. The group idles at 0 and the job scheduler sets the desired capacity for each run.\n` : ""}provider "aws" { region = "${p.region}" }

resource "aws_autoscaling_group" "${p.name.replace(/-/g, "_")}" {
  name             = "${p.name}"
  desired_capacity = ${p.window ? `0 # ${p.count} while a run is in progress` : p.count}
  min_size         = 0
  max_size         = ${p.count * 2}

  mixed_instances_policy {
    instances_distribution {
      on_demand_percentage_above_base_capacity = ${spot ? 0 : 100}
      spot_allocation_strategy                 = "price-capacity-optimized"
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.${p.name.replace(/-/g, "_")}.id
      }
      override { instance_type = "${p.instanceType}" }
      override { instance_type = "c6i.4xlarge" }
      override { instance_type = "m5.4xlarge" }
    }
  }
}
`;
}

export function tfStaticSite(p: { name: string; region: string }) {
  return `# ${p.name}: VM-hosted static site  →  S3 + CloudFront (Origin Access Control)
provider "aws" { region = "${p.region}" }

resource "aws_s3_bucket" "site" { bucket = "${p.name}-site" }

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${p.name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = "s3-site"
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate { cloudfront_default_certificate = true }
}
`;
}

export function tfVpcEndpoints(p: { vpcId: string; region: string }) {
  return `# Route S3 / DynamoDB traffic through free Gateway Endpoints instead of NAT
provider "aws" { region = "${p.region}" }

data "aws_route_tables" "private" {
  vpc_id = "${p.vpcId}"
  filter {
    name   = "tag:tier"
    values = ["private"]
  }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = "${p.vpcId}"
  service_name      = "com.amazonaws.${p.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = data.aws_route_tables.private.ids
}

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = "${p.vpcId}"
  service_name      = "com.amazonaws.${p.region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = data.aws_route_tables.private.ids
}
`;
}

export function tfAuroraServerless(p: { name: string; minAcu: number; maxAcu: number }) {
  return `# ${p.name}: provisioned RDS  →  Aurora Serverless v2 (PostgreSQL)
resource "aws_rds_cluster" "${p.name.replace(/-/g, "_")}" {
  cluster_identifier = "${p.name}"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = "16.4"
  storage_encrypted  = true

  serverlessv2_scaling_configuration {
    min_capacity = ${p.minAcu}
    max_capacity = ${p.maxAcu}
  }
}

resource "aws_rds_cluster_instance" "writer" {
  cluster_identifier = aws_rds_cluster.${p.name.replace(/-/g, "_")}.id
  instance_class     = "db.serverless"
  engine             = "aurora-postgresql"
}

resource "aws_rds_cluster_instance" "reader" {
  cluster_identifier = aws_rds_cluster.${p.name.replace(/-/g, "_")}.id
  instance_class     = "db.serverless"
  engine             = "aurora-postgresql"
}
`;
}

export function tfAzureSqlServerless(p: { name: string; maxVcores: number; minVcores: number }) {
  return `# ${p.name}: provisioned General Purpose  →  Serverless (auto-scale, per-second billing)
resource "azurerm_mssql_database" "${p.name.replace(/-/g, "_")}" {
  name                        = "${p.name}"
  server_id                   = azurerm_mssql_server.main.id
  sku_name                    = "GP_S_Gen5_${p.maxVcores}"
  min_capacity                = ${p.minVcores}
  auto_pause_delay_in_minutes = -1   # prod: keep warm; set 60 for non-prod
  max_size_gb                 = 1024
  zone_redundant              = false
}
`;
}

export function tfContainerApps(p: { name: string; minReplicas: number; maxReplicas?: number }) {
  return `# ${p.name}: App Service Premium plan  →  Azure Container Apps (consumption)
resource "azurerm_container_app_environment" "main" {
  name                = "${p.name}-env"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_container_app" "${p.name.replace(/-/g, "_")}" {
  name                         = "${p.name}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  template {
    min_replicas = ${p.minReplicas}
    max_replicas = ${p.maxReplicas ?? 30}
    container {
      name   = "${p.name}"
      image  = "acmecr.azurecr.io/${p.name}:latest"
      cpu    = 0.5
      memory = "1Gi"
    }
    http_scale_rule {
      name                = "http"
      concurrent_requests = "50"
    }
  }

  ingress {
    external_enabled = true
    target_port      = 8080
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}
`;
}

export function tfAksSpot(p: { cluster: string; vmSize: string; max: number }) {
  return `# ${p.cluster}: add an autoscaled Spot node pool for stateless workloads
resource "azurerm_kubernetes_cluster_node_pool" "spot" {
  name                  = "spot"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.${p.cluster.replace(/-/g, "_")}.id
  vm_size               = "${p.vmSize}"
  priority              = "Spot"
  eviction_policy       = "Delete"
  spot_max_price        = -1
  auto_scaling_enabled  = true
  min_count             = 0
  max_count             = ${p.max}
  node_labels           = { "kubernetes.azure.com/scalesetpriority" = "spot" }
  node_taints           = ["kubernetes.azure.com/scalesetpriority=spot:NoSchedule"]
}

# Then add a matching toleration + PodDisruptionBudget to stateless Deployments
# and enable the cluster autoscaler "least-waste" expander on the system pool.
`;
}

export function tfS3Lifecycle(p: { bucket: string; iaDays: number; coldDays: number; intelligentTiering?: boolean }) {
  if (p.intelligentTiering) {
    return `resource "aws_s3_bucket_lifecycle_configuration" "${p.bucket.replace(/-/g, "_")}" {
  bucket = "${p.bucket}"
  rule {
    id     = "intelligent-tiering"
    status = "Enabled"
    filter {}
    transition {
      days          = 0
      storage_class = "INTELLIGENT_TIERING"
    }
  }
}

resource "aws_s3_bucket_intelligent_tiering_configuration" "archive" {
  bucket = "${p.bucket}"
  name   = "archive-after-180d"
  tiering {
    access_tier = "ARCHIVE_ACCESS"
    days        = 180
  }
}
`;
  }
  return `resource "aws_s3_bucket_lifecycle_configuration" "${p.bucket.replace(/-/g, "_")}" {
  bucket = "${p.bucket}"
  rule {
    id     = "tier-down"
    status = "Enabled"
    filter {}
    transition {
      days          = ${p.iaDays}
      storage_class = "STANDARD_IA"
    }
    transition {
      days          = ${p.coldDays}
      storage_class = "GLACIER_IR"
    }
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}
`;
}

export function tfAzureBlobLifecycle(p: { account: string }) {
  return `resource "azurerm_storage_management_policy" "${p.account}" {
  storage_account_id = azurerm_storage_account.${p.account}.id
  rule {
    name    = "tier-down"
    enabled = true
    filters { blob_types = ["blockBlob"] }
    actions {
      base_blob {
        tier_to_cool_after_days_since_last_access_time_greater_than = 30
        tier_to_cold_after_days_since_last_access_time_greater_than = 90
        tier_to_archive_after_days_since_last_access_time_greater_than = 365
      }
    }
  }
}
`;
}

export function tfGp3(p: { volumes: string[] }) {
  return `# gp2 → gp3 is an online modification (no downtime, no detach)
${p.volumes
  .slice(0, 3)
  .map(
    (v) => `resource "aws_ebs_volume" "${v.replace(/[^a-z0-9]/gi, "_")}" {
  # ...existing arguments
  type       = "gp3"
  iops       = 3000
  throughput = 125
}`,
  )
  .join("\n\n")}
${p.volumes.length > 3 ? `\n# …and ${p.volumes.length - 3} more volumes (or: aws ec2 modify-volume --volume-type gp3)` : ""}
`;
}

export function tfSchedule(p: { name: string; region: string; tagKey: string; tagValue: string; schedule: string; starts: ScheduleTransition[]; stops: ScheduleTransition[] }) {
  const rule = (action: "start" | "stop", t: ScheduleTransition, i: number, many: boolean) => `resource "aws_scheduler_schedule" "${action}${many ? `_${i + 1}` : ""}" {
  name                         = "${p.name}-${action}${many ? `-${i + 1}` : ""}"
  schedule_expression          = "cron(0 ${t.hour} ? * ${t.days.join(",")} *)"
  schedule_expression_timezone = "UTC"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ec2:${action}Instances"
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ InstanceIds = data.aws_instances.${p.tagValue}.ids })
  }
}
`;
  return `# Run ${p.name} only when it is used: ${p.schedule}
# (derived from its observed hour-of-week utilisation, with a 1-hour buffer)
provider "aws" { region = "${p.region}" }

${[...p.stops.map((t, i) => rule("stop", t, i, p.stops.length > 1)), ...p.starts.map((t, i) => rule("start", t, i, p.starts.length > 1))].join("\n")}
data "aws_instances" "${p.tagValue}" {
  instance_tags = { ${p.tagKey} = "${p.tagValue}" }
}
`;
}

export function tfSnapshotArchive() {
  return `# Move snapshots older than 90 days to the archive tier; expire after 1 year
resource "aws_dlm_lifecycle_policy" "archive" {
  description        = "Archive and expire old EBS snapshots"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { backup = "daily" }
    schedule {
      name = "daily-with-archive"
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
      }
      retain_rule { count = 14 }
      archive_rule {
        archive_retain_rule {
          retention_archive_tier {
            interval      = 365
            interval_unit = "DAYS"
          }
        }
      }
    }
  }
}
`;
}

export function tfRightsize(p: { name: string; from: string; to: string }) {
  return `# ${p.name}: ${p.from} → ${p.to}
resource "aws_launch_template" "${p.name.replace(/-/g, "_")}" {
  # ...existing arguments
  instance_type = "${p.to}"
}

# Roll the Auto Scaling group with an instance refresh (min healthy 90%)
resource "aws_autoscaling_group" "${p.name.replace(/-/g, "_")}" {
  # ...existing arguments
  instance_refresh {
    strategy = "Rolling"
    preferences { min_healthy_percentage = 90 }
  }
}
`;
}
