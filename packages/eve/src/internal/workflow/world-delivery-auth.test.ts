import { afterEach, describe, expect, it, vi } from "vitest";

import type { World } from "#compiled/@workflow/world/index.js";

import {
  authenticateWorkflowDeliveries,
  readWorkflowDeliverySecrets,
  WORKFLOW_DELIVERY_HEADER,
} from "#internal/workflow/world-delivery-auth.js";

const SECRET = "test-delivery-secret-0123456789abcdef";
const PREVIOUS_SECRET = "previous-delivery-secret-0123456789ab";
const FLOW_URL = "http://localhost/.well-known/workflow/v1/flow";
const QUEUE_HEADERS = {
  "x-vqs-message-attempt": "1",
  "x-vqs-message-id": "msg_1",
  "x-vqs-queue-name": "__wkf_workflow_entry",
};
const ACTIVE_RUNS: ReadonlyArray<{
  runId: string;
  workflowName: string;
  executionContext?: unknown;
}> = [
  { runId: "wrun_1", workflowName: "entry" },
  { runId: "wrun_2", workflowName: "other", executionContext: { queueNamespace: "elsewhere" } },
];

type Enqueued = { name: string; message: unknown; headers: Record<string, string> | undefined };

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
    createQueueHandler:
      (_prefix: string, handler: (message: unknown) => Promise<void>) =>
      async (request: Request) => {
        await handler(await request.json());
        return Response.json({ ok: true });
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

  it("stamps every enqueue with the first secret and keeps the caller's headers", async () => {
    const { enqueued, secured } = createFakeWorld({ secrets: [SECRET, PREVIOUS_SECRET] });
    await secured.queue("__wkf_workflow_entry" as never, { runId: "wrun_1" } as never, {
      headers: { "x-other": "1", "X-Eve-Workflow-Delivery": PREVIOUS_SECRET },
    });
    expect(enqueued).toEqual([
      {
        name: "__wkf_workflow_entry",
        message: { runId: "wrun_1" },
        headers: { "x-other": "1", [WORKFLOW_DELIVERY_HEADER]: SECRET },
      },
    ]);
  });

  it("rejects unauthenticated deliveries and accepts both rotation secrets", async () => {
    const { secured } = createFakeWorld({ secrets: [SECRET, PREVIOUS_SECRET] });
    const inner = vi.fn(async () => {});
    const handle = secured.createQueueHandler("__wkf_workflow_" as never, inner as never);
    const body = JSON.stringify({ task: "Prepare Alice's weekly summary" });
    const post = (headers: Record<string, string>) =>
      handle(new Request(FLOW_URL, { body, headers, method: "POST" }));

    expect((await post(QUEUE_HEADERS)).status).toBe(401);
    expect((await post({ ...QUEUE_HEADERS, [WORKFLOW_DELIVERY_HEADER]: "guess" })).status).toBe(
      401,
    );
    expect(inner).not.toHaveBeenCalled();

    expect((await post({ ...QUEUE_HEADERS, [WORKFLOW_DELIVERY_HEADER]: SECRET })).status).toBe(200);
    // Jobs queued before a rotation still carry the previous secret.
    expect(
      (await post({ ...QUEUE_HEADERS, [WORKFLOW_DELIVERY_HEADER]: PREVIOUS_SECRET })).status,
    ).toBe(200);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("recovers active runs only through the stamped queue when the world starts", async () => {
    vi.stubEnv("WORKFLOW_QUEUE_NAMESPACE", "evetest");
    const { enqueued, secured, world } = createFakeWorld({ recoversOnStart: true });
    const list = world.runs.list;
    await secured.start?.();
    expect(enqueued).toEqual([
      {
        name: "__evetest_wkf_workflow_entry",
        message: { runId: "wrun_1" },
        headers: { [WORKFLOW_DELIVERY_HEADER]: SECRET },
      },
      {
        name: "__elsewhere_wkf_workflow_other",
        message: { runId: "wrun_2" },
        headers: { [WORKFLOW_DELIVERY_HEADER]: SECRET },
      },
    ]);
    expect(world.runs.list).toBe(list);
  });

  it("delivers a producer's queued work to another replica with the same secret", async () => {
    const producer = createFakeWorld();
    const receiver = createFakeWorld();
    const processMessage = vi.fn(async () => {});
    const handle = receiver.secured.createQueueHandler("__wkf_workflow_", processMessage);
    const message = { runId: "wrun_1" };

    await producer.secured.queue("__wkf_workflow_entry", message);
    const queued = producer.enqueued[0]!;
    const response = await handle(
      new Request(FLOW_URL, {
        method: "POST",
        body: JSON.stringify(queued.message),
        headers: { ...QUEUE_HEADERS, ...queued.headers },
      }),
    );
    expect(response.status).toBe(200);
    expect(processMessage).toHaveBeenCalledExactlyOnceWith(message);
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

  it("names the variable and the world when the secret is missing", () => {
    vi.stubEnv("EVE_WORKFLOW_DELIVERY_SECRET", " , ");
    expect(() => readWorkflowDeliverySecrets("@workflow/world-postgres")).toThrow(
      /EVE_WORKFLOW_DELIVERY_SECRET is not set\. The "@workflow\/world-postgres" Workflow world/,
    );
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
