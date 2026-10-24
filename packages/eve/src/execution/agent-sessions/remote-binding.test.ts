import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { AgentSessionAddress } from "#execution/agent-sessions/steps.js";
import { defineRemoteAgent } from "#public/definitions/remote-agent.js";
import type { DynamicRemoteBinding } from "#reactions/remote.js";
import { digestOf } from "#reactions/state.js";

const continueRemoteAgentSession = vi.fn();

vi.mock("#execution/agent-sessions/remote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/agent-sessions/remote.js")>()),
  continueRemoteAgentSession: async (input: unknown) => continueRemoteAgentSession(input),
}));

// The parent's stream, which a restore folds its view from: here, nothing yet.
vi.mock("#execution/session-event-stream.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/session-event-stream.js")>()),
  streamSessionLines: async function* () {},
}));

/** A dynamic subagent whose remote agent, and token, follow the tenant its memo keeps. */
const tenantRemote = {
  evaluate: async (ctx: { readonly memo: <T>(key: unknown, fn: () => T) => Promise<T> }) => {
    const tenant = await ctx.memo("tenant", (): { id: string } => {
      throw new Error("A restore never looks the tenant up again.");
    });
    return defineRemoteAgent({
      auth: async () => ({ headers: { authorization: `Bearer ${tenant.id}` } }),
      description: "Finance",
      url: "https://finance.example",
    });
  },
  logicalPath: "subagents/finance.ts",
  name: "finance",
  nodeId: "subagents/finance",
};

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: async () => ({
    subagentRegistry: {
      dynamicResolvers: [tenantRemote],
      subagentsByNodeId: new Map([
        [
          tenantRemote.nodeId,
          { definition: { logicalPath: tenantRemote.logicalPath, sourceId: "finance" } },
        ],
      ]),
    },
  }),
}));

vi.mock("#runtime/durable-compiled-artifacts-source.js", () => ({
  resolveDurableCompiledArtifactsSource: (source: unknown) => source,
}));

const { sendAgentSessionMessageStep } = await import("#execution/agent-sessions/steps.js");
const { remoteAgentCredentials } = await import("#execution/agent-sessions/remote-credentials.js");

const bindingFor = (tenant: string): DynamicRemoteBinding => ({
  at: "2026-01-01T00:00:00.000Z",
  channel: { kind: "unknown", metadata: {} },
  memos: { [digestOf("tenant")]: { id: tenant } },
  position: 0,
  session: { auth: { current: null, initiator: null }, id: "parent" },
});

/** The parent's context, as its session stands now: the finance agent for `tenant`. */
function contextSelecting(tenant: string): AgentSessionContext {
  return {
    bundle: { nodeId: "root", source: {} },
    dynamicSelections: {
      [tenantRemote.nodeId]: {
        binding: bindingFor(tenant),
        kind: "remote",
        prepared: {},
        remoteAgent: {
          credentials: true,
          description: "Finance",
          path: "/eve/v1/session",
          url: "https://finance.example",
        },
      },
    },
    parent: { callId: "call-1", rootSessionId: "parent", sessionId: "parent" },
  } as never;
}

function addressOpenedFor(
  tenant: string,
  url = "https://finance.example",
): Extract<AgentSessionAddress, { readonly kind: "remote" }> {
  return {
    callbackBaseUrl: "https://parent.example",
    dynamicBinding: bindingFor(tenant),
    kind: "remote",
    name: "finance",
    nodeId: tenantRemote.nodeId,
    resolverId: tenantRemote.nodeId,
    sessionId: "child-1",
    url,
  };
}

async function send(
  context: AgentSessionContext,
  address: AgentSessionAddress,
): Promise<{ readonly authorization?: string }> {
  await sendAgentSessionMessageStep({
    address,
    auth: { current: null, initiator: null },
    context,
    key: "finance",
    message: "Close the books.",
    replyTo: "reply-1",
  } as never);
  const call = continueRemoteAgentSession.mock.calls.at(-1);
  if (call === undefined) throw new Error("The step sent nothing to the child.");
  const { remote } = call[0] as {
    readonly remote: { readonly auth?: () => Promise<{ headers: Record<string, string> }> };
  };
  return (await remote.auth?.())?.headers ?? {};
}

describe("a dynamic remote agent's child", () => {
  beforeEach(() => continueRemoteAgentSession.mockReset());

  it("keeps the credentials it was opened with after the parent's session moves to another tenant", async () => {
    // Opened for acme; the parent's session, as the step runs now, is globex's.
    await expect(send(contextSelecting("globex"), addressOpenedFor("acme"))).resolves.toEqual({
      authorization: "Bearer acme",
    });
  });

  it("sends no credentials to a destination its binding doesn't lead to", async () => {
    await expect(
      send(contextSelecting("acme"), addressOpenedFor("acme", "https://old.finance.example")),
    ).rejects.toThrow("now resolves to another destination");
    expect(continueRemoteAgentSession).not.toHaveBeenCalled();
  });

  it("refuses credentials that read the conversation outside a memo", async () => {
    const conversational = {
      ...tenantRemote,
      evaluate: async (ctx: { readonly messages: () => Promise<unknown> }) => {
        await ctx.messages();
        return defineRemoteAgent({ description: "Finance", url: "https://finance.example" });
      },
    };

    await expect(
      remoteAgentCredentials({
        binding: bindingFor("acme"),
        destination: { name: "finance", url: "https://finance.example" },
        nodeId: tenantRemote.nodeId,
        resolvers: [conversational as never],
      }),
    ).rejects.toThrow('"subagents/finance.ts" read ctx.messages()');
  });

  it("refuses headers whose values aren't strings", async () => {
    const numericHeaders = {
      ...tenantRemote,
      evaluate: async () =>
        defineRemoteAgent({
          description: "Finance",
          headers: { "x-key": 123 } as never,
          url: "https://finance.example",
        }),
    };

    await expect(
      remoteAgentCredentials({
        binding: bindingFor("acme"),
        destination: { name: "finance", url: "https://finance.example" },
        nodeId: tenantRemote.nodeId,
        resolvers: [numericHeaders as never],
      }),
    ).rejects.toThrow('"headers" must be an object of string values or a function.');
  });
});
