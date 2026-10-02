import { createChannelOperations } from "#channel/channel-operations.js";
import { type CompiledChannel, isCompiledChannel } from "#channel/compiled-channel.js";
import { type RouteHandlerArgs, isHttpRouteDefinition } from "#channel/routes.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { Session } from "#channel/session.js";
import { z } from "#compiled/zod/index.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { askQuestion } from "#tools/provided/ask-question.js";

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

/** One platform message as a person sees it after an outbound call posts or edits it. */
export interface ShownMessage {
  /** The platform's id for the message, stable across edits. */
  readonly id: string;
  /** Every piece of text the message shows, joined. */
  readonly text: string;
  /** The choices the message still lets a person press. */
  readonly options: readonly RenderedOption[];
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
  /**
   * The message one outbound call posts or edits, as a person sees it
   * afterward. Required with the `buttons` capability, since rules check how
   * an answered prompt's message changes.
   */
  shownMessage?(call: PlatformCall): ShownMessage | undefined;
  /** How the person driving the conversation appears in the platform's text, in any form. */
  readonly personShownAs?: readonly string[];
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
  /**
   * The message that asked `prompt` as it stands now, after every edit so far.
   * Rules read it once an answer has settled, by which point the bot has had
   * every chance to update it.
   */
  shownPrompt(prompt: string): ShownMessage;
  /** How the person appears in the platform's text, in any form. */
  readonly personShownAs: readonly string[];
  /** How many times {@link GATED_TOOL} actually executed, as its side effect would show. */
  readonly gatedToolRuns: number;
}

/**
 * How long to wait for a platform call. Steps finish in well under a second, so
 * this mostly absorbs the first conversation's cold start on a busy machine.
 */
const WAIT_TIMEOUT_MS = 30_000;

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
 * Runs `body` against an agent with `ask_question` and `driver`'s channel. Every
 * interaction goes through the channel's real webhook routes; the only fake is
 * the platform behind the channel, usually its injected `fetch`.
 *
 * Conversations must not overlap: each compiles its own agent, and concurrent
 * ones can resolve each other's compiled artifacts in the shared workflow world.
 */
export async function withChannelConversation(
  driver: ChannelDriver,
  body: (conversation: ChannelConversation) => Promise<void>,
  options: { readonly waitTimeoutMs?: number } = {},
): Promise<void> {
  const calls: PlatformCall[] = [];
  try {
    await converse(driver, calls, body, options.waitTimeoutMs ?? WAIT_TIMEOUT_MS);
  } finally {
    driver.dispose?.();
  }
}

