import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client, ClientError, type AgentInfoResult } from "#client/index.js";
import { createTestAgentInfoResult } from "#internal/testing/agent-info-fixture.js";
import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";
import { getApplicationInfo } from "#internal/application/paths.js";
import {
  createActionResultEvent,
  createActionsRequestedEvent,
  createInputRequestedEvent,
  createSessionFailedEvent,
  createSessionWaitingEvent,
  createSubagentCalledEvent,
  createTurnStartedEvent,
} from "#protocol/message.js";
import { createDevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import type { VercelDeploymentResolution } from "#setup/vercel-deployment.js";

import {
  EveTUIRunner,
  registryHandoffAddress,
  type AgentTUIAgentHeader,
  type AgentTUIRenderer,
  type AgentTUIInput,
  type AgentTUISessionOptions,
  type PromptCommandOutcome,
} from "./runner.js";
import { createPromptCommandHandler } from "./prompt-command-handler.js";
import { parsePromptCommand, promptCommandsFor } from "./prompt-commands.js";
import type { AgentTUIConversationView, AgentTUIFailure } from "./conversation-view.js";
import { FakeEveServer, type FakeEveTurn } from "./test/fake-eve-server.js";
import { interruptedError } from "./errors.js";
import type { RemoteAuthFlow } from "./remote-auth.js";
import type { RemoteAuthCompletedMutation } from "./remote-auth-result.js";
import type { RemoteConnectionControllerOptions } from "./remote-connection.js";
import type { BootDetection, BootDetectionContext, SetupIssue } from "./setup-issues.js";
import type { SetupFlowRenderer } from "./setup-flow.js";
import { createFakeSetupFlowRenderer } from "./test/fake-setup-flow-renderer.js";
import type { VercelStatusSnapshot } from "./vercel-status.js";

const REMOTE_VERIFIED_TARGET = await resolveTestVercelTarget({
  host: "vpoke.playground-vercel.tools",
  projectId: "prj_inbound",
  projectName: "inbound",
});
const VERCEL_SSO_URL =
  "https://vercel.com/sso-api?url=https%3A%2F%2Fvpoke.playground-vercel.tools&nonce=test";

describe("registryHandoffAddress", () => {
  it("accepts only a terminal handoff from the self-modification registry tool", () => {
    expect(
      registryHandoffAddress("self-modification__agent", "registry_add", {
        status: "needs-terminal",
        address: "channel/slack",
      }),
    ).toBe("channel/slack");
    expect(
      registryHandoffAddress("other__agent", "registry_add", {
        status: "needs-terminal",
        address: "channel/slack",
      }),
    ).toBeUndefined();
    expect(
      registryHandoffAddress("self-modification__agent", "registry_add", {
        status: "installed",
        address: "extension/browserbase",
      }),
    ).toBeUndefined();
    expect(
      registryHandoffAddress("self-modification__agent", "other_tool", {
        status: "needs-terminal",
        address: "channel/slack",
      }),
    ).toBeUndefined();
  });
});

/**
 * Real `Client` whose network-touching methods are replaced by vi spies.
 * Keeps the runner's option types honest (no double casts) while still
 * never hitting the wire.
 */
function stubClient(): Client {
  return new Client({ host: "http://localhost:3000" });
}

const AGENT_INFO: AgentInfoResult = createTestAgentInfoResult({
  agentRoot: "/tmp/weather-agent/agent",
  appRoot: "/tmp/weather-agent",
  modelId: "gpt-5",
  name: "Weather Agent",
});

beforeEach(() => {
  // The runner normalizes header endpoints from the real process.env; a
  // developer shell exporting gateway credentials must not leak into these
  // boot-state assertions.
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("parsePromptCommand", () => {
  it("parses /model with a provider/model slug", () => {
    expect(parsePromptCommand("/model anthropic/claude-opus-4.6")).toEqual({
      type: "extension",
      name: "model",
      argument: "anthropic/claude-opus-4.6",
    });
  });

  it("trims whitespace around the command and slug", () => {
    expect(parsePromptCommand("  /model   anthropic/claude-opus-4.6  ")).toEqual({
      type: "extension",
      name: "model",
      argument: "anthropic/claude-opus-4.6",
    });
  });

  it("parses bare /model as an empty slug", () => {
    expect(parsePromptCommand("/model")).toEqual({
      type: "extension",
      name: "model",
      argument: "",
    });
  });

  it("recognizes /reset, /cancel, /clear, /compact, /exit, and /quit", () => {
    expect(parsePromptCommand("/reset")).toEqual({ type: "reset" });
    expect(parsePromptCommand("/cancel")).toEqual({ type: "cancel" });
    expect(parsePromptCommand("/clear")).toEqual({ type: "clear" });
    expect(parsePromptCommand("/compact")).toEqual({ type: "compact" });
    expect(parsePromptCommand("/exit")).toEqual({ type: "exit" });
    expect(parsePromptCommand("/quit")).toEqual({ type: "exit" });
  });

  it("does not match near-misses or normal messages", () => {
    expect(parsePromptCommand("hello")).toBeNull();
    expect(parsePromptCommand("/models")).toBeNull();
    expect(parsePromptCommand("what does /model do?")).toBeNull();
  });
});

function fakeRenderer(overrides: Partial<AgentTUIRenderer> = {}): AgentTUIRenderer {
  return {
    readInput: vi.fn(async () => undefined),
    ...overrides,
  };
}

/** Adapts a scripted prompt reader to the composer: text submits, `undefined` leaves. */
function submitting(read: (options?: AgentTUISessionOptions) => Promise<string | undefined>) {
  return vi.fn(async (options?: AgentTUISessionOptions): Promise<AgentTUIInput | undefined> => {
    const text = await read(options);
    return text === undefined ? undefined : { type: "submit", text };
  });
}

/** A composer that submits each text in order, then leaves the session. */
function inputs(texts: Array<string | undefined>) {
  return vi.fn(async (): Promise<AgentTUIInput | undefined> => {
    const text = texts.shift();
    return text === undefined ? undefined : { type: "submit", text };
  });
}

function idleSetupFlow(): SetupFlowRenderer {
  return {
    begin: vi.fn(),
    end: vi.fn(),
    readSelect: vi.fn(async () => undefined),
    readEditableSelect: vi.fn(async () => undefined),
    readProviderPicker: vi.fn(async () => undefined),
    readText: vi.fn(async () => undefined),
    readAcknowledge: vi.fn(async () => {}),
    readChoice: vi.fn(() => ({ choice: Promise.resolve(undefined), close: vi.fn() })),
    setStatus: vi.fn(),
    renderLine: vi.fn(),
    renderOutput: vi.fn(),
    withInheritedStdio: (task) => task(),
    waitForInterrupt: () => ({
      promise: new Promise<"escape" | "ctrl-c">(() => {}),
      dispose: vi.fn(),
    }),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

async function settleAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("EveTUIRunner agent header", () => {
  it("opens the prompt after two seconds when startup inspection stalls", async () => {
    vi.useFakeTimers();
    const client = stubClient();
    vi.spyOn(client, "info").mockImplementation(
      async () => await new Promise<AgentInfoResult>(() => {}),
    );
    const renderer = fakeRenderer();
    const runner = new EveTUIRunner({
      client,
      renderer,
      serverUrl: "http://localhost:3000",
    });
    const run = runner.run();
    await vi.advanceTimersByTimeAsync(1999);
    expect(renderer.readInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(renderer.readInput).toHaveBeenCalled();
    expect(client.info).toHaveBeenCalledOnce();
  });

  it("reports the paint boundary before rendering the startup header", async () => {
    const order: string[] = [];
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    const runner = new EveTUIRunner({
      client,
      renderer: fakeRenderer({
        renderAgentHeader: () => order.push("render"),
      }),
      serverUrl: "http://localhost:3000",
      onBootProgress: (event) => order.push(event.type),
    });

    await runner.run();

    expect(order).toEqual(["phase-started", "phase-finished", "before-first-paint", "render"]);
  });

  it("fetches agent info and renders the startup header", async () => {
    const headers: AgentTUIAgentHeader[] = [];
    const renderer = fakeRenderer({
      renderAgentHeader: (header) => headers.push(header),
    });
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);

    const runner = new EveTUIRunner({
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
    });

    await runner.run();

    expect(headers).toHaveLength(1);
    expect(headers[0]).toEqual({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: AGENT_INFO,
    });
    expect(renderer.readInput).toHaveBeenCalled();
  });

  it("still renders a header when info cannot be fetched", async () => {
    const headers: AgentTUIAgentHeader[] = [];
    const renderer = fakeRenderer({
      renderAgentHeader: (header) => headers.push(header),
    });
    const client = stubClient();
    vi.spyOn(client, "info").mockRejectedValue(new Error("unauthorized"));

    const runner = new EveTUIRunner({
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
    });

    await runner.run();

    expect(headers).toHaveLength(1);
    expect(headers[0]?.info).toBeUndefined();
    expect(headers[0]?.name).toBe("Weather Agent");
  });

  it("retries a transient info failure before rendering the startup header", async () => {
    vi.useFakeTimers();
    const headers: AgentTUIAgentHeader[] = [];
    const renderer = fakeRenderer({
      renderAgentHeader: (header) => headers.push(header),
    });
    const client = stubClient();
    vi.spyOn(client, "info")
      .mockRejectedValueOnce(new ClientError(500, "Runner did not become ready in time"))
      .mockResolvedValueOnce(AGENT_INFO);
    const runner = new EveTUIRunner({
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
    });

    const running = runner.run();
    await settleAsyncWork();
    await vi.advanceTimersByTimeAsync(100);
    await running;

    expect(client.info).toHaveBeenCalledTimes(2);
    expect(headers).toEqual([
      {
        name: "Weather Agent",
        serverUrl: "http://localhost:3000",
        info: AGENT_INFO,
      },
    ]);
  });
});

describe("EveTUIRunner development session continuity", () => {
  it("does not call the cancel API before a session has started", async () => {
    const results: string[] = [];
    const prompts: Array<string | undefined> = ["/cancel", undefined];
    const runner = new EveTUIRunner({
      client: stubClient(),
      name: "Weather Agent",
      renderer: fakeRenderer({
        readInput: inputs(prompts),
        finishCommand: (outcome) => {
          if (outcome.kind === "result") results.push(outcome.message ?? outcome.summary ?? "");
        },
      }),
    });

    await runner.run();

    expect(results).toEqual(["No active turn to cancel"]);
  });
});

describe("EveTUIRunner initial input", () => {
  it("uses the startup draft captured after the agent info probe", async () => {
    const info = createDeferred<typeof AGENT_INFO>();
    const client = stubClient();
    vi.spyOn(client, "info").mockReturnValue(info.promise);
    const startup = {
      finish: vi.fn(() => ({ draft: "typed while loading", queuedPrompt: undefined })),
    };
    const renderer = fakeRenderer();
    const runner = new EveTUIRunner({
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      startup,
    });

    const running = runner.run();
    await settleAsyncWork();
    expect(startup.finish).not.toHaveBeenCalled();
    info.resolve(AGENT_INFO);
    await running;

    expect(startup.finish).toHaveBeenCalledOnce();
    expect(renderer.readInput).toHaveBeenCalledWith(
      expect.objectContaining({ initialDraft: "typed while loading" }),
    );
  });
});

describe("parsePromptCommand", () => {
  it.each([
    ["/reset", { type: "reset" }],
    ["/new", { type: "clear" }],
    ["/exit", { type: "exit" }],
    ["/quit", { type: "exit" }],
    ["/deploy", { type: "extension", name: "deploy", argument: "" }],
    ["  /channels  ", null],
    ["/vercel", null],
    ["/links", null],
    ["deploy", null],
    ["tell me about /channels", null],
  ] as const)("parses %j as %j", (prompt, expected) => {
    expect(parsePromptCommand(prompt)).toEqual(expected);
  });
});

describe("EveTUIRunner remote authentication", () => {
  const target = {
    kind: "remote",
    serverUrl: "https://vpoke.playground-vercel.tools",
    workspaceRoot: "/tmp/weather-agent",
  } as const;

  const unresolvedDeployment: VercelDeploymentResolution = {
    kind: "failed",
    failure: {
      cause: "vercel",
      failure: {
        code: null,
        message: "Vercel deployment lookup failed.",
        stderr: "",
        stdout: "",
      },
    },
  };

  function remoteOptions(
    resolveDeployment: NonNullable<
      RemoteConnectionControllerOptions["resolveDeployment"]
    > = async () => unresolvedDeployment,
  ) {
    return {
      target,
      credentials: createDevelopmentCredentialGate(target.serverUrl),
      resolveDeployment,
      resolveOidcToken: async () => ({
        kind: "resolution-failed" as const,
        message: "No ambient token in this test.",
      }),
    };
  }

  function unauthorized(): ClientError {
    return new ClientError(
      401,
      '{"ok":false,"code":"unauthorized","error":"Authorization is required for this route."}',
    );
  }

  function successfulAuth(
    completedMutations: readonly RemoteAuthCompletedMutation[] = [],
  ): RemoteAuthFlow {
    return vi.fn<RemoteAuthFlow>(async () => ({
      kind: "prepared",
      target: REMOTE_VERIFIED_TARGET,
      resolveToken: async () => "fresh-token",
      completedMutations,
    }));
  }

  async function runRemoteAuth(input: {
    client: Client;
    flow: RemoteAuthFlow;
    renderer?: Partial<AgentTUIRenderer>;
    initialInput?: string;
    resolveDeployment?: NonNullable<RemoteConnectionControllerOptions["resolveDeployment"]>;
  }): Promise<void> {
    await new EveTUIRunner({
      client: input.client,
      renderer: fakeRenderer({ setupFlow: idleSetupFlow(), ...input.renderer }),
      serverUrl: target.serverUrl,
      availablePromptCommands: promptCommandsFor("remote"),
      promptCommandHandler: createPromptCommandHandler({
        target,
      }),
      remote: { ...remoteOptions(input.resolveDeployment), runAuthFlow: input.flow },
      initialInput: input.initialInput,
    }).run();
  }

  it("does not open login after a remote authentication challenge", async () => {
    const client = stubClient();
    const order: string[] = [];
    let infoCalls = 0;
    vi.spyOn(client, "info").mockImplementation(async () => {
      order.push("info");
      if (++infoCalls === 1) throw unauthorized();
      return AGENT_INFO;
    });
    const flow = vi.fn<RemoteAuthFlow>(async () => {
      order.push("login");
      return {
        kind: "prepared",
        target: REMOTE_VERIFIED_TARGET,
        resolveToken: async () => "fresh-token",
        completedMutations: [],
      };
    });
    const commandInvocations: Array<{ text: string; status: "failed" | undefined }> = [];

    await runRemoteAuth({
      client,
      flow,
      resolveDeployment: async () => ({ kind: "not-found" }),
      renderer: {
        renderCommandInvocation: (text) => commandInvocations.push({ text, status: undefined }),
      },
    });

    expect(order).toEqual(["info"]);
    expect(commandInvocations).toEqual([]);
  });

  it.each([
    new ClientError(302, "Redirecting...", { location: VERCEL_SSO_URL }),
    new ClientError(403, "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH"),
  ])(
    "repairs Deployment Protection at startup without echoing a login command (%s)",
    async (challenge) => {
      const client = stubClient();
      vi.spyOn(client, "info").mockRejectedValueOnce(challenge).mockResolvedValueOnce(AGENT_INFO);
      const commandInvocations: Array<{ text: string; status: "failed" | undefined }> = [];
      const flow = successfulAuth();
      const statuses: string[] = [];
      const renderAgentHeader = vi.fn();

      await runRemoteAuth({
        client,
        flow,
        renderer: {
          renderCommandInvocation: (text) => commandInvocations.push({ text, status: undefined }),
          setRemoteConnectionStatus: (snapshot) => statuses.push(snapshot.connection.state),
          renderAgentHeader,
        },
      });

      expect(flow).toHaveBeenCalledWith(
        expect.objectContaining({
          configureTrustedSources: true,
          workspaceRoot: target.workspaceRoot,
          serverUrl: target.serverUrl,
        }),
      );
      expect(client.info).toHaveBeenCalledTimes(2);
      expect(statuses).toContain("authenticating");
      expect(statuses.at(-1)).toBe("ready");
      expect(renderAgentHeader).toHaveBeenLastCalledWith(
        expect.objectContaining({ info: AGENT_INFO }),
      );
      expect(commandInvocations).toEqual([]);
    },
  );

  it("does not open setup when existing remote credentials already work", async () => {
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    const flow = successfulAuth();
    const setupFlow = idleSetupFlow();
    await runRemoteAuth({ client, flow, renderer: { setupFlow } });
    expect(flow).not.toHaveBeenCalled();
    expect(setupFlow.begin).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "failed"] as const)(
    "preserves the draft and closes %s remote setup without retrying",
    async (kind) => {
      const client = stubClient();
      vi.spyOn(client, "info").mockRejectedValue(
        new ClientError(302, "Redirecting...", { location: VERCEL_SSO_URL }),
      );
      const flow = vi.fn<RemoteAuthFlow>(async () =>
        kind === "cancelled"
          ? { kind: "cancelled", completedMutations: [] }
          : {
              kind: "failed",
              message:
                "Could not update Trusted Sources. Check project permissions, then reconnect.",
              completedMutations: [],
            },
      );
      const setupFlow = idleSetupFlow();
      const readInput = vi.fn(async () => undefined);
      const finishCommand = vi.fn();
      await runRemoteAuth({
        client,
        flow,
        initialInput: "Hello Alice",
        renderer: { setupFlow, readInput, finishCommand },
      });
      expect(flow).toHaveBeenCalledOnce();
      expect(client.info).toHaveBeenCalledOnce();
      expect(setupFlow.end).toHaveBeenCalledWith({ preserveDiagnostics: false });
      expect(readInput).toHaveBeenCalledWith(
        expect.objectContaining({ initialDraft: "Hello Alice" }),
      );
      if (kind === "cancelled") expect(finishCommand).not.toHaveBeenCalled();
      else
        expect(finishCommand).toHaveBeenCalledWith({
          kind: "result",
          message: expect.stringContaining("Check project permissions"),
        });
    },
  );

  it("reports a failed access check after applying Trusted Sources instead of declaring success", async () => {
    const client = stubClient();
    vi.spyOn(client, "info").mockRejectedValue(
      new ClientError(302, "Redirecting...", { location: VERCEL_SSO_URL }),
    );
    const flow = successfulAuth([
      { kind: "trusted-sources-updated", targetProjectName: "inbound" },
    ]);
    const finishCommand = vi.fn();
    const statuses: string[] = [];
    await runRemoteAuth({
      client,
      flow,
      renderer: {
        finishCommand,
        setRemoteConnectionStatus: (snapshot) => statuses.push(snapshot.connection.state),
      },
    });
    expect(flow).toHaveBeenCalledOnce();
    expect(client.info).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe("auth-failed");
    expect(finishCommand).toHaveBeenCalledWith({
      kind: "result",
      message: expect.stringContaining("updated Trusted Sources for inbound"),
    });
  });

  it("aborts remote setup during an idle wait and waits for cleanup before releasing input", async () => {
    const client = stubClient();
    vi.spyOn(client, "info").mockRejectedValue(
      new ClientError(302, "Redirecting...", { location: VERCEL_SSO_URL }),
    );
    const interrupt = Promise.withResolvers<"escape" | "ctrl-c">();
    let cleanedUp = false;
    const flow = vi.fn<RemoteAuthFlow>(async ({ signal }) => {
      interrupt.resolve("escape");
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      cleanedUp = true;
      return { kind: "cancelled", completedMutations: [] };
    });
    const dispose = vi.fn();
    const setupFlow = createFakeSetupFlowRenderer({
      waitForInterrupt: () => ({ promise: interrupt.promise, dispose }),
      end: () => expect(cleanedUp).toBe(true),
    });
    await runRemoteAuth({ client, flow, renderer: { setupFlow } });
    expect(cleanedUp).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(client.info).toHaveBeenCalledOnce();
  });

  it("does not start authentication for an ordinary remote HTTP failure", async () => {
    const client = stubClient();
    vi.spyOn(client, "info").mockRejectedValue(new ClientError(503, "Unavailable"));
    const flow = successfulAuth();

    await runRemoteAuth({ client, flow });

    expect(flow).not.toHaveBeenCalled();
  });
});

describe("EveTUIRunner Vercel status line", () => {
  const identity = { projectName: "my-agent", teamName: "acme" };

  it("probes the link identity at startup and pushes it to the renderer", async () => {
    const pushes: VercelStatusSnapshot[] = [];
    const firstPush = createDeferred<void>();
    const detectIdentity = vi.fn(async () => identity);
    const renderer = fakeRenderer({
      // Hold the prompt open until the async probe lands, so the run loop
      // cannot exit (and dispose the tracker) before the push arrives.
      readInput: submitting(async () => {
        await firstPush.promise;
        return undefined;
      }),
      setVercelStatus: (snapshot) => {
        pushes.push(snapshot);
        firstPush.resolve();
      },
    });

    const runner = new EveTUIRunner({
      client: stubClient(),
      renderer,
      name: "Weather Agent",
      appRoot: "/tmp/weather-agent",
      detectProjectIdentity: detectIdentity,
    });
    await runner.run();

    expect(pushes).toEqual([{ identity }]);
    expect(detectIdentity).toHaveBeenCalledWith("/tmp/weather-agent", {
      signal: expect.any(AbortSignal),
    });
  });

  it("applies deploy effects and re-probes", async () => {
    const pushes: VercelStatusSnapshot[] = [];
    const settled = createDeferred<void>();
    let probes = 0;
    // The startup probe never resolves; only the post-deploy re-probe lands,
    // which keeps the push order deterministic.
    const detectIdentity = vi.fn(() => {
      probes += 1;
      return probes === 1 ? new Promise<never>(() => {}) : Promise.resolve(identity);
    });
    const prompts: Array<string | undefined> = ["/deploy"];
    const renderer = fakeRenderer({
      renderNotice: vi.fn(),
      readInput: submitting(async () => {
        const next = prompts.shift();
        if (next !== undefined) return next;
        await settled.promise;
        return undefined;
      }),
      setVercelStatus: (snapshot) => {
        pushes.push(snapshot);
        if (pushes.length >= 2) settled.resolve();
      },
    });
    const outcomes: Record<string, PromptCommandOutcome> = {
      deploy: { message: "Deployed.", effect: { kind: "deployed" } },
    };

    const runner = new EveTUIRunner({
      client: stubClient(),
      renderer,
      name: "Weather Agent",
      appRoot: "/tmp/weather-agent",
      detectProjectIdentity: detectIdentity,
      promptCommandHandler: { handle: async (command) => outcomes[command.name] },
    });
    await runner.run();

    expect(pushes).toEqual([{}, { identity }]);
    expect(detectIdentity).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "refreshes agent info and only rebuilds when requested (reload: %s)",
    async (reload) => {
      const runtimeRequests: Array<{ method: string; url: URL }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          runtimeRequests.push({
            method: init?.method ?? "GET",
            url: new URL(
              typeof input === "string" ? input : input instanceof URL ? input : input.url,
            ),
          });
          return Response.json({ revision: "snapshot-a" });
        }),
      );
      const client = stubClient();
      const info = vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
      const prompts: Array<string | undefined> = ["/deploy", "/model", undefined];
      const infoCallsAtPrompt: number[] = [];
      const renderer = fakeRenderer({
        readInput: submitting(async () => {
          infoCallsAtPrompt.push(info.mock.calls.length);
          return prompts.shift();
        }),
      });
      const deployOutcome: PromptCommandOutcome = {
        message: "Deployed.",
        effect: { kind: "deployed" },
      };
      const modelOutcome: PromptCommandOutcome = {
        message: "Connected to AI Gateway.",
        effect: { kind: "model-access-changed", reload },
      };

      const runner = new EveTUIRunner({
        client,
        renderer,
        serverUrl: "http://localhost:3000",
        name: "Weather Agent",
        appRoot: "/tmp/weather-agent",
        bootDetections: [],
        detectProjectIdentity: vi.fn(async () => undefined),
        promptCommandHandler: {
          handle: async (command) => (command.name === "model" ? modelOutcome : deployOutcome),
        },
      });

      await runner.run();

      expect(infoCallsAtPrompt).toEqual([1, 1, 2]);
      expect(info).toHaveBeenCalledTimes(2);
      expect(
        runtimeRequests.some(
          (request) =>
            request.method === "POST" &&
            request.url.pathname === "/eve/v1/dev/runtime-artifacts/rebuild" &&
            request.url.searchParams.get("force") === "1",
        ),
      ).toBe(reload);
    },
  );

  it("never pushes Vercel status for a remote --url session", async () => {
    const setVercelStatus = vi.fn();
    const renderer = fakeRenderer({ setVercelStatus });

    const runner = new EveTUIRunner({
      client: stubClient(),
      renderer,
      name: "Weather Agent",
    });
    await runner.run();

    expect(setVercelStatus).not.toHaveBeenCalled();
  });
});

describe("EveTUIRunner gateway-auth failure rendering", () => {
  const gatewayFailure = {
    code: "MODEL_CALL_FAILED",
    message: "AI Gateway received no credentials.",
    details: {
      errorId: "err-1",
      name: "AI Gateway authentication failed",
      semanticErrorId: "gateway-auth-missing-credentials",
      hint: "Run `eve link` to populate `VERCEL_OIDC_TOKEN`, or set `AI_GATEWAY_API_KEY`…",
    },
  };

  async function failuresFor(appRoot?: string): Promise<readonly AgentTUIFailure[]> {
    const server = new FakeEveServer(({ turnId }) => [
      { type: "step.failed", data: { ...gatewayFailure, sequence: 0, stepIndex: 0, turnId } },
      createSessionWaitingEvent(),
    ]);
    vi.stubGlobal("fetch", server.fetch);
    const views: AgentTUIConversationView[] = [];
    const failed = createDeferred<void>();
    const renderer: AgentTUIRenderer = {
      readInput: vi
        .fn<NonNullable<AgentTUIRenderer["readInput"]>>()
        .mockResolvedValueOnce({ type: "submit", text: "hello" })
        .mockImplementationOnce(async () => {
          await failed.promise;
          return undefined;
        }),
      renderConversation: (view) => {
        views.push(view);
        if (view.failures.length > 0) failed.resolve();
      },
    };
    const options: ConstructorParameters<typeof EveTUIRunner>[0] = {
      client: stubClient(),
      renderer,
      name: "Weather Agent",
    };
    if (appRoot !== undefined) options.appRoot = appRoot;
    await new EveTUIRunner(options).run();
    return views.at(-1)?.failures ?? [];
  }

  it("swaps the hint for the local /model fix when setup commands are available", async () => {
    const failures = await failuresFor("/tmp/weather-agent");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain("MODEL_CALL_FAILED");
    expect(failures[0]!.hint).toBe(
      "Run /model to connect this to a project and refresh AI Gateway credentials, or set AI_GATEWAY_API_KEY manually in .env.local.",
    );
  });

  it("keeps the harness hint when the TUI has no local project to link", async () => {
    const failures = await failuresFor(undefined);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain("MODEL_CALL_FAILED");
    expect(failures[0]!.hint).toContain("eve link");
    expect(failures[0]!.hint).not.toContain("/model");
  });
});

describe("EveTUIRunner boot setup detection", () => {
  const disconnectedGatewayInfo: AgentInfoResult = {
    ...AGENT_INFO,
    agent: {
      ...AGENT_INFO.agent,
      model: {
        id: "gpt-5",
        routing: { kind: "gateway" as const, target: "openai" },
        endpoint: { kind: "gateway" as const, connected: false as const },
      },
    },
  };

  function bootRunner(input: { appRoot?: string; issues: SetupIssue[] }) {
    const warnings: string[] = [];
    const renderer: AgentTUIRenderer = {
      readInput: submitting(async () => undefined),
      renderSetupWarning: (text) => warnings.push(text),
    };
    const options: ConstructorParameters<typeof EveTUIRunner>[0] = {
      client: stubClient(),
      renderer,
      name: "Weather Agent",
      bootDetections: [{ id: "test", detect: () => input.issues }],
    };
    if (input.appRoot !== undefined) options.appRoot = input.appRoot;
    return { runner: new EveTUIRunner(options), warnings };
  }

  function providerSetupRefreshRunner(input: {
    refreshInfo: () => Promise<AgentInfoResult>;
    renderer?: Partial<AgentTUIRenderer>;
    bootDetections?: BootDetection[];
  }) {
    const client = stubClient();
    vi.spyOn(client, "info")
      .mockResolvedValueOnce(disconnectedGatewayInfo)
      .mockImplementationOnce(input.refreshInfo);
    const renderer = fakeRenderer({
      renderSetupWarning: vi.fn(),
      setupFlow: createFakeSetupFlowRenderer(),
      ...input.renderer,
    });
    const runner = new EveTUIRunner({
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
      appRoot: "/tmp/weather-agent",
      onboard: true,
      bootDetections: input.bootDetections ?? [
        {
          id: "test",
          detect: () => [
            {
              kind: "attention",
              label: "model provider not linked",
              command: "/model",
            },
          ],
        },
      ],
      detectProjectIdentity: vi.fn(async () => undefined),
      getVercelAuthStatus: vi.fn(async (): Promise<"authenticated"> => "authenticated"),
      promptCommandHandler: {
        handle: async (command) =>
          command.name === "login"
            ? {
                message: "AI Gateway via API key selected.",
                effect: {
                  kind: "model-access-changed",
                  reload: false,
                  model: {
                    id: "gpt-5",
                    routing: { kind: "gateway", target: "openai" },
                    endpoint: { kind: "gateway", connected: true, credential: "api-key" },
                  },
                },
              }
            : { message: "/add dismissed." },
      },
    });

    return { client, runner };
  }

  it("surfaces detected issues as the attention line at boot", async () => {
    const { runner, warnings } = bootRunner({
      appRoot: "/tmp/weather-agent",
      issues: [{ kind: "attention", label: "AI Gateway credentials", command: "/model" }],
    });
    await runner.run();

    expect(warnings).toEqual(["1 setup issue: AI Gateway credentials · /model"]);
  });

  it("clears a startup warning when a later agent-info probe reports connected OAuth", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ revision: "snapshot-a" })),
    );
    const connectedGatewayInfo: AgentInfoResult = {
      ...AGENT_INFO,
      agent: {
        ...AGENT_INFO.agent,
        model: {
          id: "gpt-5",
          routing: { kind: "gateway", target: "openai" },
          endpoint: {
            kind: "gateway",
            connected: true,
            credential: "oauth",
            team: "alice",
          },
        },
      },
    };
    const client = stubClient();
    vi.spyOn(client, "info")
      .mockRejectedValueOnce(new Error("server not ready"))
      .mockResolvedValue(connectedGatewayInfo);
    const warningCleared = createDeferred<void>();
    const renderSetupWarning = vi.fn();
    const clearSetupWarning = vi.fn(() => warningCleared.resolve());
    const detect = vi.fn(({ info }: BootDetectionContext) =>
      info === undefined
        ? [{ kind: "attention" as const, label: "connect a model", command: "/login" }]
        : [],
    );
    const runner = new EveTUIRunner({
      client,
      renderer: fakeRenderer({
        renderSetupWarning,
        clearSetupWarning,
        readInput: submitting(async () => {
          await warningCleared.promise;
          return undefined;
        }),
      }),
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
      appRoot: "/tmp/weather-agent",
      bootDetections: [{ id: "test", detect }],
      detectProjectIdentity: vi.fn(async () => undefined),
    });

    await runner.run();

    expect(renderSetupWarning).toHaveBeenCalledWith("1 setup issue: connect a model · /login");
    expect(clearSetupWarning).toHaveBeenCalled();
    expect(client.info).toHaveBeenCalledTimes(2);
    expect(detect.mock.calls.at(-1)?.[0].info).toBe(connectedGatewayInfo);
  });

  it("releases the composer while /info is still pending and ignores its result after exit", async () => {
    const refreshed = createDeferred<AgentInfoResult>();
    const renderAgentHeader = vi.fn();
    const finishCommand = vi.fn();
    const renderSetupWarning = vi.fn();
    const readInput = vi.fn(async () => undefined);
    const setStartupPhase = vi.fn();
    const { client, runner } = providerSetupRefreshRunner({
      refreshInfo: () => refreshed.promise,
      bootDetections: [],
      renderer: {
        renderAgentHeader,
        finishCommand,
        renderSetupWarning,
        readInput,
        setStartupPhase,
      },
    });
    const run = runner.run();
    await vi.waitFor(() => expect(readInput).toHaveBeenCalledOnce());
    expect(client.info).toHaveBeenCalledTimes(2);
    expect(finishCommand).not.toHaveBeenCalled();
    expect(renderSetupWarning).not.toHaveBeenCalled();
    expect(setStartupPhase).toHaveBeenLastCalledWith(undefined);
    await run;
    const paints = renderAgentHeader.mock.calls.length;
    refreshed.resolve(AGENT_INFO);
    await Promise.resolve();
    expect(renderAgentHeader).toHaveBeenCalledTimes(paints);
  });

  it("releases the composer without waiting on unrelated setup diagnostics", async () => {
    const diagnostics = createDeferred<Awaited<ReturnType<BootDetection["detect"]>>>();
    const detect = vi.fn(() => diagnostics.promise);
    const readInput = vi.fn(async () => undefined);
    const { runner } = providerSetupRefreshRunner({
      refreshInfo: async () => AGENT_INFO,
      bootDetections: [{ id: "slow", detect }],
      renderer: { readInput },
    });
    const run = runner.run();
    try {
      await vi.waitFor(() => expect(readInput).toHaveBeenCalledOnce());
      expect(detect).toHaveBeenCalledOnce();
    } finally {
      diagnostics.resolve([]);
      await run;
    }
  });

  it("normalizes a committed local key after automatic provider setup", async () => {
    const clearSetupWarning = vi.fn();
    const headers: AgentTUIAgentHeader[] = [];
    const detect = vi.fn(({ info }: { info?: AgentInfoResult }) =>
      info?.agent.model.endpoint?.kind === "gateway" && !info.agent.model.endpoint.connected
        ? [
            {
              kind: "attention" as const,
              label: "model provider not linked",
              command: "/model" as const,
            },
          ]
        : [],
    );
    const { client, runner } = providerSetupRefreshRunner({
      refreshInfo: async () => {
        vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
        return disconnectedGatewayInfo;
      },
      bootDetections: [{ id: "test", detect }],
      renderer: {
        clearSetupWarning,
        renderAgentHeader: (header) => headers.push(header),
      },
    });

    await runner.run();
    await vi.waitFor(() => expect(clearSetupWarning).toHaveBeenCalled());

    expect(client.info).toHaveBeenCalledTimes(2);
    expect(detect.mock.calls.at(-1)?.[0].info?.agent.model.endpoint).toEqual({
      kind: "gateway",
      connected: true,
      credential: "api-key",
    });
    expect(headers.map((header) => header.info?.agent.model.endpoint)).toEqual([
      { kind: "gateway", connected: true, credential: "api-key" },
    ]);
  });

  it("drops stale disconnected evidence when the post-setup info refresh fails", async () => {
    const clearSetupWarning = vi.fn();
    const finishCommand = vi.fn();
    const headers: AgentTUIAgentHeader[] = [];
    const detect = vi.fn(({ info }: { info?: AgentInfoResult }) =>
      info?.agent.model.endpoint?.kind === "gateway" && !info.agent.model.endpoint.connected
        ? [
            {
              kind: "attention" as const,
              label: "model provider not linked",
              command: "/model" as const,
            },
          ]
        : [],
    );
    const { client, runner } = providerSetupRefreshRunner({
      refreshInfo: async () => {
        throw new Error("info unavailable");
      },
      bootDetections: [{ id: "test", detect }],
      renderer: {
        clearSetupWarning,
        finishCommand,
        renderAgentHeader: (header) => headers.push(header),
      },
    });

    await runner.run();
    await vi.waitFor(() => expect(clearSetupWarning).toHaveBeenCalled());

    expect(finishCommand).not.toHaveBeenCalled();
    expect(client.info).toHaveBeenCalledTimes(2);
    expect(detect).not.toHaveBeenCalled();
    expect(headers.at(-1)?.info?.agent.model.endpoint).toMatchObject({
      kind: "gateway",
      connected: true,
    });
  });

  it("stays quiet without a local setup context, even with issues", async () => {
    const { runner, warnings } = bootRunner({
      issues: [{ kind: "attention", label: "AI Gateway credentials", command: "/model" }],
    });
    await runner.run();

    expect(warnings).toEqual([]);
  });

  it("stays quiet when detection finds nothing", async () => {
    const { runner, warnings } = bootRunner({
      appRoot: "/tmp/weather-agent",
      issues: [],
    });
    await runner.run();

    expect(warnings).toEqual([]);
  });
});

