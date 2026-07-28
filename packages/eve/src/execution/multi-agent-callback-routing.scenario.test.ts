import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { parseSessionCallback } from "#channel/session-callback.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import { fireSessionCallbackStep } from "#execution/session-callback-step.js";
import { startRemoteAgentSession } from "#execution/remote-agent-dispatch.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { authHookToken, CallbackBaseUrlKey, getHookUrl } from "#harness/authorization.js";
import { EVE_SESSION_ID_HEADER } from "#protocol/message.js";
import {
  createEveCallbackRoutePath,
  createEveConnectionCallbackRoutePath,
} from "#protocol/routes.js";
import { ensureEveVercelOutputConfig } from "#public/next/vercel-output-config.js";
import type { HarnessSession } from "#harness/types.js";

/**
 * Deployment-shaped callback loop for multi-agent mode (issue #839).
 *
 * Two named parent agents are mounted behind per-agent public route
 * prefixes, exactly as `withEve({ agents })` generates them. The test wires
 * the real pieces end to end over live HTTP:
 *
 * 1. the actual Build Output routing config from
 *    `ensureEveVercelOutputConfig` (route `src` regexes + `request.path`
 *    transforms) drives a router emulating Vercel's documented semantics;
 * 2. the parent mints callback URLs through the real code paths — the
 *    remote-subagent session callback (`startRemoteAgentSession`) and the
 *    connection hook URL (`getHookUrl`);
 * 3. the remote side validates the callback metadata with the real
 *    create-session parser (`parseSessionCallback`) and posts the terminal
 *    result with the real durable step (`fireSessionCallbackStep`);
 * 4. each parent service only serves its own prefix-stripped `/eve/v1/*`
 *    callback routes — anything else 404s, matching production.
 *
 * The only simulated component is Vercel's route engine itself.
 */

const DEPLOYMENT_AGENTS = [
  {
    name: "support",
    publicRoutePrefix: "/eve/agents/support",
    serviceName: "eve-support",
  },
  {
    name: "billing",
    publicRoutePrefix: "/eve/agents/billing",
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

/**
 * Resolves an inbound public path the way the Vercel router does for the
 * generated Build Output config: match a top-level route `src` to pick the
 * destination service, then apply that service's `request.path` transform.
 */
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
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
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
    const nextRoot = await mkdtemp(join(tmpdir(), "eve-callback-routing-"));

    for (const agent of DEPLOYMENT_AGENTS) {
      serviceRequests.set(agent.serviceName, []);
      expectedTokens.set(agent.serviceName, `${agent.name}-session:callback-token`);
      expectedSessionIds.set(agent.serviceName, `${agent.name}-session`);
    }

    // Generate the real Build Output config the Next integration writes for
    // two named agents on Vercel.
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

    // Deployment origin: routes public paths per the generated config, then
    // serves each eve service's prefix-stripped framework callback routes.
    // Unrouted paths 404, matching a deployment with no bare /eve/v1 mount.
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
            createEveConnectionCallbackRoutePath("linear", authHookToken(sessionId)));

      if (!servesPath) {
        response.writeHead(404).end();
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    deploymentOrigin = await listen(deploymentServer);

    // Remote subagent: records the create-session body and returns a session
    // id, like the eve channel's create-session route.
    remoteAgentServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        createSessionBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, {
          "content-type": "application/json",
          [EVE_SESSION_ID_HEADER]: "remote-session-1",
        });
        response.end(JSON.stringify({ ok: true }));
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
  });

  function stubAgentRuntimeEnvironment(publicRoutePrefix: string | undefined): void {
    // Mirrors the environment baked into the agent's deployed workflow
    // functions: no local world override, non-production Vercel deployment,
    // and (post-fix) the agent's public route prefix.
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "");
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

    const remoteSessionId = await startRemoteAgentSession({
      action: {
        callId: `call-${agentName}`,
        description: "delegate research",
        input: { message: "run the report" },
        kind: "remote-agent-call",
        name: "research",
        nodeId: "agent/agents/research.ts",
        remoteAgentName: "research",
      },
      callbackBaseUrl: resolveWorkflowCallbackBaseUrl(deploymentOrigin),
      callbackToken,
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
    it(`delivers the remote-subagent session callback for ${agent.name} through its public mount`, async () => {
      stubAgentRuntimeEnvironment(agent.publicRoutePrefix);

      const { callback, remoteSessionId } = await mintRemoteAgentCallback(agent.name);
      const callbackToken = `${agent.name}-session:callback-token`;

      expect(remoteSessionId).toBe("remote-session-1");
      expect(callback.url).toBe(
        `${deploymentOrigin}${agent.publicRoutePrefix}${createEveCallbackRoutePath(callbackToken)}`,
      );

      // Remote-side create-session validation (public/channels/eve.ts):
      // the prefixed URL must parse, or the remote rejects with HTTP 400.
      expect(parseSessionCallback(callback)).toMatchObject({ ok: true });

      // Remote-side terminal POST (the step that failed with HTTP 404 in
      // production) must reach the parent service through the deployment
      // router and succeed.
      await expect(
        fireSessionCallbackStep({
          output: "report done",
          serializedContext: {
            [SessionIdKey.name]: "remote-session-1",
            [SessionCallbackKey.name]: {
              callId: `call-${agent.name}`,
              subagentName: "research",
              ...callback,
            },
          },
          status: "completed",
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
      ctx.set(CallbackBaseUrlKey, resolveWorkflowCallbackBaseUrl(deploymentOrigin));

      const hookUrl = contextStorage.run(ctx, () => getHookUrl("linear"));

      expect(hookUrl).toBe(
        `${deploymentOrigin}${agent.publicRoutePrefix}${createEveConnectionCallbackRoutePath(
          "linear",
          authHookToken(sessionId),
        )}`,
      );

      // The IdP redirect follows this URL from the user's browser.
      const response = await fetch(hookUrl ?? "");
      expect(response.status).toBe(200);
      expect(serviceRequests.get(agent.serviceName)).toContainEqual({
        method: "GET",
        servicePath: createEveConnectionCallbackRoutePath("linear", authHookToken(sessionId)),
      });
    });
  }

  it("keeps each parent's callbacks on its own service", () => {
    // All prior traffic in this suite must have stayed on the minting
    // agent's own service: support paths only on eve-support, billing paths
    // only on eve-billing.
    for (const agent of DEPLOYMENT_AGENTS) {
      const requests = serviceRequests.get(agent.serviceName) ?? [];
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.servicePath).toContain(`${agent.name}-session`);
      }
    }
  });

  it("reproduces the 404 when the public route prefix is absent (pre-fix behavior)", async () => {
    stubAgentRuntimeEnvironment(undefined);

    const { callback } = await mintRemoteAgentCallback("support");

    // Without the prefix the minted URL targets the bare /eve/v1 path that
    // nothing serves in multi-agent mode — the exact production failure.
    expect(callback.url).toBe(
      `${deploymentOrigin}${createEveCallbackRoutePath("support-session:callback-token")}`,
    );
    await expect(
      fireSessionCallbackStep({
        output: "report done",
        serializedContext: {
          [SessionIdKey.name]: "remote-session-1",
          [SessionCallbackKey.name]: {
            callId: "call-support",
            subagentName: "research",
            ...callback,
          },
        },
        status: "completed",
      }),
    ).rejects.toThrow("Session callback failed with HTTP 404.");
  });
});
