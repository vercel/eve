import { z } from "zod";

const RESEND_API_ORIGIN = "https://api.resend.com";
const WebhookSchema = z.object({
  id: z.string().min(1),
  endpoint: z.string().url(),
  events: z.array(z.string()).optional(),
  signing_secret: z.string().min(1).optional(),
});
const WebhookListSchema = z.object({ data: z.array(WebhookSchema) });
const DomainListSchema = z.object({
  data: z.array(
    z.object({
      name: z.string().min(1),
      capabilities: z
        .object({
          receiving: z.string(),
          sending: z.string(),
        })
        .optional(),
    }),
  ),
});
const CreatedWebhookSchema = z.object({
  id: z.string().min(1),
  signing_secret: z.string().min(1),
});
const WebhookResponseSchema = z.union([
  CreatedWebhookSchema,
  z.object({ data: CreatedWebhookSchema }),
]);

/** Resend webhook metadata used by guided setup. */
export type ResendWebhook = z.infer<typeof WebhookSchema>;

export interface ResendApiDeps {
  fetch: typeof fetch;
}

function errorDetail(status: number): string {
  if (status === 401 || status === 403) {
    return "Resend rejected the API key. Use a full-access key and try again.";
  }
  return `Resend returned HTTP ${status}. Check Resend's status and try again.`;
}

async function request(
  apiKey: string,
  path: string,
  init: RequestInit,
  deps: ResendApiDeps,
): Promise<unknown> {
  let response: Response;
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    response = await deps.fetch(`${RESEND_API_ORIGIN}${path}`, {
      ...init,
      headers,
      signal: init.signal,
    });
  } catch {
    throw new Error("Could not reach Resend. Check your network connection and try again.");
  }
  if (!response.ok) throw new Error(errorDetail(response.status));
  if (response.status === 204) return undefined;
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error("Resend returned an invalid response.");
  }
}

/** Validates a key with the bounded webhook-list endpoint. */
export async function validateResendApiKey(
  apiKey: string,
  signal?: AbortSignal,
  deps: ResendApiDeps = { fetch },
): Promise<void> {
  WebhookListSchema.parse(await request(apiKey, "/webhooks", { method: "GET", signal }, deps));
}

/** Suggests an agent address on a receiving-enabled Resend domain. */
export async function suggestResendFromAddress(
  apiKey: string,
  signal?: AbortSignal,
  deps: ResendApiDeps = { fetch },
): Promise<string | undefined> {
  const parsed = DomainListSchema.safeParse(
    await request(apiKey, "/domains", { method: "GET", signal }, deps),
  );
  if (!parsed.success) throw new Error("Resend returned an invalid domain list.");
  const receivingDomains = parsed.data.data.filter(
    (domain) =>
      domain.capabilities?.receiving === "enabled" && domain.capabilities.sending === "enabled",
  );
  const domain = receivingDomains.find((candidate) => !candidate.name.endsWith(".resend.app"));
  return domain === undefined ? undefined : `eve@${domain.name}`;
}

/** Lists account webhooks without exposing credentials in request URLs. */
export async function listResendWebhooks(
  apiKey: string,
  signal?: AbortSignal,
  deps: ResendApiDeps = { fetch },
): Promise<ResendWebhook[]> {
  const parsed = WebhookListSchema.safeParse(
    await request(apiKey, "/webhooks", { method: "GET", signal }, deps),
  );
  if (!parsed.success) throw new Error("Resend returned an invalid webhook list.");
  return parsed.data.data;
}

/** Creates an email.received webhook. */
export async function createResendWebhook(
  apiKey: string,
  endpoint: string,
  signal?: AbortSignal,
  deps: ResendApiDeps = { fetch },
): Promise<ResendWebhook> {
  const parsed = WebhookResponseSchema.safeParse(
    await request(
      apiKey,
      "/webhooks",
      { method: "POST", body: JSON.stringify({ endpoint, events: ["email.received"] }), signal },
      deps,
    ),
  );
  if (!parsed.success) throw new Error("Resend returned an invalid webhook response.");
  const created = "data" in parsed.data ? parsed.data.data : parsed.data;
  return {
    id: created.id,
    endpoint,
    events: ["email.received"],
    signing_secret: created.signing_secret,
  };
}

/** Deletes one setup-owned webhook by id. */
export async function deleteResendWebhook(
  apiKey: string,
  webhookId: string,
  signal?: AbortSignal,
  deps: ResendApiDeps = { fetch },
): Promise<void> {
  await request(
    apiKey,
    `/webhooks/${encodeURIComponent(webhookId)}`,
    { method: "DELETE", signal },
    deps,
  );
}

/** Compares webhook endpoints after URL normalization. */
export function sameResendEndpoint(left: string, right: string): boolean {
  try {
    const normalize = (value: string) => {
      const url = new URL(value);
      url.hash = "";
      if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
      return url.href;
    };
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}
