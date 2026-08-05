import { z } from "zod";

const WebhookSchema = z.object({
  id: z.string().min(1),
  endpoint: z.string().url(),
});
const WebhookListSchema = z.object({ data: z.array(WebhookSchema) });
const CreatedWebhookSchema = z.union([
  z.object({ id: z.string().min(1), signing_secret: z.string().min(1) }),
  z.object({
    data: z.object({ id: z.string().min(1), signing_secret: z.string().min(1) }),
  }),
]);

/** Newly created Resend webhook plus exact-match webhooks it supersedes. */
export interface MarketplaceWebhookReconciliation {
  id: string;
  signingSecret: string;
  previousIds: string[];
}

export interface MarketplaceWebhookDeps {
  fetch: typeof fetch;
}

const defaultDeps: MarketplaceWebhookDeps = { fetch };

async function request(
  accessToken: string,
  path: string,
  init: RequestInit,
  deps: MarketplaceWebhookDeps,
): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await deps.fetch(`https://api.resend.com${path}`, { ...init, headers });
  } catch {
    throw new Error("Could not reach Resend while configuring the webhook.");
  }
  if (!response.ok) {
    throw new Error(`Resend webhook request failed with HTTP ${response.status}.`);
  }
  if (response.status === 204) return undefined;
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error("Resend returned an invalid webhook response.");
  }
}

function normalizedEndpoint(value: string): string {
  const url = new URL(value);
  url.hash = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.href;
}

/** Creates a replacement webhook with a temporary Resend OAuth token. */
export async function reconcileMarketplaceResendWebhook(input: {
  accessToken: string;
  endpoint: string;
  signal?: AbortSignal;
  deps?: MarketplaceWebhookDeps;
}): Promise<MarketplaceWebhookReconciliation> {
  const deps = input.deps ?? defaultDeps;
  const listed = WebhookListSchema.safeParse(
    await request(input.accessToken, "/webhooks", { method: "GET", signal: input.signal }, deps),
  );
  if (!listed.success) throw new Error("Resend returned an invalid webhook list.");
  const previousIds = listed.data.data
    .filter(
      (webhook) => normalizedEndpoint(webhook.endpoint) === normalizedEndpoint(input.endpoint),
    )
    .map((webhook) => webhook.id);
  const createdResult = CreatedWebhookSchema.safeParse(
    await request(
      input.accessToken,
      "/webhooks",
      {
        method: "POST",
        body: JSON.stringify({ endpoint: input.endpoint, events: ["email.received"] }),
        signal: input.signal,
      },
      deps,
    ),
  );
  if (!createdResult.success) throw new Error("Resend returned an invalid created webhook.");
  const created = "data" in createdResult.data ? createdResult.data.data : createdResult.data;
  return { id: created.id, signingSecret: created.signing_secret, previousIds };
}

/** Deletes webhooks with a temporary Resend OAuth token. */
export async function deleteMarketplaceResendWebhooks(input: {
  accessToken: string;
  ids: readonly string[];
  signal?: AbortSignal;
  deps?: MarketplaceWebhookDeps;
}): Promise<void> {
  const deps = input.deps ?? defaultDeps;
  for (const id of input.ids) {
    await request(
      input.accessToken,
      `/webhooks/${encodeURIComponent(id)}`,
      { method: "DELETE", signal: input.signal },
      deps,
    );
  }
}