async function converse(
  driver: ChannelDriver,
  calls: PlatformCall[],
  body: (conversation: ChannelConversation) => Promise<void>,
  waitTimeoutMs: number,
): Promise<void> {
  const created = driver.createChannel((call) => void calls.push(call));
  if (!isCompiledChannel(created)) throw new Error(`${driver.name} is not a compiled channel.`);
  const channel: CompiledChannel = created;
  let gatedToolRuns = 0;

  const runtime = await createTestRuntime({
    agent: { name: `${driver.name}-hitl-conformance` },
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
        logicalPath: `channels/${driver.name}.ts`,
        loadNamespace: async () => ({ default: channel }),
      },
    ],
  });

  await runtime.run(async () => {
    const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
    const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
    const entry = bundle.graph.root.channels.find((candidate) => candidate.name === driver.name);
    if (entry?.adapter === undefined) throw new Error(`Expected the ${driver.name} adapter.`);
    // Mirrors the operations production route dispatch builds for each request.
    const operations = createChannelOperations({
      adapter: entry.adapter,
      channelName: driver.name,
      runtime: createWorkflowRuntime({ compiledArtifactsSource }),
      turnPolicy: entry.turnPolicy,
    });
    const sessions = new Map<string, Session>();

    async function post(request: Request): Promise<void> {
      const pending: Promise<unknown>[] = [];
      const args: RouteHandlerArgs = {
        ...operations,
        from: (address) => {
          const source = operations.from(address);
          return {
            ...source,
            send: async (...sendArgs) => track(await source.send(...sendArgs)),
            respond: async (...respondArgs) => track(await source.respond(...respondArgs)),
          };
        },
        attachSession: unsupported("attachSession"),
        params: {},
        requestIp: null,
        to: unsupported("to"),
        waitUntil: (task) => void pending.push(task),
      };
      const response = await findRoute(channel, request).handler(request, args);
      await Promise.all(pending);
      if (!response.ok) throw new Error(`${driver.name} webhook answered ${response.status}.`);
    }

    async function waitFor<T>(label: string, select: (call: PlatformCall) => T | undefined) {
      const deadline = Date.now() + waitTimeoutMs;
      while (Date.now() < deadline) {
        for (const call of calls) {
          const selected = select(call);
          if (selected !== undefined) return selected;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        `Timed out waiting for ${label} on ${driver.name}. Platform calls:\n${JSON.stringify(calls, null, 2)}`,
      );
    }

    const conversation: ChannelConversation = {
      say: (text) => post(driver.message(text)),
      press: (option) => post(driver.press(option)),
      async waitForQuestion(prompt) {
        const options = await waitFor(`the question "${prompt}"`, (call) =>
          driver.findOptions(call, prompt),
        );
        await waitForTurnToHoldForInput();
        return options;
      },
      waitForToolResult: (tool) =>
        waitFor(`${tool} to return`, (call) => {
          const text = driver.postedText(call);
          return text === undefined ? undefined : readMockToolReply(text, tool);
        }),
      waitForToolOutcome: (tool) =>
        waitFor(`${tool} to run or be denied`, (call): ToolOutcome | undefined => {
          const text = driver.postedText(call);
          if (text === undefined) return undefined;
          const output = readMockToolReply(text, tool);
          if (output !== undefined) return { kind: "ran", output };
          return isMockDenialReply(text) ? { kind: "denied" } : undefined;
        }),
      shownPrompt(prompt) {
        const read = driver.shownMessage?.bind(driver);
        if (read === undefined) throw new Error(`${driver.name} cannot read shown messages.`);
        const asked = calls.find((call) => (driver.findOptions(call, prompt)?.length ?? 0) > 0);
        const id = asked === undefined ? undefined : read(asked)?.id;
        if (id === undefined) throw new Error(`The question "${prompt}" was never asked.`);
        return calls
          .flatMap((call) => {
            const shown = read(call);
            return shown?.id === id ? [shown] : [];
          })
          .at(-1)!;
      },
      personShownAs: driver.personShownAs ?? [],
      get gatedToolRuns() {
        return gatedToolRuns;
      },
    };

    /** How many times each session's turn has held for input, as of the last wait. */
    const inputHolds = new Map<string, number>();

    /**
     * A person answers once the bot has finished asking. Answering the moment
     * the question appears races the channel's own bookkeeping for it, such as
     * Discord aliasing the session to the message it just posted.
     */
    async function waitForTurnToHoldForInput(): Promise<void> {
      const deadline = Date.now() + waitTimeoutMs;
      while (Date.now() < deadline) {
        for (const session of sessions.values()) {
          const holds = await countInputHolds(session);
          if (holds > (inputHolds.get(session.id) ?? 0)) {
            inputHolds.set(session.id, holds);
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out waiting for the turn to hold for input on ${driver.name}.`);
    }

    function track(session: Session): Session {
      sessions.set(session.id, session);
      return session;
    }

    try {
      await body(conversation);
    } finally {
      await Promise.allSettled([...sessions.values()].map((session) => session.cancel()));
    }
  });
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
  const route = channel.routes.find(
    (candidate) =>
      isHttpRouteDefinition(candidate) &&
      candidate.method === request.method &&
      candidate.path === pathname,
  );
  if (route === undefined || !isHttpRouteDefinition(route)) {
    throw new Error(`No ${request.method} route for ${pathname}.`);
  }
  return route;
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
function readMockToolReply(text: string, tool: string): unknown {
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
