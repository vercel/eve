import { createChannelOperations } from "#channel/channel-operations.js";
import { type CompiledChannel, isCompiledChannel } from "#channel/compiled-channel.js";
import { type RouteHandlerArgs, isHttpRouteDefinition } from "#channel/routes.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { createAttachSessionFn, type Session } from "#channel/session.js";
import { attachRouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import { none } from "#public/channels/auth.js";
import { eveChannel } from "#public/channels/eve.js";
import { z } from "#compiled/zod/index.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { askQuestion } from "#tools/provided/ask-question.js";
import { getWorld } from "#internal/workflow/runtime.js";

/** One outbound call a channel made to its platform API. */
export interface PlatformCall {
  readonly body: unknown;
  readonly method: string;
  /** The JSON the fake platform answered with. */
  readonly response: unknown;
}

/** A choice the platform rendered for a person, with whatever the driver needs to press it. */
export interface RenderedOption {
  readonly label: string;
  readonly handle: unknown;
}

/** Reads text-only options rendered as `1. Label` or `1. Label - description` lines. */
export function numberedOptions(text: string): RenderedOption[] {
  return text
    .split("\n")
    .map((line) => /^\s*\d+[.)]\s*(.+?)\s*$/u.exec(line)?.[1])
    .filter((label): label is string => label !== undefined)
    .map((line) => line.split(" - ", 1)[0]!)
    .map((label) => ({ handle: label, label }));
}

/**
 * What a platform can do for a person, independent of eve. A rule that needs a
 * capability a driver lacks is skipped for that channel as "not supported".
 */
export type ChannelCapability =
  /** A person can press a rendered choice. */
  | "buttons"
  /** A person can send a plain-text message to the conversation. */
  | "text-replies";

/**
 * Teaches the HITL conformance suite to speak one channel's platform protocol.
 *
 * Drivers translate only between platform wire formats and conversation
 * actions. They never read session state, so they keep working across changes
 * to how eve stores and routes requests.
 */
export interface ChannelDriver {
  readonly name: string;
  readonly capabilities: readonly ChannelCapability[];
  /**
   * Builds the channel against a fake platform that reports each outbound call
   * to `record`. HTTP platforms use {@link recordingFetch}.
   */
  createChannel(record: (call: PlatformCall) => void): unknown;
  /** Undoes anything `createChannel` installed outside the channel, such as a global `fetch`. */
  dispose?(): void;
  /** A webhook request carrying a person's message. */
  message(text: string): Request;
  /**
   * The options a person can see in one outbound call that posts the question:
   * `undefined` when the call isn't the question, `[]` when it shows no options.
   * Read what the platform displays (buttons, or labels in the text), not eve's
   * request metadata.
   */
  findOptions(call: PlatformCall, prompt: string): readonly RenderedOption[] | undefined;
  /** A webhook request pressing a rendered option. */
  press(option: RenderedOption): Request;
  /** Text the bot posted in one outbound call, if any. */
  postedText(call: PlatformCall): string | undefined;
}

/** What a person can do and see in one channel conversation. Contract rules use only this. */
export interface ChannelConversation {
  /** The person sends a plain-text message. */
  say(text: string): Promise<void>;
  /** Waits for the bot to post `prompt` with choices, returning them. */
  waitForQuestion(prompt: string): Promise<readonly RenderedOption[]>;
  /** The person presses one rendered choice. */
  press(option: RenderedOption): Promise<void>;
  /** Waits until `tool` returns, as visible in the bot's reply, and returns its output. */
  waitForToolResult(tool: string): Promise<unknown>;
  /** Waits until the bot's reply shows `tool` ran or was denied. */
  waitForToolOutcome(tool: string): Promise<ToolOutcome>;
  /** How many times {@link GATED_TOOL} actually executed, as its side effect would show. */
  readonly gatedToolRuns: number;
}

/**
 * Teaches the suite to drive a client UI that talks to eve's own HTTP channel
 * (`eveChannel`) through `eve/client`, such as the dev TUI. Like a webhook
 * driver, it reads only what the client shows a person.
 */
export interface ClientDriver {
  readonly name: string;
  readonly capabilities: readonly ChannelCapability[];
  /**
   * Starts the client against the agent at `host`. The global `fetch` serves
   * that origin from the eve channel's routes until the client closes.
   */
  open(host: string, wait: Wait): Promise<ClientView>;
}

