import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authenticateLocalWorkflowDeliveries,
  LOCAL_WORKFLOW_DELIVERY_HEADER,
} from "#internal/workflow/local-world-delivery-auth.js";

const SECRET = "test-delivery-secret-0123456789";
const FLOW_URL = "http://localhost/.well-known/workflow/v1/flow";
const QUEUE_HEADERS = {
  "x-vqs-message-attempt": "1",
  "x-vqs-message-id": "msg_1",
  "x-vqs-queue-name": "__wkf_workflow_entry",
};

function createFakeWorld() {
  const enqueued: Array<{
    name: string;
    message: unknown;
    headers: Record<string, string> | undefined;
  }> = [];
  const start = vi.fn(async () => {});
  const world = {
    queue: async (
      name: string,
      message: unknown,
      options?: { headers?: Record<string, string> },
    ) => {
      enqueued.push({ name, message, headers: options?.headers });
      return { messageId: "msg_1" };
    },
    createQueueHandler:
      (_prefix: string, handler: (message: unknown) => Promise<void>) =>
      async (request: Request) => {
        await handler(await request.json());
        return Response.json({ ok: true });
      },
    runs: {
      list: vi.fn(async ({ pagination }: { pagination: { cursor?: string } }) =>
        pagination.cursor === undefined
          ? {
              cursor: "page_2",
              data: [{ runId: "wrun_1", workflowName: "entry" }],
              hasMore: true,
            }
          : {
              cursor: null,
              data: [{ runId: "wrun_2", workflowName: "other" }],
              hasMore: false,
            },
      ),
    },
    start,
  };
  const secured = authenticateLocalWorkflowDeliveries(world as never, SECRET);
  return { enqueued, secured, start, listRuns: world.runs.list };
}

describe("authenticateLocalWorkflowDeliveries", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stamps every enqueue and keeps the caller's headers", async () => {
    const { enqueued, secured } = createFakeWorld();
    await secured.queue("__wkf_workflow_entry" as never, { runId: "wrun_1" } as never, {
      headers: { "x-other": "1" },
    });
    expect(enqueued).toEqual([
      {
        name: "__wkf_workflow_entry",
        message: { runId: "wrun_1" },
        headers: { "x-other": "1", [LOCAL_WORKFLOW_DELIVERY_HEADER]: SECRET },
      },
    ]);
  });

  it("rejects a forged delivery before the handler sees its message", async () => {
    const { secured } = createFakeWorld();
    const inner = vi.fn(async () => {});
    const handle = secured.createQueueHandler("__wkf_workflow_" as never, inner as never);
    const body = JSON.stringify({
      runInput: {
        input: [
          {
            serializedContext: {
              "eve.auth": { principalId: "victim", principalType: "user" },
            },
          },
        ],
      },
    });
    const post = (headers: Record<string, string>) =>
      handle(new Request(FLOW_URL, { body, headers, method: "POST" }));

    expect((await post(QUEUE_HEADERS)).status).toBe(401);
    expect(
      (await post({ ...QUEUE_HEADERS, [LOCAL_WORKFLOW_DELIVERY_HEADER]: "guess" })).status,
    ).toBe(401);
    expect(inner).not.toHaveBeenCalled();

    const trusted = await post({ ...QUEUE_HEADERS, [LOCAL_WORKFLOW_DELIVERY_HEADER]: SECRET });
    expect(trusted.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("re-enqueues active runs through the stamped queue when the world starts", async () => {
    vi.stubEnv("WORKFLOW_QUEUE_NAMESPACE", "evetest");
    const { enqueued, secured, start, listRuns } = createFakeWorld();
    await secured.start?.();
    expect(start).toHaveBeenCalledTimes(1);
    expect(enqueued).toEqual([
      {
        name: "__evetest_wkf_workflow_entry",
        message: { runId: "wrun_1" },
        headers: { [LOCAL_WORKFLOW_DELIVERY_HEADER]: SECRET },
      },
      {
        name: "__evetest_wkf_workflow_other",
        message: { runId: "wrun_2" },
        headers: { [LOCAL_WORKFLOW_DELIVERY_HEADER]: SECRET },
      },
    ]);
    expect(listRuns.mock.calls).toEqual([
      [{ pagination: { cursor: undefined }, resolveData: "none", status: ["pending", "running"] }],
      [{ pagination: { cursor: "page_2" }, resolveData: "none", status: ["pending", "running"] }],
    ]);
  });

  it("rejects recovery without an installed namespace", async () => {
    vi.stubEnv("WORKFLOW_QUEUE_NAMESPACE", undefined);
    const { enqueued, secured } = createFakeWorld();
    await expect(secured.start?.()).rejects.toThrow("WORKFLOW_QUEUE_NAMESPACE");
    expect(enqueued).toEqual([]);
  });
});
