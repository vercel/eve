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

function createFakeWorld(options: { releaseFails?: string } = {}) {
  const enqueued: Array<{
    name: string;
    message: unknown;
    headers: Record<string, string> | undefined;
  }> = [];
  const recovery: string[] = [];
  const start = vi.fn(async () => {});
  const world = {
    queue: async (
      name: string,
      message: unknown,
      options?: { headers?: Record<string, string> },
    ) => {
      enqueued.push({ name, message, headers: options?.headers });
      recovery.push(`enqueue ${(message as { runId: string }).runId}`);
      return { messageId: "msg_1" };
    },
    releaseOrphanedSteps: async (runId: string) => {
      if (runId === options.releaseFails) throw new Error("step listing failed");
      recovery.push(`release ${runId}`);
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
              data: [{ runId: "wrun_1", specVersion: 9, workflowName: "entry" }],
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
  return { enqueued, recovery, secured, start, listRuns: world.runs.list };
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
    const { enqueued, recovery, secured, start, listRuns } = createFakeWorld();
    await secured.start?.();
    expect(start).toHaveBeenCalledTimes(1);
    // A run enqueued before its release would defer to the dead process's steps.
    expect(recovery).toEqual([
      "release wrun_1",
      "enqueue wrun_1",
      "release wrun_2",
      "enqueue wrun_2",
    ]);
    expect(enqueued).toEqual([
      {
        name: "__evetest_wkf_workflow_entry",
        // The local queue lost the run's step messages and wait timers.
        message: { runId: "wrun_1", runSpecVersion: 9, recovery: true },
        headers: { [LOCAL_WORKFLOW_DELIVERY_HEADER]: SECRET },
      },
      {
        name: "__evetest_wkf_workflow_other",
        message: { runId: "wrun_2", recovery: true },
        headers: { [LOCAL_WORKFLOW_DELIVERY_HEADER]: SECRET },
      },
    ]);
    expect(listRuns.mock.calls).toEqual([
      [{ pagination: { cursor: undefined }, resolveData: "none", status: ["pending", "running"] }],
      [{ pagination: { cursor: "page_2" }, resolveData: "none", status: ["pending", "running"] }],
    ]);
  });

  it("still re-enqueues a run whose orphaned steps fail to release", async () => {
    vi.stubEnv("WORKFLOW_QUEUE_NAMESPACE", "evetest");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { recovery, secured } = createFakeWorld({ releaseFails: "wrun_1" });
      await secured.start?.();
      expect(recovery).toEqual(["enqueue wrun_1", "release wrun_2", "enqueue wrun_2"]);
      expect(warn).toHaveBeenCalledWith(
        "[eve] Failed to release orphaned steps of workflow run wrun_1:",
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects recovery without an installed namespace", async () => {
    vi.stubEnv("WORKFLOW_QUEUE_NAMESPACE", undefined);
    const { enqueued, secured } = createFakeWorld();
    await expect(secured.start?.()).rejects.toThrow("WORKFLOW_QUEUE_NAMESPACE");
    expect(enqueued).toEqual([]);
  });
});
