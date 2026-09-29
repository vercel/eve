import { describe, expect, it, vi } from "vitest";
import { hydrateStepReturnValue } from "@workflow/core/serialization";
import { slackChannel } from "#public/channels/slack/slackChannel.js";
import type { CompiledChannel } from "#channel/compiled-channel.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { workflowEntry } from "#execution/session/entry.js";
import { runObservationWorkflow } from "#execution/run-observation/workflow.js";
import { getHookByToken, getRun, getWorld, start } from "#internal/workflow/runtime.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { decodeSlackApiBody } from "#internal/testing/slack-api-body.js";
import { runObservationSourceWorkflow } from "#internal/testing/run-observation-source-workflow.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { defineTool } from "#tools/definition.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Slack run observation", () => {
  it("rejects unsupported fixture tools and interactive capability at session admission", async () => {
    for (const hasAuthoredTool of [false, true]) {
      const channel = slackChannel({ experimental: { runObservation: true } });
      const adapter = (channel as CompiledChannel).adapter;
      Object.assign(adapter.state!, { channelId: "C1", threadTs: "100.100" });
      const runtime = await createTestRuntime({
        agent: { name: `observation-admission-${hasAuthoredTool}` },
        modules: [
          { logicalPath: "channels/slack.ts", loadNamespace: async () => ({ default: channel }) },
          ...(hasAuthoredTool
            ? [
                {
                  logicalPath: "tools/needs_review.ts",
                  loadNamespace: async () => ({
                    default: defineTool({
                      description: "An authored tool requiring interaction",
                      inputSchema: {},
                      execute: () => ({ ok: true }),
                    }),
                  }),
                },
              ]
            : []),
        ],
      });
      await runtime.run(async () => {
        const sessionRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        await expect(
          sessionRuntime.createSession({
            adapter,
            auth: null,
            capabilities: { requestInput: !hasAuthoredTool },
            input: { message: "Alice asks for a summary." },
          }),
        ).rejects.toThrow(/fixture requires requestInput disabled, plain-text input/);
        if (!hasAuthoredTool) {
          await expect(
            sessionRuntime.createSession({
              adapter,
              auth: null,
              input: { message: "Alice asks for a summary." },
            }),
          ).rejects.toThrow(/requestInput disabled/);
          await expect(
            sessionRuntime.createSession({
              adapter,
              auth: null,
              capabilities: { requestInput: false },
              input: { message: [{ type: "text", text: "Alice includes a file." }] },
            }),
          ).rejects.toThrow(/plain-text input/);
        }
      });
    }
  });

  it("posts a completed reply from a parked session without producer-side posts", async () => {
    const requests: { method: string; body: string }[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1) ?? "";
      requests.push({ method, body: String(init?.body ?? "") });
      if (method === "chat.postMessage") return Response.json({ ok: true, ts: "123.456" });
      return Response.json({ ok: true });
    });
    await withParkedObservation(fetcher, async (runId) => {
      const deadline = Date.now() + 12_000;
      while (!requests.some(({ method }) => method === "chat.postMessage") && Date.now() < deadline)
        await delay(50);
      expect(requests.filter(({ method }) => method === "chat.postMessage")).toHaveLength(1);
      expect(requests.find(({ method }) => method === "chat.postMessage")?.body).toContain(
        "eve_observation",
      );
      const hook = await getHookByToken(`eve:run-observation:v1:${runId}`);
      expect(hook.runId).not.toBe(runId);
      const parentSteps = await (
        await getWorld()
      ).steps.list({ runId, resolveData: "none", pagination: { limit: 1000 } });
      expect(
        parentSteps.data.some(
          (step) =>
            step.stepName.includes("applyObservationDeliveryStep") ||
            step.stepName.includes("readLocalObservationPage"),
        ),
      ).toBe(false);
    });
  }, 30_000);

  it("recovers an accepted create after the Workflow effect step retries", async () => {
    const requests: string[] = [];
    let accepted: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1) ?? "";
      requests.push(method);
      if (method === "chat.postMessage") {
        accepted = decodeSlackApiBody(
          init?.body,
          new Headers(init?.headers).get("content-type"),
        ) as Record<string, unknown>;
        throw new TypeError("The provider accepted the create but the response was lost.");
      }
      if (method === "conversations.replies") {
        const metadata = accepted?.metadata;
        return Response.json({
          ok: true,
          messages: [{ ts: "123.456", text: "stale provider text", metadata }],
        });
      }
      if (method === "chat.update") return Response.json({ ok: true, ts: "123.456" });
      return Response.json({ ok: true });
    });
    await withParkedObservation(fetcher, async (runId) => {
      const deadline = Date.now() + 20_000;
      while (!requests.includes("chat.update") && Date.now() < deadline) await delay(50);
      expect(requests.filter((method) => method === "chat.postMessage")).toHaveLength(1);
      expect(requests).toContain("conversations.replies");
      expect(requests).toContain("chat.update");
      const hook = await getHookByToken(`eve:run-observation:v1:${runId}`);
      const events = await (
        await getWorld()
      ).events.list({
        runId: hook.runId,
        resolveData: "none",
        pagination: { limit: 1000 },
      });
      expect(events.data.some((event) => event.eventType === "step_retrying")).toBe(true);
    });
  }, 40_000);

  it("blocks an ambiguous create when bounded metadata recovery cannot find it", async () => {
    const methods: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const method = String(url).split("/").at(-1) ?? "";
      methods.push(method);
      if (method === "chat.postMessage") throw new TypeError("Response lost after acceptance.");
      if (method === "conversations.replies") return Response.json({ ok: true, messages: [] });
      return Response.json({ ok: true });
    });
    await withParkedObservation(fetcher, async (runId) => {
      const hook = await getHookByToken(`eve:run-observation:v1:${runId}`);
      await expect(getRun(hook.runId).returnValue).rejects.toThrow(
        /Run observation delivery_blocked/,
      );
      expect(methods.filter((method) => method === "chat.postMessage")).toHaveLength(1);
      expect(methods).toContain("conversations.replies");
      const steps = await (await getWorld()).steps.list({ runId: hook.runId, resolveData: "all" });
      const failure = steps.data.find((step) =>
        step.stepName.endsWith("//recordObservationFailureStep"),
      );
      expect(failure?.output).toBeDefined();
      expect(await hydrateStepReturnValue(failure!.output, hook.runId, undefined)).toMatchObject({
        reason: "delivery_blocked",
        undelivered: [{ state: "blocked", errorCode: "unconfirmed_create" }],
      });
    });
  }, 30_000);

  it("honors a provider Retry-After and journals undelivered objects at expiry", async () => {
    const methods: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const method = String(url).split("/").at(-1) ?? "";
      methods.push(method);
      if (method === "chat.postMessage") {
        return Response.json(
          { ok: false, error: "ratelimited" },
          { status: 429, headers: { "retry-after": "30" } },
        );
      }
      return Response.json({ ok: true });
    });
    await withParkedObservation(
      fetcher,
      async (runId) => {
        const hook = await getHookByToken(`eve:run-observation:v1:${runId}`);
        await expect(getRun(hook.runId).returnValue).rejects.toThrow(/Run observation expired/);
        expect(methods.filter((method) => method === "chat.postMessage")).toHaveLength(1);
        expect(methods).not.toContain("conversations.replies");
        const steps = await (
          await getWorld()
        ).steps.list({ runId: hook.runId, resolveData: "all" });
        const failure = steps.data.find((step) =>
          step.stepName.endsWith("//recordObservationFailureStep"),
        );
        expect(failure?.output).toBeDefined();
        const report = await hydrateStepReturnValue(failure!.output, hook.runId, undefined);
        expect(report).toMatchObject({
          reason: "expired",
          undelivered: [{ state: "retryable", errorCode: "rate_limited" }],
        });
      },
      5_000,
    );
  }, 30_000);

  it("catches a direct child page that arrives after the parent terminal event", async () => {
    let releasePost: () => void = () => {};
    let postStarted: () => void = () => {};
    const postRelease = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const postStart = new Promise<void>((resolve) => {
      postStarted = resolve;
    });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const method = String(url).split("/").at(-1) ?? "";
      if (method === "chat.postMessage") {
        postStarted();
        await postRelease;
      }
      return Response.json({ ok: true, ts: "123.456" });
    });
    const runtime = await createTestRuntime({
      agent: { name: "observation-late-child" },
      modules: [
        {
          logicalPath: "channels/slack.ts",
          loadNamespace: async () => ({
            default: slackChannel({
              experimental: { runObservation: true },
              credentials: { botToken: "xoxb-test" },
              api: { fetch: fetcher },
            }),
          }),
        },
      ],
    });
    await runtime.run(async () => {
      const child = await start(runObservationSourceWorkflow, [{}]);
      const parent = await start(runObservationSourceWorkflow, [{ childSessionId: child.runId }]);
      const observer = await start(runObservationWorkflow, [
        {
          rootSessionId: parent.runId,
          serializedContext: buildSerializedContext({
            channelKind: "channel:slack",
            channelState: { channelId: "C1", threadTs: "100.100", installationTeamId: "T1" },
          }),
          expiresAt: new Date(Date.now() + 15_000).toISOString(),
          token: `eve:late-child:${parent.runId}`,
        },
      ]);
      try {
        await postStart;
        await vi.waitFor(
          async () => {
            const steps = await (
              await getWorld()
            ).steps.list({ runId: observer.runId, resolveData: "all" });
            const checkpoints = steps.data.filter((step) =>
              step.stepName.endsWith("//checkpointObservationStep"),
            );
            const states = (await Promise.all(
              checkpoints.map((step) =>
                hydrateStepReturnValue(step.output, observer.runId, undefined),
              ),
            )) as Array<{ sources: Record<string, { nextIndex: number }> }>;
            expect(
              states.some(
                (state) => state.sources[`${parent.runId}/call/${child.runId}`]?.nextIndex === 1,
              ),
            ).toBe(true);
            expect(await observer.status).not.toBe("completed");
          },
          { timeout: 8_000 },
        );
        releasePost();
        await expect(observer.returnValue).resolves.toBeUndefined();
        expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("chat.postMessage"))).toBe(
          true,
        );
      } finally {
        releasePost();
        if (["pending", "running"].includes(await observer.status)) await observer.cancel();
        if (["pending", "running"].includes(await parent.status)) await parent.cancel();
        if (["pending", "running"].includes(await child.status)) await child.cancel();
      }
    });
  }, 30_000);
});

async function withParkedObservation(
  fetcher: typeof fetch,
  verify: (runId: string) => Promise<void>,
  expiresInMs = 30_000,
): Promise<void> {
  const runtime = await createTestRuntime({
    agent: { name: "observation-fixture" },
    modules: [
      {
        logicalPath: "channels/slack.ts",
        loadNamespace: async () => ({
          default: slackChannel({
            experimental: { runObservation: true },
            credentials: { botToken: "xoxb-test" },
            api: { fetch: fetcher },
          }),
        }),
      },
    ],
  });
  await runtime.run(async () => {
    const run = await start(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Hello Alice" },
        runObservation: { expiresAt: new Date(Date.now() + expiresInMs).toISOString() },
        serializedContext: buildSerializedContext({
          channelKind: "channel:slack",
          channelState: { channelId: "C1", threadTs: "100.100", installationTeamId: "T1" },
          continuationToken: "slack:C1:100.100",
        }),
      },
    ]);
    const stream = captureTurnEvents(run);
    try {
      await stream.nextTurn();
      await verify(run.runId);
    } finally {
      stream.dispose();
      await run.cancel();
    }
  });
}
