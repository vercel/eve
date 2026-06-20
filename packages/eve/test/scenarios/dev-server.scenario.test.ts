import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  type HandleMessageStreamEvent,
  isCurrentTurnBoundaryEvent,
} from "../../src/protocol/message.js";
import { EVE_HEALTH_ROUTE_PATH } from "../../src/protocol/routes.js";
import { Client } from "../../src/client/client.js";
import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";

// Keep the dev TUI's glyph set deterministic across CI hosts so the
// screen assertions below remain stable.
process.env.EVE_TUI_UNICODE = "1";

const scenarioApp = useScenarioApp();
const DEV_SERVER_SCENARIO_TIMEOUT_MS = 360_000;
const DEV_SERVER_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  files: Object.fromEntries(
    Object.entries(WEATHER_AGENT_DESCRIPTOR.files).filter(
      ([path]) => !path.startsWith("agent/channels/"),
    ),
  ),
};
const CANCELLATION_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...DEV_SERVER_AGENT_DESCRIPTOR,
  name: "cancellation-agent",
};
const LOCAL_SUBAGENT_CANCELLATION_DESCRIPTOR: ScenarioAppDescriptor = {
  ...DEV_SERVER_AGENT_DESCRIPTOR,
  files: {
    ...DEV_SERVER_AGENT_DESCRIPTOR.files,
    "agent/subagents/coordinator/agent.ts": `
import { defineAgent } from "eve";

export default defineAgent({
  description: "Delegates cancellation probes to the sleeper subagent.",
  model: "openai/gpt-5.5",
});
`,
    "agent/subagents/coordinator/subagents/sleeper/agent.ts": `
import { defineAgent } from "eve";

export default defineAgent({
  description: "Waits for cancellation. [wait-for-cancel]",
  model: "openai/gpt-5.5",
});
`,
  },
  name: "local-subagent-cancellation-agent",
};

function createRemoteSubagentCancellationDescriptor(remoteUrl: string): ScenarioAppDescriptor {
  return {
    ...DEV_SERVER_AGENT_DESCRIPTOR,
    files: {
      ...DEV_SERVER_AGENT_DESCRIPTOR.files,
      "agent/subagents/remote-sleeper.ts": `
import { defineRemoteAgent } from "eve";

export default defineRemoteAgent({
  description: "Waits for cancellation. [wait-for-cancel]",
  url: ${JSON.stringify(remoteUrl)},
});
`,
    },
    name: "remote-subagent-cancellation-parent",
  };
}

