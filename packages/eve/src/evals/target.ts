import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "#client/client.js";
import type { AgentInfoResult } from "#client/types.js";
import { createEveDevDispatchSchedulePath } from "#protocol/routes.js";
import { toErrorMessage } from "#shared/errors.js";
import { stripNpmPackageScope } from "#shared/package-name.js";
import { EvalSessionManager } from "#evals/session.js";
import type {
  EveEvalScheduleDispatchResult,
  EveEvalSession,
  EveEvalTargetCapabilities,
  EveEvalTargetHandle,
} from "#evals/types.js";

const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_TIMEOUT_MS = 60_000;

export async function resolveEvalTargetHandle(input: {
  readonly client: Client;
  readonly expectedAgentName?: string;
  readonly kind: "local" | "remote";
  readonly url: string;
}): Promise<EveEvalTargetHandle> {
  await waitForTargetHealth(input.client, input.url);
  const info = await input.client.info();
  assertAgentInfoShape(info, input.url);

  if (
    input.expectedAgentName !== undefined &&
    !matchesExpectedAgentName(input.expectedAgentName, info.agent.name)
  ) {
    throw new Error(
      `Expected eval target ${JSON.stringify(input.expectedAgentName)} at ${input.url}, but ${JSON.stringify(info.agent.name)} is responding there.`,
    );
  }

  return createEvalTargetHandle({
    capabilities: capabilitiesFromInfo(info),
    client: input.client,
    kind: input.kind,
    url: input.url,
  });
}

export function createEvalTargetHandle(input: {
  readonly capabilities: EveEvalTargetCapabilities;
  readonly client: Client;
  readonly kind: "local" | "remote";
  readonly url: string;
}): EveEvalTargetHandle {
  return createHandle({
    capabilities: input.capabilities,
    client: input.client,
    kind: input.kind,
    sessions: undefined,
    url: input.url,
  });
}

export function scopeEvalTargetHandle(
  target: EveEvalTargetHandle,
  input: {
    readonly sessions?: EvalSessionManager;
  },
): EveEvalTargetHandle {
  return createHandle({
    capabilities: target.capabilities,
    client: undefined,
    delegate: target,
    kind: target.kind,
    sessions: input.sessions,
    url: target.url,
  });
}

function createHandle(input: {
  readonly capabilities: EveEvalTargetCapabilities;
  readonly client: Client | undefined;
  readonly delegate?: EveEvalTargetHandle;
  readonly kind: "local" | "remote";
  readonly sessions: EvalSessionManager | undefined;
  readonly url: string;
}): EveEvalTargetHandle {
  const base = input.delegate;
  const client = input.client;

  const fetchTarget = async (path: string, init?: RequestInit): Promise<Response> => {
    if (base !== undefined) return await base.fetch(path, init);
    if (client === undefined) throw new Error("Eval target cannot fetch without a client.");
    return await client.fetch(path, init);
  };

  return {
    capabilities: input.capabilities,
    kind: input.kind,
    url: input.url,

    async attachSession(
      sessionId: string,
      opts?: { readonly startIndex?: number },
    ): Promise<EveEvalSession> {
      if (input.sessions !== undefined) {
        return await input.sessions.attachSession(sessionId, opts);
      }

      if (base !== undefined) {
        return await base.attachSession(sessionId, opts);
      }

      if (client === undefined) {
        throw new Error("Eval target cannot attach sessions without a client.");
      }

      const sessions = new EvalSessionManager({ client });
      return await sessions.attachSession(sessionId, opts);
    },

    watchTurn(sessionId: string, opts?: { readonly startIndex?: number }) {
      if (input.sessions !== undefined) {
        return input.sessions.watchTurn(sessionId, opts);
      }

      if (base !== undefined) {
        return base.watchTurn(sessionId, opts);
      }

      if (client === undefined) {
        throw new Error("Eval target cannot watch sessions without a client.");
      }

      const sessions = new EvalSessionManager({ client });
      return sessions.watchTurn(sessionId, opts);
    },

    async dispatchSchedule(scheduleId: string): Promise<EveEvalScheduleDispatchResult> {
      if (!input.capabilities.devRoutes) {
        throw new Error("target.dispatchSchedule() requires a target with dev routes enabled.");
      }

      const response = await fetchTarget(createEveDevDispatchSchedulePath(scheduleId), {
        method: "POST",
      });
      if (!response.ok) {
        const body = await readResponseBodySafely(response);
        throw new Error(
          `Schedule dispatch failed: ${response.status} ${response.statusText}` +
            (body.length > 0 ? `, ${body}` : ""),
        );
      }

      return parseScheduleDispatchResult(await response.json());
    },

    async fetch(path: string, init?: RequestInit): Promise<Response> {
      return await fetchTarget(path, init);
    },
  };
}

function capabilitiesFromInfo(info: AgentInfoResult): EveEvalTargetCapabilities {
  return {
    devRoutes: info.capabilities?.devRoutes ?? info.mode === "development",
  };
}

function matchesExpectedAgentName(expected: string, actual: string): boolean {
  return actual === expected || actual === stripNpmPackageScope(expected);
}

async function waitForTargetHealth(client: Client, url: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    try {
      await client.health();
      return;
    } catch (error) {
      lastError = toErrorMessage(error);
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
  }

  throw new Error(
    `Timed out waiting for eval target health at ${url}.` +
      (lastError === undefined ? "" : ` Last error: ${lastError}`),
  );
}

function assertAgentInfoShape(info: AgentInfoResult, url: string): void {
  if (info.kind !== "eve-agent-info" || info.version !== 1) {
    throw new Error(`Eval target ${url} returned an unrecognized /eve/v1/info payload.`);
  }
}

function parseScheduleDispatchResult(payload: unknown): EveEvalScheduleDispatchResult {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("scheduleId" in payload) ||
    typeof payload.scheduleId !== "string" ||
    !("sessionIds" in payload) ||
    !Array.isArray(payload.sessionIds) ||
    payload.sessionIds.some((sessionId) => typeof sessionId !== "string")
  ) {
    throw new Error(
      `Schedule dispatch returned an unexpected response shape: ${JSON.stringify(payload)}`,
    );
  }

  return {
    scheduleId: payload.scheduleId,
    sessionIds: [...payload.sessionIds],
  };
}

async function readResponseBodySafely(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