describe("EveTUIRunner command shutdown", () => {
  it("unwinds a blocked prompt", async () => {
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    const prompt = createDeferred<AgentTUIInput | undefined>();
    const controller = new AbortController();
    const renderer: AgentTUIRenderer = {
      readInput: vi.fn(() => prompt.promise),
      renderAgentHeader: vi.fn(),
      requestInterrupt: vi.fn(() => prompt.reject(interruptedError())),
    };
    const runner = new EveTUIRunner({
      client,
      renderer,
      lifecycle: {
        signal: controller.signal,
        stopped: new Promise<NodeJS.Signals | undefined>(() => {}),
        requestStop: () => controller.abort(),
        dispose: () => {},
      },
    });

    const run = runner.run();
    await settleAsyncWork();
    controller.abort();

    await expect(run).resolves.toBeUndefined();
    expect(renderer.requestInterrupt).toHaveBeenCalledOnce();
  });
});

/** Serves session routes from an in-memory eve; other routes use `fallback`. */
function serve(respond?: FakeEveTurn, fallback?: typeof fetch): FakeEveServer {
  const server = new FakeEveServer(respond, fallback);
  vi.stubGlobal("fetch", server.fetch);
  return server;
}

/**
 * A composer that submits each text once the previous turn settles, then
 * leaves. It closes when the runner needs the keyboard for something else.
 */