interface RunningEveDev {
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

interface EventRead {
  readonly event: HandleMessageStreamEvent;
  readonly events: readonly HandleMessageStreamEvent[];
}

interface ObservedSubagent {
  readonly event: Extract<HandleMessageStreamEvent, { type: "subagent.called" }>;
  readonly iterator: AsyncIterator<HandleMessageStreamEvent>;
}

const EVENT_TIMEOUT_MS = 20_000;

async function readUntil(input: {
  readonly iterator: AsyncIterator<HandleMessageStreamEvent>;
  readonly label: string;
  readonly matches: (event: HandleMessageStreamEvent) => boolean;
}): Promise<EventRead> {
  const events: HandleMessageStreamEvent[] = [];
  return await withTimeout(
    (async () => {
      while (true) {
        const next = await input.iterator.next();
        if (next.done) {
          throw new Error(
            `Stream ended before ${input.label}. Events: ${JSON.stringify(events, null, 2)}`,
          );
        }

        events.push(next.value);
        if (input.matches(next.value)) {
          return { event: next.value, events };
        }
      }
    })(),
    input.label,
    () => `Events: ${JSON.stringify(events, null, 2)}`,
  );
}

async function readThroughBoundary(input: {
  readonly iterator: AsyncIterator<HandleMessageStreamEvent>;
  readonly label: string;
}): Promise<readonly HandleMessageStreamEvent[]> {
  const read = await readUntil({
    iterator: input.iterator,
    label: input.label,
    matches: isCurrentTurnBoundaryEvent,
  });
  const end = await withTimeout(input.iterator.next(), `${input.label} stream completion`);
  if (!end.done) {
    throw new Error(`Stream emitted ${end.value.type} after ${input.label}.`);
  }
  return read.events;
}

async function observeSubagent(input: {
  readonly childClient: Client;
  readonly expectedToolName: string;
  readonly label: string;
  readonly parentIterator: AsyncIterator<HandleMessageStreamEvent>;
}): Promise<ObservedSubagent> {
  const read = await readUntil({
    iterator: input.parentIterator,
    label: input.label,
    matches: (event) => event.type === "subagent.called",
  });
  if (read.event.type !== "subagent.called") {
    throw new Error(`Expected ${input.label}.`);
  }
  expect(read.event.data.toolName).toBe(input.expectedToolName);

  return {
    event: read.event,
    iterator: input.childClient
      .session({ sessionId: read.event.data.childSessionId, streamIndex: 0 })
      .stream()
      [Symbol.asyncIterator](),
  };
}

async function waitForStepStarted(
  iterator: AsyncIterator<HandleMessageStreamEvent>,
  label: string,
): Promise<void> {
  await readUntil({
    iterator,
    label,
    matches: (event) => event.type === "step.started",
  });
}

async function withTimeout<T>(
  operation: Promise<T>,
  label: string,
  diagnostics?: () => string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const detail = diagnostics?.();
      reject(new Error(`Timed out waiting for ${label}.${detail ? ` ${detail}` : ""}`));
    }, EVENT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operation, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function expectCancellationCascade(
  events: readonly HandleMessageStreamEvent[],
  boundary: "session.failed" | "session.waiting",
): void {
  const diagnostic = `Events: ${JSON.stringify(events, null, 2)}`;
  expect(events.find((event) => event.type === "step.failed")?.data, diagnostic).toMatchObject({
    code: "TURN_CANCELLED",
    message: "Turn cancelled by the client.",
  });
  expect(events.find((event) => event.type === "turn.failed")?.data, diagnostic).toMatchObject({
    code: "TURN_CANCELLED",
    message: "Turn cancelled by the client.",
  });
  expect(events.at(-1)?.type).toBe(boundary);
}

async function expectSessionContinuation(input: {
  readonly session: ReturnType<Client["session"]>;
  readonly sessionId: string;
}): Promise<void> {
  const followUp = await (
    await input.session.send("Reply with the exact string `still-alive` and nothing else.")
  ).result();

  expect(followUp.sessionId).toBe(input.sessionId);
  expect(followUp.message).toBe("still-alive");
  expect(followUp.status).toBe("waiting");
}

function stripAnsi(text: string): string {
  return text
    .split("\u001b[")
    .map((segment, index) => {
      if (index === 0) {
        return segment;
      }

      return segment.replace(/^[0-9;]*m/, "");
    })
    .join("");
}

function hasUnsupportedWindowsEsmImport(text: string): boolean {
  return (
    text.includes("ERR_UNSUPPORTED_ESM_URL_SCHEME") ||
    text.includes("Received protocol 'g:'") ||
    text.includes('Received protocol "g:"')
  );
}

function hasKnownDevBundlingFailure(text: string): boolean {
  return (
    hasUnsupportedWindowsEsmImport(text) ||
    (text.includes("ERR_MODULE_NOT_FOUND") && text.includes("authored-module-map-loader"))
  );
}

function parseServerUrl(stdout: string): string | undefined {
  const match = /server listening at (https?:\/\/\S+)/.exec(stripAnsi(stdout));

  return match?.[1];
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForServerUrl(input: {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly getOutput: () => {
    readonly stderr: string;
    readonly stdout: string;
  };
}): Promise<string> {
  return await new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      settleReject(
        new Error(
          [
            "Timed out waiting for eve dev to print its server URL.",
            `stdout:\n${input.getOutput().stdout}`,
            `stderr:\n${input.getOutput().stderr}`,
          ].join("\n\n"),
        ),
      );
    }, 120_000);

    const cleanup = () => {
      clearTimeout(timeout);
      input.child.stdout.off("data", handleOutput);
      input.child.stderr.off("data", handleOutput);
      input.child.off("error", settleReject);
      input.child.off("exit", handleExit);
    };

