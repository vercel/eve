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
import type { SessionAuthContext } from "#channel/types.js";
import { eveChannel } from "#public/channels/eve.js";
import { z } from "#compiled/zod/index.js";
import type { ApprovalResponsePolicy } from "#approval/definition.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { askQuestion } from "#tools/provided/ask-question.js";
import { defineWorkflowTool } from "#public/tools/index.js";
import { askDayAndTimeWorkflow } from "#internal/testing/channel-conformance/two-questions-workflow.js";
import { getWorld } from "#internal/workflow/runtime.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import {
  type ConnectionAuthorizationChallenge,
  ConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import { handleConnectionCallbackRequest } from "#execution/connections/callback-route.js";
import type { RouteContext } from "#public/definitions/channel.js";
import type { AgentLimitsDefinition } from "#shared/agent-definition.js";
import { defineInteractiveAuthorization } from "#shared/connection-types.js";

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

/** One platform message as a person sees it after an outbound call posts or edits it. */
export interface ShownMessage {
  /** The platform's id for the message, stable across edits. */
  readonly id: string;
  /** Every piece of text the message shows, joined. */
  readonly text: string;
  /** The choices the message still lets a person press. */
  readonly options: readonly RenderedOption[];
  /** Where the message's link buttons lead, such as a sign-in URL. */
  readonly links?: readonly string[];
  /**
   * Only the person sees it, though others can see the conversation, such as
   * Slack's ephemeral messages.
   */
  readonly onlyPerson?: boolean;
}

/** What a client shows a person, and whether anyone else in the conversation sees it too. */
export interface ShownText {
  readonly text: string;
  readonly onlyPerson: boolean;
  /** The choices it lets a person press. */
  readonly options: readonly RenderedOption[];
}

/** Every `url` string anywhere in a message payload: the targets of its link buttons. */
export function linkTargets(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(linkTargets);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "url" && typeof child === "string" ? [child] : linkTargets(child),
  );
}

/**
 * What a platform can do for a person, independent of eve. A rule that needs a
 * capability a driver lacks is skipped for that channel as "not supported".
 */
export type ChannelCapability =
  /** Someone besides the person who started the conversation can act in it. */
  | "another-person"
  /** A person can press a rendered choice. */
  | "buttons"
  /** A person can send a plain-text message to the conversation. */
  | "text-replies";

/**
 * Who can see the conversation a driver holds. Anything meant for the person
 * alone must reach them privately on a shared surface and can't be shown at
 * all on a public one.
 */
export type Surface =
  /** Anyone, such as a GitHub issue. */
  | "public"
  /** Members of a channel, group, or workspace, such as a Slack channel thread. Most agents run here. */
  | "shared"
  /** Only the person, such as a direct message or a local terminal. */
  | "private";

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
  readonly surface: Surface;
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
  /**
   * A webhook request in which `person` presses a rendered option. Drivers
   * with the `another-person` capability must press as `"bob"` when asked.
   */
  press(option: RenderedOption, person: Person): Request;
  /** Text the bot posted in one outbound call, if any. */
  postedText(call: PlatformCall): string | undefined;
  /**
   * The message one outbound call posts or edits, as a person sees it
   * afterward. Required with the `buttons` capability, since rules check how
   * an answered prompt's message changes. Without it, what a person sees is
   * {@link postedText}.
   */
  shownMessage?(call: PlatformCall): ShownMessage | undefined;
  /** How the person driving the conversation appears in the platform's text, in any form. */
  readonly personShownAs?: readonly string[];
}

/**
 * Who acts in a conversation: Alice starts it and asks for every request; Bob
 * is someone else in it, and needs the `another-person` capability.
 */
export type Person = "alice" | "bob";

