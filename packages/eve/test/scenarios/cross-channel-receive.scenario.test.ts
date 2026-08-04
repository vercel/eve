import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCrossChannelToFn,
  toCrossChannelTargets,
} from "../../src/channel/cross-channel-receive.js";
import type { Runtime, SessionCommand, SessionCommandResult } from "../../src/channel/types.js";
import { compileAgent } from "../../src/compiler/compile-agent.js";
import { createDiskRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "../../src/runtime/sessions/compiled-agent-cache.js";
import {
  createRuntimeSession,
  withRuntimeSession,
} from "../../src/runtime/sessions/runtime-session.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";
import { mockChannelContext } from "../../src/internal/testing/mocks/mock-channel-operations.js";

/**
 * Locks the cross-channel `ctx.to(channel, target).send(...)` path end-to-end:
 * a two-channel agent is compiled from disk, its resolved bundle
 * preserves the per-channel `definition` reference, and dispatching by
 * that reference routes through to the target channel's `receive`
 * with the target's continuation-token namespace.
 *
 * Authors as inline `__kind: "eve:channel"` objects in `.mjs` so the
 * test compiles without an eve install. The compiler's
 * normalizer is the same shape gate used for `defineChannel`.
 */

const createAppRoot = useTemporaryAppRoots();
const APP_ROOT_OPTIONS = { packageName: "cross-channel-receive-test-agent" } as const;

const WEBHOOK_CHANNEL = `import target from "./target.mjs";

export default {
  __kind: "eve:channel",
  adapter: { kind: "http" },
  routes: [
    {
      method: "POST",
      path: "/webhook",
      handler: async (req, args) => {
        const body = await req.json();
        const session = await args
          .to(target, { sessionId: body.sessionId })
          .send(body.message, { auth: body.auth });
        return Response.json({ ok: true, sessionId: session.id });
      },
    },
  ],
};
`;

const TARGET_CHANNEL = `export default {
  __kind: "eve:channel",
  adapter: { kind: "http" },
  routes: [
    { method: "POST", path: "/target", handler: async () => new Response("ok") },
  ],
  async receive(input, { from }) {
    const target = input.target;
    return from(\`target:\${target.sessionId ?? "default"}\`).send(input.message, {
      auth: input.auth,
    });
  },
};
`;

interface CapturedRun {
  readonly adapter: unknown;
  readonly continuationToken?: string;
  readonly auth?: unknown;
}

function createCapturingRuntime(captured: CapturedRun[]): Runtime {
  return {
    async createSession(input) {
      captured.push({
        adapter: input.adapter,
        continuationToken: input.continuationToken,
        auth: input.auth,
      });
      return {
        continuationToken: input.continuationToken ?? "tok",
        events: new ReadableStream(),
        result: Promise.resolve({ status: "completed", output: "ok" }),
        sessionId: "sess_scenario",
      };
    },
    async dispatchContinuation<TCommand extends SessionCommand>(): Promise<
      SessionCommandResult<TCommand>
    > {
      return { status: "session_not_active" } as SessionCommandResult<TCommand>;
    },
    async dispatchSession() {
      throw new Error("dispatchSession should not be called in this scenario");
    },
    async getEventStream() {
      return new ReadableStream();
    },
    async getStreamTailIndex() {
      return -1;
    },
    async resolveContinuation() {
      throw new Error("resolveContinuation should not be called in this scenario");
    },
  };
}

describe("cross-channel receive end-to-end", () => {
  it("dispatches to the target via the resolved bundle and namespaces the continuation token to the target channel", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-cross-channel-receive-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "channels"), { recursive: true });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "test agent\n");
    await writeFile(join(agentRoot, "channels", "webhook.mjs"), WEBHOOK_CHANNEL);
    await writeFile(join(agentRoot, "channels", "target.mjs"), TARGET_CHANNEL);

    await compileAgent({ startPath: appRoot });

    await withRuntimeSession(createRuntimeSession("cross-channel-receive"), async () => {
      const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
      const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });

      const target = bundle.graph.root.channels.find((ch) => ch.name === "target");
      const webhook = bundle.graph.root.channels.find((ch) => ch.name === "webhook");
      expect(target).toBeDefined();
      expect(webhook).toBeDefined();
      expect(target?.definition).toBeDefined();
      expect(target?.receive).toBeDefined();

      const captured: CapturedRun[] = [];
      const to = createCrossChannelToFn(
        createCapturingRuntime(captured),
        toCrossChannelTargets(bundle.graph.root.channels),
      );

      const auth = {
        attributes: { incidentReference: "INC-99" },
        authenticator: "incidentio",
        principalId: "actor",
        principalType: "service",
      } as const;

      const session = await to(target!.definition!, { sessionId: "scenario-123" }).send(
        "incident triggered",
        { auth },
      );

      expect(session.id).toBe("sess_scenario");
      expect(captured).toHaveLength(1);
      // Target's raw token "target:scenario-123" is namespaced by the
      // target channel name → "target:target:scenario-123".
      expect(captured[0]!.continuationToken).toBe("target:target:scenario-123");
      expect(captured[0]!.auth).toEqual(auth);
      expect(captured[0]!.adapter).toEqual(expect.objectContaining({ kind: "http" }));

      const webhookResponse = await webhook!.handler!(
        new Request("http://localhost/webhook", {
          method: "POST",
          body: JSON.stringify({
            message: "incident follow-up",
            sessionId: "scenario-456",
            auth,
          }),
        }),
        {
          ...mockChannelContext(() => {
            throw new Error("webhook should not send directly");
          }),
          attachSession: () => {
            throw new Error("webhook should not attach sessions directly");
          },
          to,
          params: {},
          requestIp: null,
          waitUntil: () => undefined,
        },
      );
      await expect(webhookResponse.json()).resolves.toEqual({
        ok: true,
        sessionId: "sess_scenario",
      });
      expect(captured[1]!.continuationToken).toBe("target:target:scenario-456");
    });
  });

  it("throws when the passed channel reference is not registered in this agent", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-cross-channel-receive-mismatch-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "channels"), { recursive: true });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "test agent\n");
    await writeFile(join(agentRoot, "channels", "target.mjs"), TARGET_CHANNEL);

    await compileAgent({ startPath: appRoot });

    await withRuntimeSession(createRuntimeSession("cross-channel-receive-mismatch"), async () => {
      const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
      const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });

      const to = createCrossChannelToFn(
        createCapturingRuntime([]),
        toCrossChannelTargets(bundle.graph.root.channels),
      );
      const stranger = { __kind: "eve:channel", routes: [], adapter: { kind: "x" } };

      expect(() => to(stranger, {})).toThrow(/not registered in this agent/);
    });
  });
});