    const settleResolve = (url: string) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(url);
    };

    function settleReject(error: unknown) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    function handleOutput() {
      const output = input.getOutput();
      const combinedOutput = `${output.stdout}\n${output.stderr}`;

      if (hasKnownDevBundlingFailure(combinedOutput)) {
        settleReject(
          new Error(
            [
              "eve dev emitted a known generated dev bundle import failure.",
              `stdout:\n${output.stdout}`,
              `stderr:\n${output.stderr}`,
            ].join("\n\n"),
          ),
        );
        return;
      }

      const url = parseServerUrl(output.stdout);

      if (url !== undefined) {
        settleResolve(url);
      }
    }

    function handleExit(code: number | null, signal: NodeJS.Signals | null) {
      const output = input.getOutput();

      settleReject(
        new Error(
          [
            `eve dev exited before printing its server URL (code ${String(code)}, signal ${String(signal)}).`,
            `stdout:\n${output.stdout}`,
            `stderr:\n${output.stderr}`,
          ].join("\n\n"),
        ),
      );
    }

    input.child.stdout.on("data", handleOutput);
    input.child.stderr.on("data", handleOutput);
    input.child.once("error", settleReject);
    input.child.once("exit", handleExit);
    handleOutput();
  });
}

async function startEveDev(appRoot: string): Promise<RunningEveDev> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(
    process.execPath,
    [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        // Activate the deterministic mock-model adapter in the spawned dev
        // server so the streamed turn completes without model credentials.
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const url = await waitForServerUrl({
    child,
    getOutput: () => ({
      stderr,
      stdout,
    }),
  });

  return {
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000);

        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
    url,
  };
}