function turnTaking(texts: Array<string | undefined>, overrides: Partial<AgentTUIRenderer> = {}) {
  const views: AgentTUIConversationView[] = [];
  const renderer: AgentTUIRenderer = {
    renderConversation: (view) => views.push(view),
    readInput: vi.fn(async (options?: AgentTUISessionOptions) => {
      const closed = new Promise<"closed">((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve("closed"), { once: true }),
      );
      const idle = vi
        .waitFor(() => {
          if (views.at(-1)?.working === true) throw new Error("A turn is still running.");
        })
        .then(() => "idle" as const);
      if ((await Promise.race([closed, idle])) === "closed") return undefined;
      const text = texts.shift();
      return text === undefined ? undefined : ({ type: "submit", text } as const);
    }),
    ...overrides,
  };
  return { renderer, views };
}

function registryResult(callId: string, address: string, toolName = "selfmod__registry_add") {
  return [
    createActionsRequestedEvent({
      actions: [{ callId, input: { address }, kind: "tool-call", toolName }],
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
    }),
    createActionResultEvent({
      result: {
        callId,
        kind: "tool-result",
        output: { status: "needs-terminal", address },
        toolName,
      },
      sequence: 2,
      stepIndex: 0,
      turnId: "turn_1",
    }),
  ];
}

