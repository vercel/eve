import { z } from "zod";
import { isLinkSandbox, isSandboxRequest } from "../../../../server/link/sandbox";

export const spendRequestId = z.string().min(1).max(255)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid Link spend-request ID.");
export const spendRequestInput = z.strictObject({ id: spendRequestId });

// Link's SDK accepts arbitrary IDs and interpolates them into request paths.
// Keep every mutation on its intended resource, including direct execute calls.
export function validateSpendRequestId(input: { id: string }): void {
  spendRequestId.parse(input.id);
}

export async function linkMetadataRequest<T>(request: () => T | Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    // The SDK includes provider response bodies in its errors. Do not persist
    // those bodies, while preserving Eve's separate authorization pause signals.
    if (error instanceof Error && ["LinkApiError", "LinkResponseError", "LinkTransportError", "LinkConfigurationError"].includes(error.name)) {
      const status = "status" in error && typeof error.status === "number" && Number.isInteger(error.status)
        && error.status >= 100 && error.status <= 599 ? ` (HTTP ${error.status})` : "";
      throw new Error(`Link request failed${status}. Check the existing request before retrying.`);
    }
    throw error;
  }
}

// Construct metadata-only results before Eve can persist them. The SDK's loose
// response objects can include credentials, including fields added in the future.
const total = z.object({
  type: z.string(),
  display_text: z.string(),
  amount: z.number(),
});

const metadata = z.object({
  id: spendRequestId,
  status: z.string(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  merchant_name: z.string().optional(),
  merchant_url: z.string().optional(),
  context: z.string().optional(),
  line_items: z.array(z.object({
    name: z.string(),
    url: z.string().optional(),
    image_url: z.string().optional(),
    description: z.string().optional(),
    sku: z.string().optional(),
    totals: z.array(total).optional(),
    quantity: z.number().optional(),
    unit_amount: z.number().optional(),
    product_url: z.string().optional(),
  })).optional(),
  totals: z.array(total).optional(),
  approval_url: z.string().optional(),
  activity_url: z.string().optional(),
  expires_at: z.number().optional(),
  recurring: z.object({
    interval: z.string(),
    interval_count: z.number().optional(),
  }).nullable().optional(),
  payment_status_details: z.object({
    outcome: z.enum(["success", "failure"]),
    code: z.string().nullable().optional(),
    decline_code: z.string().nullable().optional(),
    amount: z.number(),
    currency: z.string(),
    created: z.number().nullable().optional(),
    refund_details: z.object({
      amount: z.number(),
      currency: z.string(),
      state: z.string(),
      created: z.number(),
    }).nullable().optional(),
  }).nullable().optional(),
  status_details: z.object({
    requires_action: z.object({
      failure_code: z.string().optional(),
      next_action: z.object({
        type: z.string().optional(),
        display_message: z.string().optional(),
        action_url: z.string().nullable().optional(),
        resolution: z.string().optional(),
        expires_at: z.number().nullable().optional(),
      }).optional(),
    }).optional(),
  }).nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export function spendRequestMetadata(value: unknown) {
  const result = metadata.safeParse(value);
  if (!result.success) throw new Error("Unexpected Link spend-request response.");
  return isLinkSandbox() ? { ...result.data, test: true as const } : result.data;
}

export function spendRequestListMetadata(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Unexpected Link spend-request list.");
  return value.map(spendRequestMetadata).filter(item => isSandboxRequest(item.id));
}

export function spendApprovalMetadata(value: unknown) {
  const result = z.object({ id: spendRequestId, approval_url: z.string() }).safeParse(value);
  if (!result.success) throw new Error("Unexpected Link approval response.");
  return result.data;
}
