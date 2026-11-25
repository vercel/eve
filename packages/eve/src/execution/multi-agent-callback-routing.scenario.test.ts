import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { parseSessionCallback } from "#channel/session-callback.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import {
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#subagents/parent-notification.js";
import { REMOTE_AGENT_PROTOCOL_VERSION } from "#protocol/remote-agent-protocol.js";
import { startRemoteAgentSession } from "#execution/agent-sessions/remote.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { authHookToken, CallbackBaseUrlKey, getHookUrl } from "#harness/authorization.js";
import {
  createEveCallbackRoutePath,
  createEveConnectionCallbackRoutePath,
} from "#protocol/routes.js";
import { ensureEveVercelOutputConfig } from "#public/next/vercel-output-config.js";
import { joinEveRoutePath } from "#shared/eve-route-path.js";
import type { HarnessSession } from "#harness/types.js";
import { startTestApp, testApp, testEntities } from "#internal/testing/test-platform.js";

const platform = testEntities();

const DEPLOYMENT_AGENTS = [
  {
    name: "support",
    publicRoutePrefix: "/eve/support",
    serviceName: "eve-support",
  },
  {
    name: "billing",
    publicRoutePrefix: "/eve/billing",
    serviceName: "eve-billing",
  },
] as const;

interface VercelOutputRoute {
  readonly destination?: { readonly service?: string; readonly type?: string };
  readonly src?: string;
  readonly transforms?: readonly { args: string; op: string; type: string }[];
}

interface VercelOutputConfig {
  readonly routes?: readonly VercelOutputRoute[];
  readonly services?: Record<string, { readonly routes?: readonly VercelOutputRoute[] }>;
}

interface RoutedServiceRequest {
  readonly service: string;
  readonly servicePath: string;
}

function routeDeploymentRequest(
  config: VercelOutputConfig,
  pathname: string,
): RoutedServiceRequest | null {
  for (const route of config.routes ?? []) {
    if (route.src === undefined || route.destination?.type !== "service") {
      continue;
    }
    if (!new RegExp(route.src).test(pathname)) {
      continue;
    }

    const serviceName = route.destination.service;
    if (serviceName === undefined) {
      return null;
    }

    for (const serviceRoute of config.services?.[serviceName]?.routes ?? []) {
      if (serviceRoute.src === undefined) {
        continue;
      }
      const match = new RegExp(serviceRoute.src).exec(pathname);
      const transform = serviceRoute.transforms?.find(
        (candidate) => candidate.type === "request.path" && candidate.op === "set",
      );
      if (match === null || transform === undefined) {
        continue;
      }

      return {
        service: serviceName,
        servicePath: transform.args.replace(
          /\$(\d+)/g,
          (_, group: string) => match[Number(group)] ?? "",
        ),
      };
    }

    return { service: serviceName, servicePath: pathname };
  }

  return null;
}

interface RecordedServiceRequest {
  readonly method: string;
  readonly servicePath: string;
}

