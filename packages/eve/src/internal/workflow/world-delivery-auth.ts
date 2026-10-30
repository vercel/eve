import { createHmac, randomBytes } from "node:crypto";

import type { QueueOptions, ValidQueueName, World } from "#compiled/@workflow/world/index.js";
import { timingSafeEqualStrings } from "#internal/nitro/dev-client-address.js";
import {
  workflowQueuePrefix,
  WORKFLOW_QUEUE_NAMESPACE_ENV,
} from "#internal/workflow/queue-namespace.js";

export const WORKFLOW_DELIVERY_HEADER = "x-eve-workflow-delivery";
export const WORKFLOW_DELIVERY_SECRET_ENV = "EVE_WORKFLOW_DELIVERY_SECRET";

const MIN_WORKFLOW_DELIVERY_SECRET_LENGTH = 32;
const DELIVERY_SECRET_DOCS_URL =
  "https://eve.dev/docs/guides/deployment/self-hosting#authenticate-workflow-deliveries";

export type WorkflowDeliverySecrets = readonly [string, ...string[]];

const DELIVERY_PROOF_PREFIX = "v1.";

/**
 * Signs one queued message. Worlds round-trip messages through JSON-like
 * transports, so the MAC covers a canonical JSON form: sorted keys, `toJSON`
 * applied, and byte arrays in base64, which encodes the enqueued and the
 * delivered message identically.
 */
export function signWorkflowDelivery(secret: string, queueName: string, message: unknown): string {
  return signCanonicalMessage(secret, queueName, canonicalMessageJson(message));
}

function signCanonicalMessage(secret: string, queueName: string, canonicalMessage: string): string {
  const mac = createHmac("sha256", secret)
    .update(queueName)
    .update("\n")
    .update(canonicalMessage)
    .digest("base64url");
  return `${DELIVERY_PROOF_PREFIX}${mac}`;
}

function canonicalMessageJson(message: unknown): string {
  return (
    JSON.stringify(message, (_key, value: unknown) => {
      if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString("base64") };
      if (typeof value === "bigint") return value.toString();
      if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }) ?? ""
  );
}

function untrustedDeliveryResponse(): Response {
  return Response.json({ error: "Untrusted workflow delivery." }, { status: 401 });
}

/** Creates a random per-process delivery secret. */
export function createWorkflowDeliverySecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Reads the shared delivery secrets for a World whose queue can deliver to
 * any replica, or `undefined` when none is configured: authentication is
 * opt-in for these Worlds, and eve warns that their deliveries stay open. A
 * comma-separated value rotates the secret: deliveries are stamped with the
 * first entry and accepted with any entry, so jobs queued under the previous
 * secret still run.
 */
export function readWorkflowDeliverySecrets(
  worldPackage: string,
): WorkflowDeliverySecrets | undefined {
  const secrets = (process.env[WORKFLOW_DELIVERY_SECRET_ENV] ?? "")
    .split(",")
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0);
  const [first, ...rest] = secrets;
  if (first === undefined) {
    console.warn(
      `[eve] ${WORKFLOW_DELIVERY_SECRET_ENV} is not set, so the "${worldPackage}" Workflow world accepts unauthenticated queue deliveries at /.well-known/workflow/v1/flow. Set it to the same random value on every server process, for example the output of \`openssl rand -hex 32\`, or keep that route unreachable from untrusted networks. See ${DELIVERY_SECRET_DOCS_URL}`,
    );
    return undefined;
  }
  if (secrets.some((secret) => secret.length < MIN_WORKFLOW_DELIVERY_SECRET_LENGTH)) {
    throw new Error(
      `Each comma-separated ${WORKFLOW_DELIVERY_SECRET_ENV} entry must be at least ${MIN_WORKFLOW_DELIVERY_SECRET_LENGTH} characters. Generate one with \`openssl rand -hex 32\`. See ${DELIVERY_SECRET_DOCS_URL}`,
    );
  }
  return [first, ...rest];
}

/**
 * Makes the World's flow route accept only deliveries its own queue
 * enqueued. The route is as reachable as the server, and the Worlds trust
 * whatever `x-vqs-*` headers and body arrive, so without a proof any client
 * could forge a delivery, including its run context and principal.
 *
 * Every enqueue is stamped with an HMAC of its queue name and message under
 * the first secret, and the queue handler accepts a MAC under any of them. The proof never contains a secret, because Worlds persist and
 * log job headers: a leaked proof can only replay the message it signs.
 *
 * A World's own startup recovery enqueues past the wrapped queue, unstamped,
 * so `start()` hides active runs from it and recovers them through the
 * stamped queue instead. Worlds that enqueue through `invoke()` also bypass
 * the stamp and are refused.
 *
 * Mutates and returns `world`.
 */
