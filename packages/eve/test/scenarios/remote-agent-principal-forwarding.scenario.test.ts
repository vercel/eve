import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "../../src/channel/types.js";
import { startRemoteAgentSession } from "../../src/execution/remote-agent-dispatch.js";
import type { RuntimeRemoteAgentCallActionRequest } from "../../src/runtime/actions/types.js";
import type { ResolvedRuntimeRemoteAgentNode } from "../../src/runtime/types.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

/**
 * Locks the remote-agent principal-forwarding hop over a real HTTP boundary: the
 * test process plays the router deployment (driving the real sender dispatch
 * function) against a receiver dev server whose `eveChannel` configures
 * `trustedForwarders`. The receiver's `onMessage` asserts that the
 * forwarded principal — not the transport caller — became the effective
 * session caller, with the `eve:forwarded-by` audit attribute stamped from
 * the verified transport principal.
 */

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;

const ROUTER_TOKEN = "router-scenario-token";
const STRANGER_TOKEN = "stranger-scenario-token";

const RECEIVER_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";

export default defineAgent({ model: "openai/gpt-5.4-mini" });
`,
    "agent/channels/eve.ts": `import { eveChannel } from "eve/channels/eve";

const PRINCIPALS = {
  "Bearer ${ROUTER_TOKEN}": "router-app",
  "Bearer ${STRANGER_TOKEN}": "stranger-app",
};

export default eveChannel({
  auth(request) {
    const principalId = PRINCIPALS[request.headers.get("authorization") ?? ""];
    if (principalId === undefined) return null;
    return {
      attributes: {},
      authenticator: "scenario-bearer",
      principalId,
      principalType: "service",
    };
  },
  trustedForwarders: (caller) => caller.principalId === "router-app",
  onMessage(ctx) {
    const caller = ctx.eve.caller;
    if (
      caller?.principalId !== "slack:U123" ||
      caller.principalType !== "user" ||
      caller.attributes["eve:forwarded-by"] !== "router-app"
    ) {
      throw new Error("Expected the stamped forwarded principal as the effective caller.");
    }
    return { auth: caller };
  },
});
`,
    "agent/instructions.md": "Reply tersely.\n",
  },
  installDependencies: true,
  name: "forwarded-principal-receiver",
};

const FORWARDED_USER: SessionAuthContext = {
  attributes: { user_id: "U123" },
  authenticator: "slack-webhook",
  issuer: "slack",
  principalId: "slack:U123",
  principalType: "user",
  subject: "U123",
};

describe("remote agent auth forwarding", () => {
  it(
    "asserts the forwarded principal across the hop and rejects untrusted forwarders",
    async () => {
      const receiverApp = await scenarioApp(RECEIVER_DESCRIPTOR);
      const receiver = await startEveDev(receiverApp.appRoot);

      try {
        // Accepted: the trusted transport principal asserts a forwarded user.
        // The receiver's onMessage (which throws on any other caller) proves
        // the principal replacement happened.
        const childSessionId = await startRemoteAgentSession({
          action: createAction(),
          auth: FORWARDED_USER,
          callbackBaseUrl: "https://caller.example.com",
          initiatorAuth: FORWARDED_USER,
          remote: createRemote({ token: ROUTER_TOKEN, url: receiver.url }),
          session: createParentSession(),
        });
        expect(childSessionId.length).toBeGreaterThan(0);

        // Mismatch: an authenticated caller outside the forwarder allow-list
        // fails loud at the hop instead of downgrading to service identity.
        await expect(
          startRemoteAgentSession({
            action: createAction(),
            auth: FORWARDED_USER,
            callbackBaseUrl: "https://caller.example.com",
            initiatorAuth: FORWARDED_USER,
            remote: createRemote({ token: STRANGER_TOKEN, url: receiver.url }),
            session: createParentSession(),
          }),
        ).rejects.toThrow(/HTTP 403/);
      } catch (error) {
        throw new Error(
          [`receiver stdout:\n${receiver.stdout()}`, `receiver stderr:\n${receiver.stderr()}`].join(
            "\n\n",
          ),
          { cause: error },
        );
      } finally {
        await receiver.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});

function createAction(): RuntimeRemoteAgentCallActionRequest {
  return {
    callId: "call-forwarded",
    description: "Runtime action event description.",
    input: { message: "check the site status" },
    kind: "remote-agent-call",
    name: "site-ops",
    nodeId: "subagents/site-ops.ts",
    remoteAgentName: "site-ops",
  };
}

function createRemote(input: {
  readonly token: string;
  readonly url: string;
}): ResolvedRuntimeRemoteAgentNode {
  return {
    auth: async () => ({ headers: { authorization: `Bearer ${input.token}` } }),
    description: "Executes site operations as the requesting user.",
    forwardPrincipal: true,
    kind: "remote",
    logicalPath: "subagents/site-ops.ts",
    name: "site-ops",
    nodeId: "subagents/site-ops.ts",
    path: "/eve/v1/session",
    sourceId: "subagents/site-ops.ts",
    sourceKind: "module",
    url: input.url,
  };
}

function createParentSession() {
  return {
    agent: { modelReference: { id: "mock/test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "eve:parent-token",
    history: [],
    sessionId: "parent-session",
  };
}