describe("EveTUIRunner registry handoffs", () => {
  const localOptions = {
    name: "Weather Agent",
    appRoot: "/tmp/weather-agent",
    bootDetections: [],
    detectProjectIdentity: vi.fn(async () => undefined),
  };

  it("opens every distinct registry handoff in result order", async () => {
    serve(({ turnId }) => [
      createTurnStartedEvent({ sequence: 0, turnId }),
      ...registryResult("slack-add", "channel/slack"),
      ...registryResult("linear-add", "connection/linear"),
      createSessionWaitingEvent(),
    ]);
    const handle = vi.fn(async (_command: { name: string; argument: string }) => ({
      message: "done",
    }));
    await new EveTUIRunner({
      ...localOptions,
      client: stubClient(),
      renderer: turnTaking(["Add integrations.", undefined]).renderer,
      promptCommandHandler: { handle },
    }).run();

    expect(handle.mock.calls.map(([command]) => command)).toEqual([
      { type: "extension", name: "add", argument: "channel/slack" },
      { type: "extension", name: "add", argument: "connection/linear" },
    ]);
  });

  it("answers an approval before opening setup queued by the same turn", async () => {
    const order: string[] = [];
    const server = serve(({ body, turnId }) =>
      body?.inputResponses !== undefined
        ? (order.push("respond"), [createSessionWaitingEvent()])
        : [
            createTurnStartedEvent({ sequence: 0, turnId }),
            ...registryResult("registry-add", "channel/slack"),
            createInputRequestedEvent({
              requests: [
                {
                  action: {
                    callId: "write-file",
                    input: { path: "agent.ts" },
                    kind: "tool-call",
                    toolName: "write_file",
                  },
                  kind: "tool-approval",
                  prompt: "Approve write_file",
                  requestId: "approval-1",
                },
              ],
              sequence: 3,
              stepIndex: 0,
              turnId,
            }),
            createSessionWaitingEvent(),
          ],
    );
    await new EveTUIRunner({
      ...localOptions,
      client: stubClient(),
      renderer: turnTaking(["Add Slack.", undefined], {
        readToolApproval: vi.fn(async () => ({ approved: true })),
      }).renderer,
      promptCommandHandler: {
        handle: async () => {
          order.push("setup");
          return { message: "done" };
        },
      },
    }).run();

    expect(order).toEqual(["respond", "setup"]);
    expect(server.requestsTo("POST", "/session_1")[0]?.body).toMatchObject({
      inputResponses: [{ requestId: "approval-1", optionId: "approve" }],
    });
  });

  it("opens a registry handoff that a subagent reports on its own stream", async () => {
    const server = serve(({ turnId }) => [
      createTurnStartedEvent({ sequence: 0, turnId }),
      createSubagentCalledEvent({
        callId: "selfmod-call",
        childSessionId: "child_1",
        name: "self-modification__agent",
        sequence: 1,
        sessionId: "session_1",
        toolName: "self-modification__agent",
        turnId,
        workflowId: "workflow_1",
      }),
    ]);
    const handle = vi.fn(async () => ({ message: "Slack setup completed." }));
    const run = new EveTUIRunner({
      ...localOptions,
      client: stubClient(),
      renderer: turnTaking(["Add Slack.", undefined]).renderer,
      promptCommandHandler: { handle },
    }).run();
    await vi.waitFor(() => expect(server.requestsTo("GET", "/child_1/stream")).toHaveLength(1));
    server.emit(
      [
        createTurnStartedEvent({ sequence: 0, turnId: "child_turn" }),
        ...registryResult("registry-add", "channel/slack", "registry_add"),
        createSessionWaitingEvent(),
      ],
      undefined,
      "child_1",
    );
    server.emit([createSessionWaitingEvent()], "delivery_1", "session_1");
    await run;

    expect(handle).toHaveBeenCalledWith(
      { type: "extension", name: "add", argument: "channel/slack" },
      expect.objectContaining({ title: "Add to your agent" }),
    );
  });
});