/** A running client, as a person sees and uses it. */
export interface ClientView {
  /** The person sends a plain-text message. */
  say(text: string): Promise<void>;
  /** Waits for the client to show `prompt` with choices, returning them. */
  waitForQuestion(prompt: string): Promise<readonly RenderedOption[]>;
  /** The person presses one shown choice. */
  press(option: RenderedOption): Promise<void>;
  /** The bot replies the client shows now. */
  replies(): readonly string[] | Promise<readonly string[]>;
  /** What the client shows now, for timeout errors. */
  describe(): string;
  /** Stops the client and releases anything it holds, such as its event stream. */
  close(): Promise<void>;
}

/**
 * Polls `select` until it returns a value. On timeout, the error names
 * `label`, the driver, and `describe()`'s account of what a person sees.
 */
export type Wait = <T>(
  label: string,
  select: () => T | undefined | Promise<T | undefined>,
  describe: () => string,
) => Promise<T>;

/**
 * How long to wait for a platform call. Steps finish in well under a second, so
 * this mostly absorbs the first conversation's cold start on a busy machine.
 */
const WAIT_TIMEOUT_MS = 30_000;

/** Stand-in origin for the agent a {@link ClientDriver} talks to. */
const CLIENT_HOST = "https://agent.example.com";

/** The test agent's tool that always needs a person's approval before it runs. */
export const GATED_TOOL = "deploy_release";

/** What a person sees once a tool call settles. */
export type ToolOutcome =
  | { readonly kind: "ran"; readonly output: unknown }
  | { readonly kind: "denied" };

/** A `fetch` for an HTTP platform API: `decode` turns each request into a call and its answer. */
export function recordingFetch(
  record: (call: PlatformCall) => void,
  decode: (request: Request) => Promise<PlatformCall>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const call = await decode(new Request(input, init));
    record(call);
    return Response.json(call.response);
  };
}

/**
 * Runs `body` against an agent with `ask_question`, an approval-gated tool, and
 * `driver`'s channel. Every interaction goes through the channel's real routes.
 * A webhook driver fakes only the platform behind its channel, usually its
 * injected `fetch`; a client driver runs the real client against `eveChannel`.
 *
 * Conversations must not overlap: each compiles its own agent, and concurrent
 * ones can resolve each other's compiled artifacts in the shared workflow world.
 */
export async function withChannelConversation(
  driver: ChannelDriver | ClientDriver,
  body: (conversation: ChannelConversation) => Promise<void>,
  options: { readonly waitTimeoutMs?: number } = {},
): Promise<void> {
  const waitTimeoutMs = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  const wait: Wait = (label, select, describe) =>
    poll(`${label} on ${driver.name}`, select, describe, waitTimeoutMs);
  if (isClientDriver(driver)) {
    await converse(driver.name, "eve", eveChannel({ auth: none() }), body, wait, (dispatch) =>
      openClient(driver, dispatch, wait),
    );
    return;
  }
  const calls: PlatformCall[] = [];
  try {
    const channel = driver.createChannel((call) => void calls.push(call));
    await converse(driver.name, driver.name, channel, body, wait, async (dispatch) =>
      webhookView(driver, calls, dispatch, wait),
    );
  } finally {
    driver.dispose?.();
  }
}

function isClientDriver(driver: ChannelDriver | ClientDriver): driver is ClientDriver {
  return "open" in driver;
}

