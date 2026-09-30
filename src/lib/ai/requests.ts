import { z } from "zod";
import { COMPONENT_KINDS } from "../pricing/components";

/** Request body for POST /api/advisor/custom (shared with tests). */
const ComponentSchema = z.object({
  id: z.string(),
  kind: z.enum(COMPONENT_KINDS),
  provider: z.enum(["aws", "azure", "gcp"]),
  label: z.string(),
  sku: z.string().optional(),
  region: z.string().optional(),
  role: z.enum(["web", "batch", "stateful", "k8s"]).optional(),
  usage: z.record(z.string(), z.any()).default({}),
});

export const CustomAnalysisRequest = z.object({
  description: z.string().max(4000).optional(),
  components: z.array(ComponentSchema).max(40).optional(),
  profile: z
    .object({
      trafficPattern: z.enum(["steady", "spiky", "business_hours", "batch", "unknown"]).optional(),
      stateless: z.boolean().optional(),
      interruptible: z.boolean().optional(),
      latencySensitive: z.boolean().optional(),
      requestsPerMonthM: z.number().optional(),
    })
    .optional(),
});