describe("EveTUIRunner session commands", () => {
  function results() {
    const outcomes: string[] = [];
    return {
      outcomes,
      finishCommand: (outcome: Parameters<NonNullable<AgentTUIRenderer["finishCommand"]>>[0]) => {
        outcomes.push(
          outcome.kind === "result" ? (outcome.summary ?? outcome.message ?? "") : "dismissed",
        );
      },
    };
  }

  it("compacts and clears the active session without sending a message", async () => {
    const server = serve();
    const { outcomes, finishCommand } = results();
    await new EveTUIRunner({
      client: stubClient(),
      renderer: turnTaking(["Hello.", "/compact", "/clear", undefined], { finishCommand }).renderer,
    }).run();

    expect(outcomes).toEqual(["Compaction requested", "dismissed"]);
    expect(server.requestsTo("POST", "/session_1/compact")).toHaveLength(1);
    expect(server.requestsTo("POST", "/session_1/clear")).toHaveLength(1);
    expect(server.requestsTo("POST", "/session_1")).toHaveLength(0);
  });

  it("keeps the conversation when /reset cannot retire the session", async () => {
    const server = new FakeEveServer();
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith("/reset")
        ? new Response("unavailable", { status: 503 })
        : await server.fetch(input, init),
    );
    const { outcomes, finishCommand } = results();
    const reset = vi.fn();
    await new EveTUIRunner({
      client: stubClient(),
      renderer: turnTaking(["Hello.", "/reset", "Still here?", undefined], { finishCommand, reset })
        .renderer,
    }).run();

    expect(reset).not.toHaveBeenCalled();
    expect(outcomes[0]).toContain("Couldn't reset the session");
    expect(server.requestsTo("POST", "/session_1")).toHaveLength(1);
  });

  it("keeps the last session id for the parting line across /reset", async () => {
    serve();
    const reported: string[] = [];
    await new EveTUIRunner({
      client: stubClient(),
      renderer: turnTaking(["Hello.", "/reset", undefined], {
        setSessionId: (sessionId) => reported.push(sessionId),
      }).renderer,
    }).run();

    expect(new Set(reported)).toEqual(new Set(["session_1"]));
  });

  it("keeps the session across an HMR runtime revision", async () => {
    const revisions = ["revision-a", "revision-a", "revision-b", "revision-b"];
    const server = serve(undefined, async () =>
      Response.json({ revision: revisions.shift() ?? "revision-b" }),
    );
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    await new EveTUIRunner({
      client,
      renderer: turnTaking(["First.", "Second.", undefined]).renderer,
      serverUrl: "http://localhost:3000",
    }).run();

    expect(
      server.requests.filter((request) => request.method === "POST").map((request) => request.path),
    ).toEqual(["/eve/v1/session", "/eve/v1/session/session_1"]);
  });

  it("flushes delayed dev build errors before sending a message, not for slash commands", async () => {
    const calls: string[] = [];
    const server = new FakeEveServer();
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") calls.push("send");
      return await server.fetch(input, init);
    });
    await new EveTUIRunner({
      client: stubClient(),
      renderer: turnTaking(["/help", "Hello.", undefined], {
        renderNotice: vi.fn(),
        flushDelayedDevBuildErrors: () => calls.push("flush"),
      }).renderer,
    }).run();

    expect(calls).toEqual(["flush", "send"]);
  });

  it("opens the trace viewer for the current session", async () => {
    serve();
    const open = vi.fn(async () => {});
    await new EveTUIRunner({
      client: stubClient(),
      appRoot: "/tmp/weather-agent",
      bootDetections: [],
      detectProjectIdentity: vi.fn(async () => undefined),
      renderer: turnTaking(["Hello.", "/traces abc123", undefined], { traceViewer: { open } })
        .renderer,
    }).run();

    expect(open).toHaveBeenCalledWith({
      appRoot: "/tmp/weather-agent",
      sessionId: "session_1",
      reference: "abc123",
    });
  });
});