export function authenticateWorkflowDeliveries<TWorld extends World>(
  world: TWorld,
  secrets: WorkflowDeliverySecrets = [createWorkflowDeliverySecret()],
): TWorld {
  if (world.capabilities?.invoke === true) {
    throw new Error(
      "eve cannot authenticate workflow deliveries for a Workflow world with invoke() enabled. For @workflow/world-postgres, unset WORKFLOW_POSTGRES_INVOKE.",
    );
  }
  const [stamp] = secrets;

  const signedOptions = (
    queueName: ValidQueueName,
    message: unknown,
    options: QueueOptions | undefined,
  ): QueueOptions => {
    const headers = new Headers(options?.headers);
    headers.set(WORKFLOW_DELIVERY_HEADER, signWorkflowDelivery(stamp, queueName, message));
    return { ...options, headers: Object.fromEntries(headers) };
  };
  const enqueue = world.queue.bind(world);
  world.queue = async (queueName, message, options) =>
    await enqueue(queueName, message, signedOptions(queueName, message, options));
  const enqueueBatch = world.queueBatch?.bind(world);
  if (enqueueBatch !== undefined) {
    world.queueBatch = async (queueName, messages) =>
      await enqueueBatch(
        queueName,
        messages.map(({ message, opts }) => ({
          message,
          opts: signedOptions(queueName, message, opts),
        })),
      );
  }

  const createQueueHandler = world.createQueueHandler.bind(world);
  world.createQueueHandler = (queueNamePrefix, handler) => async (request) => {
    const proof = request.headers.get(WORKFLOW_DELIVERY_HEADER);
    if (proof === null || !proof.startsWith(DELIVERY_PROOF_PREFIX)) {
      return untrustedDeliveryResponse();
    }
    // The proof covers the message, which only the World can decode, so each
    // delivery gets a handler that checks the message the World hands it.
    let rejected = false;
    const deliver = createQueueHandler(queueNamePrefix, async (message, metadata) => {
      const canonicalMessage = canonicalMessageJson(message);
      const trusted = secrets.some((secret) =>
        timingSafeEqualStrings(
          proof,
          signCanonicalMessage(secret, metadata.queueName, canonicalMessage),
        ),
      );
      if (!trusted) {
        rejected = true;
        throw new Error("Untrusted workflow delivery.");
      }
      return await handler(message, metadata);
    });
    const response = await deliver(request);
    if (!rejected) return response;
    await response.body?.cancel();
    return untrustedDeliveryResponse();
  };

  const start = world.start?.bind(world);
  world.start = async () => {
    await withActiveRunsHidden(world, async () => await start?.());
    await recoverActiveRuns(world);
  };
  return world;
}

/**
 * world-postgres re-enqueues active runs inside `start()` through its private
 * queue and has no option to skip it; those unstamped jobs would fail every
 * delivery. Suppress that recovery until eve can enqueue with a delivery proof.
 */
async function withActiveRunsHidden(world: World, run: () => Promise<void>): Promise<void> {
  const list = world.runs.list;
  world.runs.list = async () => ({ cursor: null, data: [], hasMore: false });
  try {
    await run();
  } finally {
    world.runs.list = list;
  }
}

/**
 * Mirrors `reenqueueActiveRuns` from `@workflow/world`, whose vendored copy
 * here is types only, but through the stamped `world.queue`. Like it, each
 * run goes back to the namespace it recorded, so agents sharing one database
 * recover only into their own consumers.
 */
async function recoverActiveRuns(world: World): Promise<void> {
  const namespace = process.env[WORKFLOW_QUEUE_NAMESPACE_ENV];
  if (!namespace) {
    throw new Error(`${WORKFLOW_QUEUE_NAMESPACE_ENV} must be installed before workflow recovery.`);
  }
  let cursor: string | undefined;
  do {
    const page = await world.runs.list({
      pagination: { cursor },
      resolveData: "none",
      status: ["pending", "running"],
    });
    for (const run of page.data) {
      const prefix = workflowQueuePrefix(recordedQueueNamespace(run.executionContext) ?? namespace);
      try {
        await world.queue(`${prefix}${run.workflowName}` as ValidQueueName, { runId: run.runId });
      } catch (error) {
        console.warn(`[eve] Failed to re-enqueue workflow run ${run.runId}:`, error);
      }
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
}

function recordedQueueNamespace(executionContext: unknown): string | undefined {
  if (typeof executionContext !== "object" || executionContext === null) return undefined;
  const namespace = (executionContext as { queueNamespace?: unknown }).queueNamespace;
  return typeof namespace === "string" && /^[a-z][a-z0-9]*$/.test(namespace)
    ? namespace
    : undefined;
}
