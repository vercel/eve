import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { AgentSessionAddress } from "#execution/agent-sessions/steps.js";
import { defineRemoteAgent } from "#public/definitions/remote-agent.js";

const continueRemoteAgentSession = vi.fn();

vi.mock("#execution/agent-sessions/remote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/agent-sessions/remote.js")>()),
  continueRemoteAgentSession: async (input: unknown) => continueRemoteAgentSession(input),
}));

/** A dynamic subagent that renders a tenant's remote agent, with a token for that tenant. */
const tenantRemote = {
  logicalPath: "subagents/finance.ts",
  name: "finance",
  nodeId: "subagents/finance",
  render: (tenant: { readonly id: string }) =>
    defineRemoteAgent({
      auth: async () => ({ headers: { authorization: `Bearer ${tenant.id}` } }),
      description: "Finance",
      url: "https://finance.example",
    }),
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

/** The parent's context, as it selects the finance agent for `tenant`. */
function contextSelecting(tenant: string): AgentSessionContext {
  return {
    bundle: { nodeId: "root", source: {} },
    dynamicSelections: {
      [tenantRemote.nodeId]: {
        kind: "remote",
        prepared: {},
        record: { id: tenant },
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
    kind: "remote",
    name: "finance",
    nodeId: tenantRemote.nodeId,
    record: { id: tenant },
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

  it("keeps the credentials it was opened with after the parent selects another tenant", async () => {
    // Opened for acme; the context the step runs in now selects globex.
    await expect(send(contextSelecting("globex"), addressOpenedFor("acme"))).resolves.toEqual({
      authorization: "Bearer acme",
    });
  });

  it("sends no credentials to a destination its record doesn't render", async () => {
    await expect(
      send(contextSelecting("acme"), addressOpenedFor("acme", "https://old.finance.example")),
    ).rejects.toThrow("now renders another destination");
    expect(continueRemoteAgentSession).not.toHaveBeenCalled();
  });
});