function createStubSession(sessionId: string): HarnessSession {
  return {
    compaction: {},
    continuationToken: `${sessionId}:continuation`,
    history: [],
    sessionId,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

describe("multi-agent callback routing", () => {
  const serviceRequests = new Map<string, RecordedServiceRequest[]>();
  const createSessionBodies: unknown[] = [];
  const expectedTokens = new Map<string, string>();
  const expectedSessionIds = new Map<string, string>();
  let deploymentServer: Server;
  let remoteAgentServer: Server;
  let deploymentOrigin: string;
  let remoteAgentOrigin: string;

  beforeAll(async () => {
    startTestApp(testApp({ platform }));
    const authorizationAttemptId = "attempt-linear";
    const nextRoot = await mkdtemp(join(tmpdir(), "eve-callback-routing-"));

    for (const agent of DEPLOYMENT_AGENTS) {
      serviceRequests.set(agent.serviceName, []);
      expectedTokens.set(agent.serviceName, `${agent.name}-session:callback-token`);
      expectedSessionIds.set(agent.serviceName, `${agent.name}-session`);
    }

    vi.stubEnv("VERCEL", "1");
    try {
      await ensureEveVercelOutputConfig({
        agents: DEPLOYMENT_AGENTS.map((agent) => ({
          appRoot: join(nextRoot, "agents", agent.name),
          buildCommand: "eve build",
          name: agent.name,
          publicRoutePrefix: agent.publicRoutePrefix,
          servicePrefix: `/_eve_internal/eve/${agent.name}`,
        })),
        nextRoot,
      });
    } finally {
      vi.unstubAllEnvs();
    }

    const outputConfig = JSON.parse(
      await readFile(join(nextRoot, ".vercel", "output", "config.json"), "utf8"),
    ) as VercelOutputConfig;

    deploymentServer = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://deployment.invalid").pathname;
      const routed = routeDeploymentRequest(outputConfig, pathname);

      if (routed === null) {
        response.writeHead(404).end();
        return;
      }

      serviceRequests.get(routed.service)?.push({
        method: request.method ?? "",
        servicePath: routed.servicePath,
      });

      const callbackToken = expectedTokens.get(routed.service) ?? "";
      const sessionId = expectedSessionIds.get(routed.service) ?? "";
      const servesPath =
        (request.method === "POST" &&
          routed.servicePath === createEveCallbackRoutePath(callbackToken)) ||
        (request.method === "GET" &&
          routed.servicePath ===
            createEveConnectionCallbackRoutePath(
              "linear",
              authorizationAttemptId,
              authHookToken(sessionId),
            ));

      if (!servesPath) {
        response.writeHead(404).end();
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    deploymentOrigin = await listen(deploymentServer);

    remoteAgentServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        createSessionBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(202, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
            sessionId: "remote-session-1",
            status: "accepted",
          }),
        );
      });
    });
    remoteAgentOrigin = await listen(remoteAgentServer);
  });

  afterAll(async () => {
    await Promise.all([
      new Promise((resolve) => deploymentServer.close(resolve)),
      new Promise((resolve) => remoteAgentServer.close(resolve)),
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function stubAgentRuntimeEnvironment(publicRoutePrefix: string | undefined): void {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "");
    vi.stubEnv("EVE_DEV", "1");
    if (publicRoutePrefix !== undefined) {
      vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", publicRoutePrefix);
    }
  }

  async function mintRemoteAgentCallback(agentName: string): Promise<{
    readonly callback: { token: string; url: string };
    readonly remoteSessionId: string;
  }> {
    const sessionId = `${agentName}-session`;
    const callbackToken = `${sessionId}:callback-token`;
    const bodyCountBefore = createSessionBodies.length;

    const { sessionId: remoteSessionId } = await startRemoteAgentSession({
      action: {
        callId: `call-${agentName}`,
        description: "delegate research",
        input: { message: "run the report" },
        kind: "remote-agent-call",
        name: "research",
        nodeId: "agent/agents/research.ts",
        remoteAgentName: "research",
      },
      callbackBaseUrl: resolveWorkflowCallbackBaseUrl(deploymentOrigin, platform),
      parent: { continuationToken: callbackToken },
      remote: {
        description: "remote research agent",
        kind: "remote",
        logicalPath: "agent/agents/research.ts",
        name: "research",
        nodeId: "agent/agents/research.ts",
        path: "/eve/v1/session",
        sourceId: "agent/agents/research.ts",
        sourceKind: "module",
        url: remoteAgentOrigin,
      },
      session: createStubSession(sessionId),
    });

    const body = createSessionBodies[bodyCountBefore] as {
      callback: { token: string; url: string };
    };
    expect(createSessionBodies.length).toBe(bodyCountBefore + 1);
    return { callback: body.callback, remoteSessionId };
  }

  for (const agent of DEPLOYMENT_AGENTS) {
    it(`delivers the remote-subagent settled turn for ${agent.name} through its public mount`, async () => {
      stubAgentRuntimeEnvironment(agent.publicRoutePrefix);

      const { callback, remoteSessionId } = await mintRemoteAgentCallback(agent.name);
      const callbackToken = `${agent.name}-session:callback-token`;

      expect(remoteSessionId).toBe("remote-session-1");
      expect(callback.url).toBe(
        `${deploymentOrigin}${joinEveRoutePath(
          agent.publicRoutePrefix,
          createEveCallbackRoutePath(callbackToken),
        )}?eveRemoteProtocol=${String(REMOTE_AGENT_PROTOCOL_VERSION)}`,
      );

      expect(parseSessionCallback(callback, platform)).toMatchObject({ ok: true });

      const serializedContext = {
        [SessionCallbackKey.name]: {
          callId: `call-${agent.name}`,
          subagentName: "research",
          ...callback,
        },
      };
      const caller = await resolveInitialTurnCallerStep({ serializedContext });
      await expect(
        notifyTurnCallerStep({
          caller,
          lifecycle: "parked",
          sessionId: "remote-session-1",
          settled: { output: "report done" },
        }),
      ).resolves.toBeUndefined();

      expect(serviceRequests.get(agent.serviceName)).toContainEqual({
        method: "POST",
        servicePath: createEveCallbackRoutePath(callbackToken),
      });
    });

    it(`resolves the connection hook URL for ${agent.name} through its public mount`, async () => {
      stubAgentRuntimeEnvironment(agent.publicRoutePrefix);

      const sessionId = `${agent.name}-session`;
      const ctx = new ContextContainer();
      ctx.set(SessionIdKey, sessionId);
      ctx.set(CallbackBaseUrlKey, resolveWorkflowCallbackBaseUrl(deploymentOrigin, platform));

      const attemptId = "attempt-linear";
      const hookUrl = contextStorage.run(ctx, () => getHookUrl("linear", attemptId));

      expect(hookUrl).toBe(
        `${deploymentOrigin}${joinEveRoutePath(
          agent.publicRoutePrefix,
          createEveConnectionCallbackRoutePath("linear", attemptId, authHookToken(sessionId)),
        )}`,
      );

      const response = await fetch(hookUrl ?? "");
      expect(response.status).toBe(200);
      expect(serviceRequests.get(agent.serviceName)).toContainEqual({
        method: "GET",
        servicePath: createEveConnectionCallbackRoutePath(
          "linear",
          attemptId,
          authHookToken(sessionId),
        ),
      });
    });
  }

  it("keeps each parent's callbacks on its own service", () => {
    for (const agent of DEPLOYMENT_AGENTS) {
      const requests = serviceRequests.get(agent.serviceName) ?? [];
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.servicePath).toContain(`${agent.name}-session`);
      }
    }
  });

  it.each(["turn.completed", "turn.failed"] as const)(
    "logs %s delivery failures when the public route prefix is absent",
    async (kind) => {
      stubAgentRuntimeEnvironment(undefined);
      vi.stubEnv("EVE_LOG_LEVEL", "error");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { callback } = await mintRemoteAgentCallback("support");

      expect(callback.url).toBe(
        `${deploymentOrigin}${createEveCallbackRoutePath("support-session:callback-token")}?eveRemoteProtocol=${String(REMOTE_AGENT_PROTOCOL_VERSION)}`,
      );
      const sessionCallback = {
        callId: "call-support",
        subagentName: "research",
        ...callback,
      };
      const serializedContext = {
        [SessionIdKey.name]: "remote-session-1",
        [SessionCallbackKey.name]: sessionCallback,
      };
      const deliver = async () => {
        await notifyTurnCallerStep({
          caller: await resolveInitialTurnCallerStep({ serializedContext }),
          lifecycle: "terminal",
          sessionId: "remote-session-1",
          settled:
            kind === "turn.failed"
              ? { isError: true, output: { message: "private failure" } }
              : { output: "report done" },
        });
      };
      await expect(deliver()).rejects.toThrow(/callback failed with HTTP 404/);
      expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
        "[eve:execution.session-callback] callback delivery failed",
        expect.objectContaining({
          kind,
          callId: "call-support",
          callbackOrigin: deploymentOrigin,
          callbackPath: "/eve/v1/callback/[redacted]",
          statusCode: 404,
        }),
      );
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("callback-token");
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("private");
    },
  );
});