/** What a person can do and see in one channel conversation. Contract rules use only this. */
export interface ChannelConversation {
  /** The person sends a plain-text message. */
  say(text: string): Promise<void>;
  /** Waits for the bot to post `prompt` with choices, returning them. */
  waitForQuestion(prompt: string): Promise<readonly RenderedOption[]>;
  /**
   * Answers each of `prompts` with the option `choose` picks, in whatever order
   * the client shows them.
   */
  answerEach(
    prompts: readonly string[],
    choose: (prompt: string, options: readonly RenderedOption[]) => RenderedOption,
  ): Promise<void>;
  /**
   * Waits until the turn holds for `prompt`, whether or not the client shows it
   * yet. A client may show several pending requests one at a time.
   */
  waitForRequest(prompt: string): Promise<void>;
  /** `person`, Alice unless given, presses one rendered choice. */
  press(option: RenderedOption, person?: Person): Promise<void>;
  /** Waits until `tool` returns, as visible in the bot's reply, and returns its output. */
  waitForToolResult(tool: string): Promise<unknown>;
  /** Waits until the bot replies to input that carried `text`, however the channel framed it. */
  waitForReplyTo(text: string): Promise<void>;
  /** How many test-model replies, plain or reporting a tool result, the bot has shown. */
  replyCount(): Promise<number>;
  /** Waits for the bot to show a test-model reply, plain or reporting a tool result. */
  waitForReply(): Promise<void>;
  /** Waits for the bot to show text matching `pattern`, returning the text that matched. */
  waitForShown(pattern: string | RegExp): Promise<string>;
  /** Everything the bot has shown that everyone in the conversation sees, joined. */
  sharedText(): Promise<string>;
  /** Every choice the bot's messages let a person press now, newest message first. */
  shownOptions(): Promise<readonly RenderedOption[]>;
  /** Waits for the turn to hold for a sign-in, however the channel shows it. */
  waitForSignIn(): Promise<void>;
  /**
   * Finishes the oldest unfinished sign-in as the provider would: by
   * redirecting the person's browser to eve's callback URL with a code.
   */
  completeSignIn(): Promise<void>;
  /** Waits until the bot's reply shows `tool` ran or was denied. */
  waitForToolOutcome(tool: string): Promise<ToolOutcome>;
  /** Waits until every session has stopped working and waits only on a person. */
  waitForRest(): Promise<void>;
  /** How many times a gated tool actually executed, as its side effect would show. */
  runsOf(tool: GatedTool): number;
  /**
   * The message that asked `prompt` as it stands now, after every edit so far.
   * Rules read it once an answer has settled, by which point the bot has had
   * every chance to update it.
   */
  shownPrompt(prompt: string): Promise<ShownMessage>;
  /** How the person appears in the platform's text, in any form. */
  readonly personShownAs: readonly string[];
  runsOf(tool: CountedTool): number;
}

/**
 * Teaches the suite to drive a client UI that talks to eve's own HTTP channel
 * (`eveChannel`) through `eve/client`, such as the dev TUI. Like a webhook
 * driver, it reads only what the client shows a person.
 */
export interface ClientDriver {
  readonly name: string;
  readonly capabilities: readonly ChannelCapability[];
  readonly surface: Surface;
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
  /**
   * Waits for the client to show one of `prompts`, returning which one and its
   * choices. A client may show several pending requests one at a time.
   */
  waitForQuestion(prompts: readonly string[]): Promise<ShownQuestion>;
  /** `person` presses one shown choice. */
  press(option: RenderedOption, person: Person): Promise<void>;
  /** The bot replies the client shows now. */
  replies(): readonly string[] | Promise<readonly string[]>;
  /** The message that asked `prompt` as it stands now; see {@link ChannelConversation.shownPrompt}. */
  shownPrompt?(prompt: string): ShownMessage | Promise<ShownMessage>;
  /** How the person appears in the client's text, in any form. */
  readonly personShownAs?: readonly string[];
  /** Everything the client shows now that a person can read or open, one entry per message. */
  shown(): readonly ShownText[] | Promise<readonly ShownText[]>;
  /** What the client shows now, for timeout errors. */
  describe(): string;
  /** Stops the client and releases anything it holds, such as its event stream. */
  close(): Promise<void>;
}

