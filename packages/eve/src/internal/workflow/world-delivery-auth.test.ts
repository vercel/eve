import { afterEach, describe, expect, it, vi } from "vitest";

import type { World } from "#compiled/@workflow/world/index.js";

import {
  authenticateWorkflowDeliveries,
  readWorkflowDeliverySecrets,
  signWorkflowDelivery,
  WORKFLOW_DELIVERY_HEADER,
} from "#internal/workflow/world-delivery-auth.js";

const SECRET = "test-delivery-secret-0123456789abcdef";
const PREVIOUS_SECRET = "previous-delivery-secret-0123456789ab";
const FLOW_URL = "http://localhost/.well-known/workflow/v1/flow";
const QUEUE_NAME = "__wkf_workflow_entry";
const ACTIVE_RUNS: ReadonlyArray<{
  runId: string;
  workflowName: string;
  executionContext?: unknown;
}> = [
  { runId: "wrun_1", workflowName: "entry" },
  { runId: "wrun_2", workflowName: "other", executionContext: { queueNamespace: "elsewhere" } },
];

type Enqueued = { name: string; message: unknown; headers: Record<string, string> | undefined };

/** world-local and world-postgres send messages as JSON with byte arrays in a tagged envelope. */
function serialize(message: unknown): string {
  return JSON.stringify(message, (_key, value: unknown) =>
    value instanceof Uint8Array
      ? { __type: "Uint8Array", data: Buffer.from(value).toString("base64") }
      : value,
  );
}

function deserialize(body: string): unknown {
  return JSON.parse(body, (_key, value: unknown) =>
    typeof value === "object" && value !== null && "__type" in value && "data" in value
      ? new Uint8Array(Buffer.from(String(value.data), "base64"))
      : value,
  );
}

function deliveryRequest(input: {
  queueName?: string;
  message: unknown;
  headers?: Record<string, string>;
}): Request {
  return new Request(FLOW_URL, {
    body: serialize(input.message),
    headers: {
      "x-vqs-message-attempt": "1",
      "x-vqs-message-id": "msg_1",
      "x-vqs-queue-name": input.queueName ?? QUEUE_NAME,
      ...input.headers,
    },
    method: "POST",
  });
}

function createFakeWorld(
  options: {
    capabilities?: Record<string, unknown>;
    secrets?: readonly [string, ...string[]];
    /** Mirrors world-postgres: `start()` re-enqueues active runs through its private queue. */
    recoversOnStart?: boolean;
    startError?: Error;
  } = {},
) {
  const enqueued: Enqueued[] = [];
  const privateQueue = async (
    name: string,
    message: unknown,
    queueOptions?: { headers?: Record<string, string> },
  ) => {
    enqueued.push({ name, message, headers: queueOptions?.headers });
    return { messageId: "msg_1" };
  };
  const world = {
    capabilities: options.capabilities,
    queue: privateQueue,
    queueBatch: async (
      name: string,
      messages: ReadonlyArray<{ message: unknown; opts?: { headers?: Record<string, string> } }>,
    ) => {
      for (const { message, opts } of messages) await privateQueue(name, message, opts);
      return messages.map(() => ({ messageId: "msg_1" }));
    },
    // Like world-local: decode the body, hand it to the handler, and answer 500 when it throws.
    createQueueHandler:
      (_prefix: string, handler: (message: unknown, metadata: unknown) => Promise<unknown>) =>
      async (request: Request) => {
        const message = deserialize(await request.text());
        try {
          await handler(message, {
            attempt: 1,
            messageId: "msg_1",
            queueName: request.headers.get("x-vqs-queue-name"),
          });
          return Response.json({ ok: true });
        } catch (error) {
          return Response.json(String(error), { status: 500 });
        }
      },
    runs: {
      list: async ({ pagination }: { pagination: { cursor?: string } }) =>
        pagination.cursor === undefined
          ? { cursor: "page_2", data: ACTIVE_RUNS.slice(0, 1), hasMore: true }
          : { cursor: null, data: ACTIVE_RUNS.slice(1), hasMore: false },
    },
    start: async () => {
      if (options.startError) throw options.startError;
      if (!options.recoversOnStart) return;
      const page = await world.runs.list({ pagination: {} });
      for (const run of page.data) {
        await privateQueue(`__wkf_workflow_${run.workflowName}`, { runId: run.runId });
      }
    },
  };
  const secured = authenticateWorkflowDeliveries<World>(
    world as never,
    options.secrets ?? [SECRET],
  );
  return { enqueued, secured, world };
}