describe("EveTUIRunner requests", () => {
  it("submits the chosen session-limit continuation", async () => {
    const server = serve(({ body, turnId }) =>
      body?.inputResponses !== undefined
        ? [createSessionWaitingEvent()]
        : [
            createTurnStartedEvent({ sequence: 0, turnId }),
            createInputRequestedEvent({
              requests: [
                {
                  action: {
                    callId: "limit",
                    input: {},
                    kind: "tool-call",
                    toolName: "eve:session-limit",
                  },
                  kind: "session-limit",
                  options: [
                    { id: "continue", label: "Continue" },
                    { id: "stop", label: "Stop" },
                  ],
                  prompt: "Alice's session reached its step limit. Continue?",
                  requestId: "limit-1",
                },
              ],
              sequence: 1,
              stepIndex: 0,
              turnId,
            }),
            createSessionWaitingEvent(),
          ],
    );
    const readInputQuestion = vi.fn(async () => ({ optionId: "continue" }));
    await new EveTUIRunner({
      client: stubClient(),
      renderer: turnTaking(["Keep going.", undefined], { readInputQuestion }).renderer,
    }).run();

    expect(readInputQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "limit-1", display: "select" }),
      expect.any(Object),
    );
    expect(server.requestsTo("POST", "/session_1")[0]?.body).toMatchObject({
      inputResponses: [{ requestId: "limit-1", optionId: "continue" }],
    });
  });

  it("leaves a skipped question open without asking it again", async () => {
    const server = serve(({ turnId }) => [
      createTurnStartedEvent({ sequence: 0, turnId }),
      createInputRequestedEvent({
        requests: [
          {
            action: { callId: "ask", input: {}, kind: "tool-call", toolName: "ask_question" },
            kind: "question",
            prompt: "Which of Bob's reports?",
            requestId: "question-1",
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId,
      }),
      createSessionWaitingEvent(),
    ]);
    const readInputQuestion = vi.fn(async () => undefined);
    const readInput = vi.fn().mockResolvedValueOnce({ type: "submit", text: "Summarize." });
    const { renderer } = turnTaking([undefined], { readInputQuestion });
    const scripted = renderer.readInput!;
    renderer.readInput = (options) =>
      readInput.mock.calls.length === 0 ? readInput(options) : scripted(options);
    await new EveTUIRunner({ client: stubClient(), renderer }).run();

    expect(readInputQuestion).toHaveBeenCalledOnce();
    expect(server.requestsTo("POST", "/session_1")).toHaveLength(0);
  });
});