describe("eve dev server", () => {
  // A root-only cancellation check cannot catch a token lost while a delegated
  // child waits on its own child. Observe every session so recursive shutdown
  // and the surviving parent conversation are proven in one real dev run.
  it(
    "cancels a nested local subagent chain and continues the root session",
    async () => {
      const app = await scenarioApp(LOCAL_SUBAGENT_CANCELLATION_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const client = new Client({ host: server.url });
        const session = client.session();
        const response = await session.send(
          "Use the coordinator subagent with message 'Use the sleeper subagent with message wait.'.",
        );
        const parentIterator = response[Symbol.asyncIterator]();
        const coordinator = await observeSubagent({
          childClient: client,
          expectedToolName: "coordinator",
          label: "the coordinator subagent call",
          parentIterator,
        });
        const sleeper = await observeSubagent({
          childClient: client,
          expectedToolName: "sleeper",
          label: "the sleeper subagent call",
          parentIterator: coordinator.iterator,
        });
        await waitForStepStarted(sleeper.iterator, "the sleeper model step");

        await expect(response.cancel()).resolves.toBe(true);
        const sleeperEvents = await readThroughBoundary({
          iterator: sleeper.iterator,
          label: "the sleeper cancellation boundary",
        });
        const coordinatorEvents = await readThroughBoundary({
          iterator: coordinator.iterator,
          label: "the coordinator cancellation boundary",
        });
        const parentEvents = await readThroughBoundary({
          iterator: parentIterator,
          label: "the root cancellation boundary",
        });

        expectCancellationCascade(sleeperEvents, "session.failed");
        expectCancellationCascade(coordinatorEvents, "session.failed");
        expectCancellationCascade(parentEvents, "session.waiting");
        expect(parentEvents.some((event) => event.type === "subagent.completed")).toBe(false);
        expect(parentEvents.some((event) => event.type === "message.appended")).toBe(false);
        await expectSessionContinuation({ session, sessionId: response.sessionId });
      } catch (error) {
        throw new Error(
          [`stdout:\n${server.stdout()}`, `stderr:\n${server.stderr()}`].join("\n\n"),
          { cause: error },
        );
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  // Remote delegation uses a second Eve server and an authenticated HTTP
  // cancellation hop. Reading the remote child stream prevents a mocked fetch
  // or an accepted parent request from masquerading as stopped remote work.
  it(
    "cancels a running remote subagent and continues the root session",
    async () => {
      const remoteApp = await scenarioApp({
        ...CANCELLATION_AGENT_DESCRIPTOR,
        name: "remote-subagent-cancellation-child",
      });
      const remoteServer = await startEveDev(remoteApp.appRoot);

      try {
        const parentApp = await scenarioApp(
          createRemoteSubagentCancellationDescriptor(remoteServer.url),
        );
        const parentServer = await startEveDev(parentApp.appRoot);

        try {
          const parentClient = new Client({ host: parentServer.url });
          const parentSession = parentClient.session();
          const response = await parentSession.send(
            "Use the remote-sleeper subagent with message wait.",
          );
          const parentIterator = response[Symbol.asyncIterator]();
          const remote = await observeSubagent({
            childClient: new Client({ host: remoteServer.url }),
            expectedToolName: "remote-sleeper",
            label: "the remote sleeper subagent call",
            parentIterator,
          });
          expect(remote.event.data.remote?.url).toBe(remoteServer.url);
          await waitForStepStarted(remote.iterator, "the remote sleeper model step");

          await expect(response.cancel()).resolves.toBe(true);
          const remoteEvents = await readThroughBoundary({
            iterator: remote.iterator,
            label: "the remote child cancellation boundary",
          });
          const parentEvents = await readThroughBoundary({
            iterator: parentIterator,
            label: "the remote parent cancellation boundary",
          });

          expectCancellationCascade(remoteEvents, "session.failed");
          expectCancellationCascade(parentEvents, "session.waiting");
          expect(parentEvents.some((event) => event.type === "subagent.completed")).toBe(false);
          expect(parentEvents.some((event) => event.type === "message.appended")).toBe(false);
          await expectSessionContinuation({
            session: parentSession,
            sessionId: response.sessionId,
          });
        } finally {
          await parentServer.stop();
        }
      } finally {
        await remoteServer.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "cancels one child turn and continues the parent session",
    async () => {
      const app = await scenarioApp(CANCELLATION_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const session = new Client({ host: server.url }).session();
        const response = await session.send("[wait-for-cancel]");
        const resultPromise = response.result();

        await expect(response.cancel()).resolves.toBe(true);
        const cancelled = await resultPromise;

        expect(cancelled.status).toBe("waiting");
        expect(cancelled.events.find((event) => event.type === "step.failed")?.data).toMatchObject({
          code: "TURN_CANCELLED",
          message: "Turn cancelled by the client.",
        });
        expect(cancelled.events.at(-1)?.type).toBe("session.waiting");

        const followUp = await (
          await session.send("Reply with the exact string `still-alive` and nothing else.")
        ).result();
        expect(followUp.sessionId).toBe(cancelled.sessionId);
        expect(followUp.message).toBe("still-alive");
        expect(followUp.status).toBe("waiting");
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "boots the packaged development server and completes a streamed turn",
    async () => {
      const app = await scenarioApp(DEV_SERVER_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
        const responseText = await response.text();

        expect(
          response.status,
          [
            `Expected ${EVE_HEALTH_ROUTE_PATH} to return 200.`,
            `response body:\n${responseText}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(200);
        expect(JSON.parse(responseText)).toMatchObject({
          ok: true,
          status: "ready",
        });

        let messageResult: Awaited<ReturnType<typeof sendDevelopmentMessage>>;
        try {
          messageResult = await sendDevelopmentMessage({
            message: "hello world",
            session: createDevelopmentSessionState(),
            serverUrl: server.url,
          });
        } catch (error) {
          throw new Error(
            [
              `Expected dev message route to complete without throwing: ${String(error)}`,
              `stdout:\n${server.stdout()}`,
              `stderr:\n${server.stderr()}`,
            ].join("\n\n"),
            { cause: error },
          );
        }

        expect(
          messageResult.events.some((event) => event.type === "message.completed"),
          [
            "Expected dev message route to complete a streamed turn.",
            `events:\n${JSON.stringify(messageResult.events, null, 2)}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(true);
        await wait(1_000);

        const output = `${server.stdout()}\n${server.stderr()}`;
        expect(hasKnownDevBundlingFailure(output)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