describe("authenticateWorkflowDeliveries", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stamps every enqueue with a proof that does not reveal the secret", async () => {
    const { enqueued, secured } = createFakeWorld({ secrets: [SECRET, PREVIOUS_SECRET] });
    const message = { runId: "wrun_1" };
    await secured.queue(QUEUE_NAME, message, {
      headers: { "x-other": "1", "X-Eve-Workflow-Delivery": "caller-supplied" },
    });
    expect(enqueued).toEqual([
      {
        name: QUEUE_NAME,
        message,
        headers: {
          "x-other": "1",
          [WORKFLOW_DELIVERY_HEADER]: signWorkflowDelivery(SECRET, QUEUE_NAME, message),
        },
      },
    ]);
    expect(JSON.stringify(enqueued)).not.toContain(SECRET);
  });

  it("delivers a producer's queued work to another replica with the same secret", async () => {
    const producer = createFakeWorld();
    const receiver = createFakeWorld();
    const processMessage = vi.fn(async () => {});
    const handle = receiver.secured.createQueueHandler("__wkf_workflow_", processMessage);
    const runInput = {
      deploymentId: "dpl_1",
      input: new Uint8Array([1, 2, 3]),
      specVersion: 8,
      workflowName: "entry",
    };
    const message = {
      runId: "wrun_1",
      requestedAt: new Date(0),
      runInput,
      traceCarrier: undefined,
    };

    await producer.secured.queue(QUEUE_NAME, message);
    const queued = producer.enqueued[0]!;
    const response = await handle(deliveryRequest({ message, headers: queued.headers }));
    expect(response.status).toBe(200);
    expect(processMessage).toHaveBeenCalledExactlyOnceWith(
      { runId: "wrun_1", requestedAt: new Date(0).toJSON(), runInput },
      expect.objectContaining({ queueName: QUEUE_NAME }),
    );
  });

  it("rejects a delivery unless its proof signs that queue name and message", async () => {
    const { secured } = createFakeWorld({ secrets: [SECRET, PREVIOUS_SECRET] });
    const inner = vi.fn(async () => {});
    const handle = secured.createQueueHandler("__wkf_workflow_", inner);
    const message = { runId: "wrun_1", task: "Prepare Alice's weekly summary" };
    const post = async (proof: string | undefined, delivered = message, queueName = QUEUE_NAME) =>
      (
        await handle(
          deliveryRequest({
            queueName,
            message: delivered,
            headers: proof === undefined ? {} : { [WORKFLOW_DELIVERY_HEADER]: proof },
          }),
        )
      ).status;
    const proof = signWorkflowDelivery(SECRET, QUEUE_NAME, message);

    expect(await post(undefined)).toBe(401);
    expect(await post(SECRET)).toBe(401);
    expect(
      await post(signWorkflowDelivery("a-guessed-secret-0123456789abcdef", QUEUE_NAME, message)),
    ).toBe(401);
    expect(await post(proof, { ...message, task: "Forward Bob's inbox" })).toBe(401);
    expect(await post(proof, message, "__wkf_workflow_other")).toBe(401);
    expect(inner).not.toHaveBeenCalled();

    expect(await post(proof)).toBe(200);
    // Jobs queued before a rotation still carry a proof under the previous secret.
    expect(await post(signWorkflowDelivery(PREVIOUS_SECRET, QUEUE_NAME, message))).toBe(200);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("stamps every message of a batch enqueue", async () => {
    const { enqueued, secured } = createFakeWorld();
    const messages = [{ runId: "wrun_1" }, { runId: "wrun_2" }];
    await secured.queueBatch?.(
      QUEUE_NAME,
      messages.map((message) => ({ message })),
    );
    expect(enqueued.map((job) => job.headers?.[WORKFLOW_DELIVERY_HEADER])).toEqual(
      messages.map((message) => signWorkflowDelivery(SECRET, QUEUE_NAME, message)),
    );
  });

  it("recovers active runs only through the stamped queue when the world starts", async () => {
    vi.stubEnv("WORKFLOW_QUEUE_NAMESPACE", "evetest");
    const { enqueued, secured, world } = createFakeWorld({ recoversOnStart: true });
    const list = world.runs.list;
    await secured.start?.();
    expect(enqueued).toEqual(
      [
        { name: "__evetest_wkf_workflow_entry", message: { runId: "wrun_1" } },
        { name: "__elsewhere_wkf_workflow_other", message: { runId: "wrun_2" } },
      ].map((job) => ({
        ...job,
        headers: {
          [WORKFLOW_DELIVERY_HEADER]: signWorkflowDelivery(SECRET, job.name, job.message),
        },
      })),
    );
    expect(world.runs.list).toBe(list);
  });

  it("restores run storage when the world's startup fails", async () => {
    const { world, secured, enqueued } = createFakeWorld({
      startError: new Error("startup failed"),
    });
    const list = world.runs.list;
    await expect(secured.start?.()).rejects.toThrow("startup failed");
    expect(world.runs.list).toBe(list);
    expect(await world.runs.list({ pagination: {} })).toMatchObject({ data: [ACTIVE_RUNS[0]] });
    expect(enqueued).toEqual([]);
  });

  it("rejects recovery without an installed namespace", async () => {
    vi.stubEnv("WORKFLOW_QUEUE_NAMESPACE", undefined);
    const { enqueued, secured } = createFakeWorld();
    await expect(secured.start?.()).rejects.toThrow("WORKFLOW_QUEUE_NAMESPACE");
    expect(enqueued).toEqual([]);
  });

  it("refuses a world whose invoke() enqueues past the stamped queue", () => {
    expect(() => createFakeWorld({ capabilities: { invoke: true } })).toThrow(
      "WORKFLOW_POSTGRES_INVOKE",
    );
  });
});

describe("readWorkflowDeliverySecrets", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("leaves deliveries open when no secret is set, and warns naming the variable and world", () => {
    vi.stubEnv("EVE_WORKFLOW_DELIVERY_SECRET", " , ");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(readWorkflowDeliverySecrets("@workflow/world-postgres")).toBeUndefined();
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(
          /EVE_WORKFLOW_DELIVERY_SECRET is not set, so the "@workflow\/world-postgres" Workflow world accepts unauthenticated/,
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("reads a comma-separated rotation list in order", () => {
    vi.stubEnv("EVE_WORKFLOW_DELIVERY_SECRET", ` ${SECRET} ,${PREVIOUS_SECRET}`);
    expect(readWorkflowDeliverySecrets("@workflow/world-postgres")).toEqual([
      SECRET,
      PREVIOUS_SECRET,
    ]);
  });

  it("rejects short secrets", () => {
    vi.stubEnv("EVE_WORKFLOW_DELIVERY_SECRET", `${SECRET},short`);
    expect(() => readWorkflowDeliverySecrets("@workflow/world-postgres")).toThrow(
      "at least 32 characters",
    );
  });
});