describe("EveTUIRunner startup input", () => {
  it.each(["cancelled", "error"] as const)(
    "keeps startup input through login and restores queued messages on %s",
    async (result) => {
      const server = serve();
      const login = createDeferred<void>();
      const startup = {
        finish: vi.fn(() => ({ draft: "still editing", queuedPrompt: "Hello Alice" })),
      };
      const handle = vi.fn(async () => {
        await login.promise;
        return result === "cancelled"
          ? { cancelled: true as const, message: "Connect a model with /login when you’re ready." }
          : { failed: true as const, message: "Could not connect. Retry with /login." };
      });
      const renderer = fakeRenderer({
        setupFlow: createFakeSetupFlowRenderer(),
        renderCommandInvocation: vi.fn(),
        finishCommand: vi.fn(),
      });
      const run = new EveTUIRunner({
        client: stubClient(),
        renderer,
        startup,
        appRoot: "/tmp/agent",
        onboard: true,
        bootDetections: [],
        promptCommandHandler: { handle },
      }).run();
      await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
      expect(startup.finish).not.toHaveBeenCalled();
      login.resolve();
      await run;
      expect(server.requests).toEqual([]);
      expect(renderer.readInput).toHaveBeenCalledWith(
        expect.objectContaining({ initialDraft: "Hello Alice\n\nstill editing" }),
      );
      expect(renderer.renderCommandInvocation).not.toHaveBeenCalled();
    },
  );

  it("sends startup messages queued while the agent builds, then restores the draft", async () => {
    const server = serve();
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    const { renderer } = turnTaking([undefined]);
    await new EveTUIRunner({
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      startup: {
        finish: () => ({ draft: "still editing", queuedPrompt: "first message\n\nsecond message" }),
      },
    }).run();

    expect(server.requestsTo("POST", "/eve/v1/session")[0]?.body).toMatchObject({
      message: "first message\n\nsecond message",
    });
    expect(renderer.readInput).toHaveBeenCalledWith(
      expect.objectContaining({ initialDraft: "still editing" }),
    );
  });

  it("seeds only the first prompt's draft with --input text", async () => {
    const server = serve();
    const { renderer } = turnTaking(["edited and sent", undefined]);
    await new EveTUIRunner({ client: stubClient(), renderer, initialInput: "draft me" }).run();

    expect(
      vi.mocked(renderer.readInput!).mock.calls.map(([options]) => options?.initialDraft),
    ).toEqual(["draft me", undefined]);
    expect(server.requestsTo("POST", "/eve/v1/session")[0]?.body).toMatchObject({
      message: "edited and sent",
    });
  });
});

describe("EveTUIRunner remote session failures", () => {
  const target = {
    kind: "remote",
    serverUrl: "https://vpoke.playground-vercel.tools",
    workspaceRoot: "/tmp/weather-agent",
  } as const;
  const remote = {
    target,
    credentials: createDevelopmentCredentialGate(target.serverUrl),
    resolveDeployment: async (): Promise<VercelDeploymentResolution> => ({
      kind: "failed",
      failure: {
        cause: "vercel",
        failure: { code: null, message: "lookup failed", stderr: "", stdout: "" },
      },
    }),
    resolveOidcToken: async () => ({ kind: "resolution-failed" as const, message: "none" }),
  };

  it("demotes a ready remote after a send fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("socket down", { status: 502 }));
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    const statuses: string[] = [];
    await new EveTUIRunner({
      client,
      renderer: turnTaking(["Hello.", undefined], {
        renderError: vi.fn(),
        setRemoteConnectionStatus: (snapshot) => statuses.push(snapshot.connection.state),
      }).renderer,
      serverUrl: target.serverUrl,
      remote,
    }).run();

    expect(statuses.at(-1)).toBe("unavailable");
  });

  it("keeps a ready remote connected after an agent session failure", async () => {
    serve(({ turnId }) => [
      createTurnStartedEvent({ sequence: 0, turnId }),
      createSessionFailedEvent({
        code: "HookConflictError",
        message: "HookConflictError: token in use",
        sessionId: "session_1",
      }),
    ]);
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    const statuses: string[] = [];
    await new EveTUIRunner({
      client,
      renderer: turnTaking(["Hello.", undefined], {
        setRemoteConnectionStatus: (snapshot) => statuses.push(snapshot.connection.state),
      }).renderer,
      serverUrl: target.serverUrl,
      remote,
    }).run();

    expect(statuses.at(-1)).toBe("ready");
    expect(statuses).not.toContain("unavailable");
  });
});