async function poll<T>(
  label: string,
  select: () => T | undefined | Promise<T | undefined>,
  describe: () => string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const selected = await select();
    if (selected !== undefined) return selected;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}. ${describe()}`);
}

/** Serves one request from the channel's routes; `settled` resolves once its `waitUntil` work does. */
type Dispatch = (request: Request) => Promise<{ response: Response; settled: Promise<unknown> }>;

/** A webhook channel seen through its platform calls: what the bot posted. */
function webhookView(
  driver: ChannelDriver,
  calls: readonly PlatformCall[],
  dispatch: Dispatch,
  wait: Wait,
): ClientView {
  async function post(request: Request): Promise<void> {
    const { response, settled } = await dispatch(request);
    await settled;
    if (!response.ok) throw new Error(`${driver.name} webhook answered ${response.status}.`);
  }
  const describe = () => `Platform calls:\n${JSON.stringify(calls, null, 2)}`;

  return {
    say: (text) => post(driver.message(text)),
    press: (option) => post(driver.press(option)),
    waitForQuestion: (prompt) =>
      wait(
        `the question "${prompt}"`,
        () => {
          for (const call of calls) {
            const options = driver.findOptions(call, prompt);
            if (options !== undefined) return options;
          }
          return undefined;
        },
        describe,
      ),
    replies: () => calls.flatMap((call) => driver.postedText(call) ?? []),
    describe,
    close: async () => {},
  };
}

/** Starts `driver`'s client with the client host's `fetch` routed to the channel until it closes. */
async function openClient(
  driver: ClientDriver,
  dispatch: Dispatch,
  wait: Wait,
): Promise<ClientView> {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== CLIENT_HOST) return await original(input, init);
    return (await dispatch(request)).response;
  };
  const restore = () => void (globalThis.fetch = original);
  try {
    const view = await driver.open(CLIENT_HOST, wait);
    return {
      ...view,
      async close() {
        try {
          await view.close();
        } finally {
          restore();
        }
      },
    };
  } catch (error) {
    restore();
    throw error;
  }
}

async function converse(
  label: string,
  channelName: string,
  created: unknown,
  body: (conversation: ChannelConversation) => Promise<void>,
  wait: Wait,
  open: (dispatch: Dispatch) => Promise<ClientView>,
): Promise<void> {
  if (!isCompiledChannel(created)) throw new Error(`${label} is not a compiled channel.`);
  const channel: CompiledChannel = created;
  let gatedToolRuns = 0;

  const runtime = await createTestRuntime({
    agent: { name: `${label}-hitl-conformance` },
    modules: [
      {
        logicalPath: "tools/ask_question.ts",
        loadNamespace: async () => ({ default: askQuestion() }),
      },
      {
        logicalPath: `tools/${GATED_TOOL}.ts`,
        loadNamespace: async () => ({
          default: defineTool({
            approval: always(),
            description: `Deploys a release. Only call when asked to use ${GATED_TOOL}.`,
            async execute() {
              gatedToolRuns += 1;
              return { deployed: true };
            },
            inputSchema: z.object({ release: z.string().optional() }),
          }),
        }),
      },
      {
        logicalPath: `channels/${channelName}.ts`,
        loadNamespace: async () => ({ default: channel }),
      },
    ],
  });

  await runtime.run(async () => {
    const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
    const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
    const entry = bundle.graph.root.channels.find((candidate) => candidate.name === channelName);
    if (entry?.adapter === undefined) throw new Error(`Expected the ${channelName} adapter.`);
    const { adapter, turnPolicy } = entry;
    const workflowRuntime = createWorkflowRuntime({ compiledArtifactsSource });
    // Mirrors the route arguments production channel dispatch builds for each request.
    const operations = createChannelOperations({
      adapter,
      channelName,
      runtime: workflowRuntime,
      turnPolicy,
    });
    const attachSession = createAttachSessionFn(workflowRuntime, {
      channelKind: adapter.kind,
      channelName,
      turnPolicy,
    });
    const sessions = new Map<string, Session>();
    const background: Promise<unknown>[] = [];

    function track(session: Session): Session {
      sessions.set(session.id, session);
      return session;
    }

    const dispatch: Dispatch = async (request) => {
      const { params, route } = findRoute(channel, request);
      const pending: Promise<unknown>[] = [];
      const args = attachRouteSessionCreator<RouteHandlerArgs>(
        {
          ...operations,
          from: (address) => {
            const source = operations.from(address);
            return {
              ...source,
              send: async (...sendArgs) => track(await source.send(...sendArgs)),
              respond: async (...respondArgs) => {
                await waitForAddress(address);
                return track(await source.respond(...respondArgs));
              },
            };
          },
          attachSession,
          params,
          requestIp: null,
          to: unsupported("to"),
          waitUntil: (task) => void pending.push(task),
        },
        async (input) => {
          const handle = await workflowRuntime.createSession({
            ...input,
            adapter,
            channelName,
            continuationToken:
              input.continuationToken === undefined
                ? undefined
                : `${channelName}:${input.continuationToken}`,
          });
          track(attachSession(handle.sessionId));
          return handle;
        },
      );
      const response = await route.handler(request, args);
      const settled = Promise.all(pending);
      background.push(settled);
      return { response, settled };
    };

    /** How many times each session's turn has held for input, as of the last wait. */
    const inputHolds = new Map<string, number>();
    const view = await open(dispatch);
    const replyWait = <T>(label: string, select: (reply: string) => T | undefined) =>
      wait(
        label,
        async () => {
          for (const reply of await view.replies()) {
            const selected = select(reply);
            if (selected !== undefined) return selected;
          }
          return undefined;
        },
        view.describe,
      );

    const conversation: ChannelConversation = {
      say: (text) => view.say(text),
      press: (option) => view.press(option),
      async waitForQuestion(prompt) {
        const options = await view.waitForQuestion(prompt);
        await holdForInput();
        return options;
      },
      waitForToolResult: (tool) =>
        replyWait(`${tool} to return`, (reply) => readMockToolReply(reply, tool)),
      waitForToolOutcome: (tool) =>
        replyWait(`${tool} to run or be denied`, (reply): ToolOutcome | undefined => {
          const output = readMockToolReply(reply, tool);
          if (output !== undefined) return { kind: "ran", output };
          return isMockDenialReply(reply) ? { kind: "denied" } : undefined;
        }),
      get gatedToolRuns() {
        return gatedToolRuns;
      },
    };

    /**
     * The turn emits `turn.waiting` inside the step that raised the request, but
     * an address the channel aliased in that step (such as Discord's message id)
     * is only claimed once the step commits. Answering through it before then
     * finds no session.
     */
    async function waitForAddress(address: string): Promise<void> {
      const world = await getWorld();
      const token = sessionInboxHookToken(`${channelName}:${address}`);
      await wait(
        `the channel to claim the address "${address}"`,
        () =>
          world.hooks.getByToken(token).then(
            () => true,
            () => undefined,
          ),
        () => "",
      );
    }

    /**
     * A person answers once the bot has finished asking. Answering the moment
     * the question appears races the turn's own bookkeeping for it; see also
     * {@link waitForAddress}.
     */
    function holdForInput(): Promise<true> {
      return wait(
        "the turn to hold for input",
        async () => {
          for (const session of sessions.values()) {
            const holds = await countInputHolds(session);
            if (holds > (inputHolds.get(session.id) ?? 0)) {
              inputHolds.set(session.id, holds);
              return true;
            }
          }
          return undefined;
        },
        () => "",
      );
    }

    // The test file's workflow world closes after its last test, so a session
    // still writing then fails with an unhandled rejection.
    const settle = async () => {
      await Promise.all([...sessions.values()].map(cancelUntilResting));
      await Promise.all(background);
    };
    try {
      await body(conversation);
    } catch (error) {
      await view.close().catch(() => {});
      await settle().catch(() => {});
      throw error;
    }
    await view.close();
    await settle();
  });
}

const TERMINAL_STEP_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Cancels `session` until it waits for its next message with none of its steps
 * still running. A turn that starts after the first cancel needs another.
 */
async function cancelUntilResting(session: Session): Promise<void> {
  const world = await getWorld();
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await session.cancel();
    const tail = await session.getStreamTailIndex();
    const reader = (await session.getEventStream({ startIndex: tail })).getReader();
    const last = await reader.read().finally(() => reader.cancel());
    if (last.value?.type === "session.waiting") {
      const steps = await world.steps.list({ resolveData: "none", runId: session.id });
      if (steps.data.every((step) => TERMINAL_STEP_STATUSES.has(step.status))) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for session ${session.id} to rest.`);
}