/** A question a client shows, with the choices it offers. */
export interface ShownQuestion {
  readonly options: readonly RenderedOption[];
  readonly prompt: string;
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

/** A second always-gated tool, so two approvals can be pending at once. */
export const SECOND_GATED_TOOL = "publish_notes";

/**
 * An always-gated tool whose response policy lets only the person who asked
 * for the call approve or cancel it.
 */
export const REQUESTER_GATED_TOOL = "release_hotfix";

export type GatedTool = typeof GATED_TOOL | typeof SECOND_GATED_TOOL | typeof REQUESTER_GATED_TOOL;

/** The test agent's plain tool: it runs without asking anyone. */
export const PLAIN_TOOL = "look_up_notes";

/** The test agent's tools that need the person to sign in to a provider before they run. */
export const SIGN_IN_TOOLS = {
  /** A browser sign-in that also shows a confirmation code. */
  read_calendar: {
    displayName: "Calendar",
    instructions: "Sign in to let the agent read your calendar.",
    url: "https://idp.example/authorize?client_id=eve-conformance",
    userCode: "WDJB-MJHT",
  },
  /** A sign-in confirmed out of band, with nothing to open. */
  read_mail: {
    displayName: "Mail",
    instructions: "Approve the sign-in request in the Mail app on your phone.",
  },
} as const satisfies Record<string, ConnectionAuthorizationChallenge>;

export type SignInTool = keyof typeof SIGN_IN_TOOLS;

/** A tool whose runs a rule can count. */
export type CountedTool = GatedTool | SignInTool | typeof PLAIN_TOOL;

/** The code the fake provider hands back when a person finishes signing in. */
const SIGN_IN_CODE = "conformance-code";

/**
 * The person a client driver's eve channel authenticates. Sign-ins are
 * user-scoped, so the channel must map its caller to a user principal.
 */
const CLIENT_PERSON = {
  attributes: {},
  authenticator: "conformance",
  principalId: "alice",
  principalType: "user",
} as const;

export interface ConversationOptions {
  /** The test agent's session usage limits. */
  readonly limits?: AgentLimitsDefinition;
  readonly waitTimeoutMs?: number;
}

/** The test agent's tool that asks {@link DAY_PROMPT} and {@link TIME_PROMPT} at once. */
export const TWO_QUESTIONS_TOOL = "plan_review";

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
  options: ConversationOptions = {},
): Promise<void> {
  const waitTimeoutMs = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  const wait: Wait = (label, select, describe) =>
    poll(`${label} on ${driver.name}`, select, describe, waitTimeoutMs);
  if (isClientDriver(driver)) {
    const channel = eveChannel({ auth: () => CLIENT_PERSON });
    await converse(driver.name, "eve", channel, body, options, wait, (dispatch) =>
      openClient(driver, dispatch, wait),
    );
    return;
  }
  const calls: PlatformCall[] = [];
  try {
    const channel = driver.createChannel((call) => void calls.push(call));
    await converse(driver.name, driver.name, channel, body, options, wait, async (dispatch) =>
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
  /** Where each prompt may next appear: after the call it was last found in. */
  const promptsFrom = new Map<string, number>();

  return {
    say: (text) => post(driver.message(text)),
    press: (option, person) => post(driver.press(option, person)),
    waitForQuestion: (prompts) =>
      wait(
        `one of the questions ${JSON.stringify(prompts)}`,
        () => {
          for (const [index, call] of calls.entries()) {
            for (const prompt of prompts) {
              if (index < (promptsFrom.get(prompt) ?? 0)) continue;
              const options = driver.findOptions(call, prompt);
              if (options === undefined) continue;
              // After a prompt is asked, an optionless match is an edit of the answered message.
              if (promptsFrom.has(prompt) && options.length === 0) continue;
              promptsFrom.set(prompt, index + 1);
              return { options, prompt };
            }
          }
          return undefined;
        },
        describe,
      ),
    replies: () => calls.flatMap((call) => driver.postedText(call) ?? []),
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
    shown: () =>
      calls.flatMap((call) => {
        const shown = driver.shownMessage?.(call);
        if (shown !== undefined) {
          const text = [shown.text, ...(shown.links ?? [])].join("\n");
          return [{ onlyPerson: shown.onlyPerson === true, options: shown.options, text }];
        }
        const text = driver.postedText(call);
        return text === undefined ? [] : [{ onlyPerson: false, options: [], text }];
      }),
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
  options: ConversationOptions,
  wait: Wait,
  open: (dispatch: Dispatch) => Promise<ClientView>,
): Promise<void> {
  if (!isCompiledChannel(created)) throw new Error(`${label} is not a compiled channel.`);
  const channel: CompiledChannel = created;
  const runs: Record<CountedTool, number> = {
    [GATED_TOOL]: 0,
    [REQUESTER_GATED_TOOL]: 0,
    [SECOND_GATED_TOOL]: 0,
    [PLAIN_TOOL]: 0,
    read_calendar: 0,
    read_mail: 0,
  };
  /** eve's callback URL for each sign-in started, as the provider received it. */
  const signInCallbacks: string[] = [];

  function signInTool(name: SignInTool) {
    let token: string | undefined;
    const auth = defineInteractiveAuthorization({
      async getToken() {
        if (token === undefined) throw new ConnectionAuthorizationRequiredError(name);
        return { token };
      },
      async startAuthorization({ callbackUrl }) {
        signInCallbacks.push(callbackUrl);
        return { challenge: SIGN_IN_TOOLS[name] };
      },
      async completeAuthorization({ callback }) {
        if (callback.params.code !== SIGN_IN_CODE) throw new Error("Unexpected sign-in code.");
        token = `${name}-token`;
        return { token };
      },
    });
    return {
      logicalPath: `tools/${name}.ts`,
      loadNamespace: async () => ({
        default: defineTool({
          description: `Reads the person's ${SIGN_IN_TOOLS[name].displayName}. Only call when asked to use ${name}.`,
          async execute(_input, ctx) {
            await ctx.getToken(auth, { authKey: name });
            runs[name] += 1;
            return { signedIn: true };
          },
          inputSchema: z.object({}),
        }),
      }),
    };
  }

  const runtime = await createTestRuntime({
    agent: { limits: options.limits, name: `${label}-hitl-conformance` },
    modules: [
      {
        logicalPath: `tools/${PLAIN_TOOL}.ts`,
        loadNamespace: async () => ({
          default: defineTool({
            description: `Looks up meeting notes. Only call when asked to use ${PLAIN_TOOL}.`,
            execute: async () => {
              runs[PLAIN_TOOL] += 1;
              return { notes: "Bob's review notes" };
            },
            inputSchema: z.object({}),
          }),
        }),
      },
      signInTool("read_calendar"),
      signInTool("read_mail"),
      {
        logicalPath: "tools/ask_question.ts",
        loadNamespace: async () => ({ default: askQuestion() }),
      },
      gatedTool(GATED_TOOL, "Deploys a release.", () => {
        runs[GATED_TOOL] += 1;
        return { deployed: true };
      }),
      gatedTool(SECOND_GATED_TOOL, "Publishes release notes.", () => {
        runs[SECOND_GATED_TOOL] += 1;
        return { published: true };
      }),
      gatedTool(
        REQUESTER_GATED_TOOL,
        "Releases a hotfix.",
        () => {
          runs[REQUESTER_GATED_TOOL] += 1;
          return { released: true };
        },
        // The requester-only policy from docs/tools/human-in-the-loop.md.
        ({ request, response }) =>
          request.principal !== null && samePrincipal(response.principal, request.principal)
            ? { status: "allowed" }
            : { reason: "Only the person who asked can respond.", status: "rejected" },
      ),
      {
        logicalPath: `tools/${TWO_QUESTIONS_TOOL}.ts`,
        loadNamespace: async () => ({
          default: defineWorkflowTool({
            description: `Plans a review. Only call when asked to use ${TWO_QUESTIONS_TOOL}.`,
            execute: askDayAndTimeWorkflow,
            inputSchema: z.object({}),
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
          describe: unsupported("describe"),
          invokeTool: unsupported("invokeTool"),
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
    const replyCount = async () =>
      (await view.replies()).filter(
        (reply) => isMockReplyTo(reply, "") || reply.startsWith("Used "),
      ).length;
    let signInsCompleted = 0;

    const conversation: ChannelConversation = {
      async say(text) {
        await waitForStepsToFinish([...sessions.values()], wait);
        await view.say(text);
      },
      press: (option, person = "alice") => view.press(option, person),
      async waitForQuestion(prompt) {
        const { options } = await view.waitForQuestion([prompt]);
        await holdForInput(prompt);
        return options;
      },
      async answerEach(prompts, choose) {
        const remaining = [...prompts];
        while (remaining.length > 0) {
          const { options, prompt } = await view.waitForQuestion(remaining);
          await holdForInput(prompt);
          await view.press(choose(prompt, options), "alice");
          remaining.splice(remaining.indexOf(prompt), 1);
        }
      },
      waitForRequest: (prompt) => holdForInput(prompt),
      waitForToolResult: (tool) =>
        replyWait(`${tool} to return`, (reply) => readMockToolReply(reply, tool)),
      waitForReplyTo: (message) =>
        replyWait(`a reply to "${message}"`, (reply) =>
          isMockReplyTo(reply, message) ? true : undefined,
        ).then(() => {}),
      waitForToolOutcome: (tool) =>
        replyWait(`${tool} to run or be denied`, (reply): ToolOutcome | undefined => {
          const output = readMockToolReply(reply, tool);
          if (output !== undefined) return { kind: "ran", output };
          return isMockDenialReply(reply) ? { kind: "denied" } : undefined;
        }),
      replyCount,
      waitForReply: async () =>
        void (await wait(
          "a reply",
          async () => ((await replyCount()) > 0 ? true : undefined),
          view.describe,
        )),
      waitForShown: (pattern) =>
        wait(
          `the bot to show ${String(pattern)}`,
          async () =>
            (await view.shown())
              .map(({ text }) => text)
              .find((text) =>
                typeof pattern === "string" ? text.includes(pattern) : pattern.test(text),
              ),
          view.describe,
        ),
      shownOptions: async () => (await view.shown()).toReversed().flatMap(({ options }) => options),
      sharedText: async () =>
        (await view.shown())
          .filter((shown) => !shown.onlyPerson)
          .map(({ text }) => text)
          .join("\n"),
      waitForSignIn: async () =>
        void (await wait(
          "the turn to hold for a sign-in",
          async () => {
            for (const session of sessions.values()) {
              if (await holdsFor(session, isSignIn)) return true;
            }
            return undefined;
          },
          () => "",
        )),
      async completeSignIn() {
        const callbackUrl = await wait(
          "a sign-in callback URL",
          () => signInCallbacks.at(signInsCompleted),
          () => "",
        );
        signInsCompleted += 1;
        await deliverSignInCallback(callbackUrl);
      },
      runsOf: (tool) => runs[tool],
      waitForRest: () => waitForRest([...sessions.values()], wait),
      async shownPrompt(prompt) {
        if (view.shownPrompt === undefined) throw new Error(`${label} cannot read shown messages.`);
        return await view.shownPrompt(prompt);
      },
      personShownAs: view.personShownAs ?? [],
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
    async function holdForInput(prompt: string): Promise<void> {
      await wait(
        `the turn to hold for "${prompt}"`,
        async () => {
          for (const session of sessions.values()) {
            if (await holdsFor(session, asks(prompt))) return true;
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
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let last: string | undefined;
  let running: string[] = [];
  while (Date.now() < deadline) {
    await session.cancel();
    const tail = await session.getStreamTailIndex();
    const reader = (await session.getEventStream({ startIndex: tail })).getReader();
    last = (await reader.read().finally(() => reader.cancel())).value?.type;
    running = await runningSteps(session);
    if (last === "session.waiting" && running.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for session ${session.id} to rest. Its stream ends with ${last ?? "nothing"}` +
      (running.length === 0 ? "." : `, and these steps are still running: ${running.join(", ")}.`),
  );
}

/** The names of `session`'s steps that haven't finished. */
async function runningSteps(session: Session): Promise<string[]> {
  const world = await getWorld();
  const steps = await world.steps.list({ resolveData: "none", runId: session.id });
  return steps.data
    .filter((step) => !TERMINAL_STEP_STATUSES.has(step.status))
    .map((step) => `${step.stepName} (${step.status})`);
}

/**
 * Waits until no session has a step running. A person writes once the bot has
 * finished, and a channel claims the address of a message it posted, such as
 * the Telegram message a person replies to, only once the step that posted it
 * commits. Writing sooner starts a second session instead of continuing this one.
 */
async function waitForStepsToFinish(sessions: readonly Session[], wait: Wait): Promise<void> {
  await wait(
    "every session's steps to finish",
    async () => {
      const running = await Promise.all(sessions.map(runningSteps));
      return running.every((steps) => steps.length === 0) ? true : undefined;
    },
    () => "",
  );
}

/** How long a session's stream must stay unchanged to count as resting. */
const REST_QUIET_MS = 250;

/**
 * Waits until each session's stream ends waiting on its next message or on a
 * person, with no step running, and stays that way. A response just delivered
 * may not have reached the stream yet, so one quiet read is not enough.
 */
async function waitForRest(sessions: readonly Session[], wait: Wait): Promise<void> {
  const world = await getWorld();
  let quietSince: number | undefined;
  let lastTails = "";
  await wait(
    "every session to rest",
    async () => {
      const states = await Promise.all(
        sessions.map(async (session) => {
          const tail = await session.getStreamTailIndex();
          const reader = (await session.getEventStream({ startIndex: tail })).getReader();
          const last = await reader.read().finally(() => reader.cancel());
          const waiting =
            last.value?.type === "session.waiting" ||
            (last.value?.type === "turn.waiting" && last.value.data.on === "input");
          const steps = await world.steps.list({ resolveData: "none", runId: session.id });
          const idle = steps.data.every((step) => TERMINAL_STEP_STATUSES.has(step.status));
          return { resting: waiting && idle, tail };
        }),
      );
      const tails = states.map((state) => state.tail).join(",");
      const quiet = states.every((state) => state.resting) && tails === lastTails;
      lastTails = tails;
      if (!quiet) {
        quietSince = undefined;
        return undefined;
      }
      quietSince ??= Date.now();
      return Date.now() - quietSince >= REST_QUIET_MS ? true : undefined;
    },
    () => "",
  );
}

/** Whether an event asks the person `prompt`. */
const asks = (prompt: string) => (event: MessageStreamEvent) =>
  event.type === "input.requested" &&
  event.data.requests.some((request) => request.prompt === prompt);

/** Whether an event asks the person to sign in. */
const isSignIn = (event: MessageStreamEvent) => event.type === "authorization.required";

/**
 * Whether the session held for the person after it last emitted an event
 * `asked` matches. A question, approval, or sign-in parks the open turn
 * (`turn.waiting`) after each request, or once after requests raised
 * together; a session-limit prompt ends the turn (`session.waiting`).
 */
async function holdsFor(
  session: Session,
  asked: (event: MessageStreamEvent) => boolean,
): Promise<boolean> {
  const tail = await session.getStreamTailIndex();
  if (tail < 0) return false;
  const reader = (await session.getEventStream({ startIndex: 0 })).getReader();
  let seen = false;
  let held = false;
  try {
    for (let index = 0; index <= tail; index += 1) {
      const { done, value } = await reader.read();
      if (done) break;
      if (asked(value)) {
        seen = true;
        held = false;
      } else if (
        seen &&
        ((value.type === "turn.waiting" && value.data.on === "input") ||
          value.type === "session.waiting")
      ) {
        held = true;
      }
    }
  } finally {
    await reader.cancel();
  }
  return held;
}

function gatedTool(
  name: GatedTool,
  description: string,
  execute: () => unknown,
  response?: ApprovalResponsePolicy,
) {
  return {
    logicalPath: `tools/${name}.ts`,
    loadNamespace: async () => ({
      default: defineTool({
        approval: response === undefined ? always() : { request: always(), response },
        description: `${description} Only call when asked to use ${name}.`,
        execute: async () => execute(),
        inputSchema: z.object({ release: z.string().optional() }),
      }),
    }),
  };
}

function samePrincipal(a: SessionAuthContext, b: SessionAuthContext): boolean {
  return (
    a.authenticator === b.authenticator &&
    a.issuer === b.issuer &&
    a.principalType === b.principalType &&
    a.principalId === b.principalId
  );
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

/**
 * Without a tool to call, the test model replies `Bootstrap reply: <input>`,
 * echoing the input with any context the channel wrapped around it.
 */
function isMockReplyTo(text: string, message: string): boolean {
  return text.startsWith("Bootstrap reply") && text.includes(message);
}

/**
 * Delivers the provider's redirect to eve's framework callback route. A
 * callback for a sign-in eve no longer waits on is answered `404`, which a
 * person would see as an error page; rules assert what follows instead.
 */
async function deliverSignInCallback(callbackUrl: string): Promise<void> {
  const url = new URL(callbackUrl);
  url.searchParams.set("code", SIGN_IN_CODE);
  const segments = url.pathname.split("/");
  const at = segments.lastIndexOf("callback");
  const [name, attemptId, token] = [at - 1, at + 1, at + 2].map((index) =>
    decodeURIComponent(segments[index] ?? ""),
  );
  const context: RouteContext = {
    params: { attemptId, name, token } as Record<string, string>,
    requestIp: null,
    waitUntil: () => {},
  };
  const response = await handleConnectionCallbackRequest(new Request(url), context);
  if (!response.ok && response.status !== 404) {
    throw new Error(`The sign-in callback answered ${response.status}.`);
  }
}

/** The test model reports a denied call's `execution-denied` result in its reply. */
function isMockDenialReply(text: string): boolean {
  return text.includes('"type":"execution-denied"');
}