describe("EveTUIRunner teardown", () => {
  it("shuts the renderer down when the run loop exits with an error", async () => {
    const shutdown = vi.fn();
    const runner = new EveTUIRunner({
      client: stubClient(),
      renderer: fakeRenderer({
        readInput: vi.fn(async () => {
          throw new Error("renderer exploded");
        }),
        shutdown,
      }),
    });

    await expect(runner.run()).rejects.toThrow("renderer exploded");
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("propagates command-handler errors after restoring the renderer", async () => {
    const shutdown = vi.fn();
    const runner = new EveTUIRunner({
      client: stubClient(),
      renderer: fakeRenderer({ readInput: inputs(["/model"]), shutdown }),
      appRoot: "/tmp/weather-agent",
      bootDetections: [],
      detectProjectIdentity: vi.fn(async () => undefined),
      promptCommandHandler: {
        handle: async () => {
          throw new Error("command implementation failed");
        },
      },
    });

    await expect(runner.run()).rejects.toThrow("command implementation failed");
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("shuts the renderer down once when /exit ends the run loop", async () => {
    const shutdown = vi.fn();
    const controller = new AbortController();
    const requestStop = vi.fn(() => controller.abort());
    await new EveTUIRunner({
      client: stubClient(),
      renderer: fakeRenderer({ readInput: inputs(["/exit"]), shutdown }),
      lifecycle: {
        signal: controller.signal,
        stopped: new Promise<NodeJS.Signals | undefined>(() => {}),
        requestStop,
        dispose: () => {},
      },
    }).run();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(requestStop).toHaveBeenCalledOnce();
  });
});

describe("EveTUIRunner local commands", () => {
  function recorder(prompts: Array<string | undefined>, overrides: Partial<AgentTUIRenderer> = {}) {
    const outcomes: string[] = [];
    const renderer = fakeRenderer({
      readInput: inputs(prompts),
      finishCommand: (outcome) => {
        if (outcome.kind === "result") outcomes.push(outcome.message ?? outcome.summary ?? "");
      },
      ...overrides,
    });
    return { renderer, outcomes };
  }

  it("answers /help with the command table even without a command handler", async () => {
    const { renderer, outcomes } = recorder(["/help", undefined]);
    await new EveTUIRunner({ client: stubClient(), renderer }).run();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toContain("/model");
    expect(outcomes[0]).not.toContain("/channels");
  });

  it("renders /info from the local application inspector", async () => {
    const { renderer, outcomes } = recorder(["/info", undefined]);
    const inspectApplication = vi.fn(async () => ({
      application: getApplicationInfo("/tmp/weather-agent"),
      compiledState: null,
      messaging: {
        createSessionRoutePath: "/eve/v1/session",
        sessionMessagesRoutePattern: "/eve/v1/session/:sessionId",
        streamRoutePattern: "/eve/v1/session/:sessionId/stream",
      },
    }));
    await new EveTUIRunner({
      client: stubClient(),
      renderer,
      appRoot: "/tmp/weather-agent",
      bootDetections: [],
      detectProjectIdentity: vi.fn(async () => undefined),
      inspectApplication,
    }).run();

    expect(inspectApplication).toHaveBeenCalledWith("/tmp/weather-agent");
    expect(outcomes[0]).toMatch(/^Application\n/u);
  });

  it("dispatches /loglevel to the renderer and reports the outcome", async () => {
    const modes: string[] = [];
    const { renderer, outcomes } = recorder(
      ["/loglevel none", "/loglevel bogus", "/loglevel sandbox", undefined],
      { logDisplayMode: () => "all", setLogDisplayMode: (mode) => modes.push(mode) },
    );
    await new EveTUIRunner({ client: stubClient(), renderer }).run();

    expect(modes).toEqual(["none", "sandbox"]);
    expect(outcomes[0]).toContain("hidden");
    expect(outcomes[1]).toContain('Unknown log level "bogus"');
    expect(outcomes[2]).toContain("sandbox");
  });

  it("reports /loglevel as unavailable when the renderer cannot toggle logs", async () => {
    const { renderer, outcomes } = recorder(["/loglevel none", undefined]);
    await new EveTUIRunner({ client: stubClient(), renderer }).run();

    expect(outcomes).toEqual(["/loglevel is not available in this session."]);
  });

  it("prefers the elbow-styled command result over a plain notice", async () => {
    const notices: string[] = [];
    const { renderer, outcomes } = recorder(["/deploy", undefined], {
      renderNotice: (text) => notices.push(text),
    });
    await new EveTUIRunner({
      client: stubClient(),
      renderer,
      promptCommandHandler: createPromptCommandHandler({
        target: {
          kind: "remote",
          workspaceRoot: "/tmp/weather-agent",
          serverUrl: "https://example.com/",
        },
      }),
    }).run();

    expect(outcomes[0]).toContain("remote agent");
    expect(notices).toEqual([]);
  });
});

describe("EveTUIRunner onboarding", () => {
  it("starts onboarding without login history and preserves the input draft", async () => {
    const order: string[] = [];
    const renderer = fakeRenderer({
      setupFlow: createFakeSetupFlowRenderer(),
      renderCommandInvocation: vi.fn(),
      finishCommand: vi.fn(),
      readInput: vi.fn(async (options?: AgentTUISessionOptions) => {
        order.push("prompt");
        expect(options?.initialDraft).toBe("Hello Alice");
        return undefined;
      }),
    });
    await new EveTUIRunner({
      client: stubClient(),
      renderer,
      name: "Agent",
      appRoot: "/tmp/agent",
      onboard: true,
      initialInput: "Hello Alice",
      bootDetections: [],
      promptCommandHandler: {
        handle: async (command) => {
          order.push(command.name);
          return { message: "Connected." };
        },
      },
    }).run();

    expect(order).toEqual(["login", "prompt"]);
    expect(renderer.renderCommandInvocation).not.toHaveBeenCalled();
    expect(renderer.finishCommand).not.toHaveBeenCalled();
  });

  it("keeps the result of an explicit login command after onboarding", async () => {
    const handle = vi.fn(async () => ({ message: "Connected." }));
    const renderer = fakeRenderer({
      setupFlow: createFakeSetupFlowRenderer(),
      finishCommand: vi.fn(),
      readInput: inputs(["/login", undefined]),
    });
    await new EveTUIRunner({
      client: stubClient(),
      renderer,
      appRoot: "/tmp/agent",
      onboard: true,
      bootDetections: [],
      promptCommandHandler: { handle },
    }).run();

    expect(handle).toHaveBeenCalledTimes(2);
    expect(renderer.finishCommand).toHaveBeenCalledExactlyOnceWith({
      kind: "result",
      message: "Connected.",
      summary: undefined,
    });
  });

  it("does not auto-open /model outside the prefilled onboarding launch", async () => {
    const handle = vi.fn(async () => ({ message: "/model dismissed." }));
    await new EveTUIRunner({
      client: stubClient(),
      renderer: fakeRenderer({ setupFlow: createFakeSetupFlowRenderer() }),
      appRoot: "/tmp/weather-agent",
      bootDetections: [
        {
          id: "test",
          detect: () => [
            { kind: "attention", label: "model provider not linked", command: "/model" },
          ],
        },
      ],
      detectProjectIdentity: vi.fn(async () => undefined),
      promptCommandHandler: { handle },
    }).run();

    expect(handle).not.toHaveBeenCalled();
  });
});