async function countInputHolds(session: Session): Promise<number> {
  const tail = await session.getStreamTailIndex();
  if (tail < 0) return 0;
  const reader = (await session.getEventStream({ startIndex: 0 })).getReader();
  let holds = 0;
  try {
    for (let index = 0; index <= tail; index += 1) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === "turn.waiting" && value.data.on === "input") holds += 1;
    }
  } finally {
    await reader.cancel();
  }
  return holds;
}

function findRoute(channel: CompiledChannel, request: Request) {
  const { pathname } = new URL(request.url);
  for (const route of channel.routes) {
    if (!isHttpRouteDefinition(route) || route.method !== request.method) continue;
    const params = matchPath(route.path, pathname);
    if (params !== undefined) return { params, route };
  }
  throw new Error(`No ${request.method} route for ${pathname}.`);
}

/** Matches a route path whose `:name` segments each capture one path segment. */
function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const expected = pattern.split("/");
  const actual = pathname.split("/");
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const value = actual[index]!;
    if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(value);
    else if (segment !== value) return undefined;
  }
  return params;
}

function unsupported(name: string): () => never {
  return () => {
    throw new Error(`The HITL conformance harness does not provide ctx.${name}.`);
  };
}

/**
 * After a tool returns, the deterministic test model replies
 * `Used <tool> for "<message>": <JSON output>`. Reading the output back from
 * the posted reply keeps rules on what a person sees.
 */
export function readMockToolReply(text: string, tool: string): unknown {
  if (!text.startsWith(`Used ${tool} for "`)) return undefined;
  const output = /": (\{.*\})\s*$/su.exec(text)?.[1];
  if (output === undefined) return undefined;
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return undefined;
  }
}

/** The test model reports a denied call's `execution-denied` result in its reply. */
function isMockDenialReply(text: string): boolean {
  return text.includes('"type":"execution-denied"');
}
