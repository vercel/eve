import { readFileSync } from "node:fs";
import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import type { HarnessAgentSession } from "@ai-sdk/harness/agent";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createOpenCode } from "@ai-sdk/harness-opencode";
import type { Agent, AgentRunResult } from "@vercel/agent-eval";
import { z } from "zod";

import type {
  AuthoringCase,
  AuthoringSetup,
  AuthoringSetupContext,
  AuthoringTurn,
} from "./authoring-case.js";
import { createDependencyCachedSandbox } from "./dependency-sandbox.js";
import { loadAuthoringCase } from "./load-authoring-case.js";
import {
  AGENT_EVAL_DIRECTORY,
  AUTHORING_EVAL_DIRECTORY,
  AUTHORING_EVAL_DIRECTORY_ENV,
  EVE_PACKAGE_PATH,
  SOURCE_ARCHIVE_PATH,
  SOURCE_ROOT,
  WORKSPACE,
} from "./paths.js";
import type { AuthoringTokenUsage, AuthoringTranscriptEntry } from "./protocol.js";
import { BenchmarkTimings } from "./timing.js";

const HARNESS_BRIDGE_PORT = 4172;
const BOOTSTRAP_VERSION = "v8";
// A turn that stops producing output should end the turn, not the eval: the
// remaining turns still run and the graders still see what the agent did.
const TURN_TIMEOUT_SECONDS = Number(process.env.EVE_BENCHMARK_TURN_TIMEOUT ?? 480);
// A turn that has produced no chunk for this long is waiting on the runtime, not
// working. The bound is one slow tool call: the bridge reports a call and its
// result together once the call returns, so an install that takes minutes looks
// from here like silence rather than work in flight.
const TURN_STALL_SECONDS = Number(process.env.EVE_BENCHMARK_TURN_STALL ?? 240);
// The runtime frequently never closes a turn whose last act was the model
// talking, so silence after a closing message has to end the turn on its own.
// Long enough that a pause before the next tool call is not mistaken for one.
const CLOSING_IDLE_MILLIS = 45_000;
// How long to let an aborted turn settle before starting the next one.
const TURN_SETTLE_MILLIS = 15_000;

// The coding agent's own question tool is the one place it can ask the user
// mid-turn. Left unanswered it waits for a human and the runtime stops driving
// the turn, so the harness answers it immediately and points the agent at the
// channel this benchmark can answer on: its reply, which the case's next `send`
// responds to.
type AuthoringHarnessAgent = HarnessAgent<
  ReturnType<typeof createOpenCode>,
  typeof INTERACTIVE_QUESTION_TOOL
>;

const INTERACTIVE_QUESTION_TOOL = {
  question: {
    description: "Ask the user a question and wait for their answer.",
    inputSchema: z.looseObject({}),
    execute: async () =>
      "The user cannot answer an interactive prompt in this environment. Ask the question in your reply instead and end your turn; the user answers in their next message.",
  },
};

export function createAuthoringAgent(subject: {
  readonly model: string;
  readonly archive: Uint8Array;
  readonly dependencyArchive: Uint8Array;
  readonly digest: string;
  readonly dependencyDigest: string;
}): Agent {
  return {
    name: "opencode",
    displayName: "eve authoring harness",
    getApiKeyEnvVar: () => "AI_GATEWAY_API_KEY",
    getDefaultModel: () => subject.model,
    definition: {
      name: "opencode",
      displayName: "eve authoring harness",
      defaultModel: subject.model,
      o11yAgentName: "opencode",
      runnerPath: "",
      getApiKeyEnvVar: () => "AI_GATEWAY_API_KEY",
      install: () => [],
      configFiles: () => [],
      authEnv: () => ({}),
    },
    async run(fixturePath, options): Promise<AgentRunResult> {
      const verbose = options.agentOptions?.verbose === true;
      const log = (message: string) => {
        if (verbose) console.log(message);
      };
      const authoringCase = await loadAuthoringCase(fixturePath);
      const setups = [authoringCase.startingPoint.setup, authoringCase.setup].filter(
        (setup): setup is AuthoringSetup => setup !== undefined,
      );
      const timings = new BenchmarkTimings();
      timings.record("run.context", 0, "success", {
        sourceArchiveBytes: subject.archive.length,
        dependencyArchiveBytes: subject.dependencyArchive.length,
        sourceDigest: subject.digest,
        dependencyDigest: subject.dependencyDigest,
        startingPoint: authoringCase.startingPoint.id,
        setupCount: setups.length,
      });
      const sandbox = createDependencyCachedSandbox({
        archive: subject.archive,
        dependencyArchive: subject.dependencyArchive,
        dependencyDigest: subject.dependencyDigest,
        ports: [HARNESS_BRIDGE_PORT, ...new Set(setups.flatMap((setup) => setup.ports ?? []))],
        env: {
          EVE_INIT_PACKAGE_SPEC: EVE_PACKAGE_PATH,
          [AUTHORING_EVAL_DIRECTORY_ENV]: AUTHORING_EVAL_DIRECTORY,
          ...Object.assign({}, ...setups.map((setup) => setup.environment ?? {})),
        },
        log,
        timings,
      });
      const startedAt = Date.now();
      const commands: string[] = [];
      const transcript: AuthoringTranscriptEntry[] = [];
      let session: HarnessAgentSession | undefined;
      let activeSandbox: HarnessV1NetworkSandboxSession | undefined;
      let workspace: string | undefined;

      const agent = new HarnessAgent({
        id: "eve-authoring-eval",
        harness: createOpenCode({
          auth: "ai-gateway",
          model: openCodeModel(options.model ?? subject.model),
          port: HARNESS_BRIDGE_PORT,
        }),
        sandbox,
        tools: INTERACTIVE_QUESTION_TOOL,
        sandboxConfig: {
          workDir: WORKSPACE,
          bootstrapHash: bootstrapHash(authoringCase, subject),
          onBootstrap: async ({ session: bootstrap, workDir }) => {
            const bootstrapSandbox = bootstrap as HarnessV1NetworkSandboxSession;
            const context = setupContext(bootstrapSandbox, workDir);
            log("[setup] building the selected eve source");
            await bootstrapSubject(
              bootstrapSandbox,
              workDir,
              authoringCase.startingPoint.workspace,
              subject.archive,
              timings,
            );
            // Case setup runs against the finished starting point. A setup that
            // installs a fixture dependency would otherwise create the project's
            // `package.json` itself, and `eve init` would then treat the
            // workspace as an existing package and skip its own scaffold.
            await timings.measure("subject.case-bootstrap", async () => {
              for (const setup of setups) await setup.onBootstrap?.(context);
            });
          },
          onSession: async ({ session: current, sessionWorkDir }) => {
            activeSandbox = current as HarnessV1NetworkSandboxSession;
            workspace = sessionWorkDir;
            const context = setupContext(activeSandbox, workspace);
            await timings.measure("session.setup", async () => {
              for (const setup of setups) await setup.onSession?.(context);
              if (options.agentOptions?.agentsMd !== true) await installBaselineEveWrapper(context);
            });
            if (options.agentOptions?.agentsMd !== true) {
              await context.run("rm -f AGENTS.md CLAUDE.md GEMINI.md");
            }
          },
        },
        permissionMode: "allow-all",
      });

      try {
        session = await timings.measure("session.create", () =>
          agent.createSession({ abortSignal: options.signal }),
        );
        if (activeSandbox === undefined || workspace === undefined) {
          throw new Error("HarnessAgent did not initialize its sandbox session.");
        }

        await authoringCase.interact({
          session,
          transcript,
          send: async (prompt) => {
            transcript.push({ role: "user", content: prompt });
            if (verbose) console.log(`[user] ${prompt}`);
            const turn = transcript.filter((entry) => entry.role === "user").length;
            const result = await timings.measure(`agent.turn.${turn}`, () =>
              runTurn({
                agent,
                session: session!,
                prompt,
                timeout: options.timeout,
                verbose,
                abortSignal: options.signal,
              }),
            );
            const toolCalls = result.toolCalls;
            const usage = result.usage;
            transcript.push({ role: "assistant", content: result.text, toolCalls, usage });
            const details: Record<string, string | number | boolean> = {
              promptCharacters: prompt.length,
              responseCharacters: result.text.length,
              toolCalls: toolCalls.length,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              reasoningTokens: usage.reasoningTokens,
            };
            if (result.stall !== undefined) details.stall = result.stall;
            timings.record(
              `agent.turn.${turn}.summary`,
              0,
              result.stall === undefined ? "success" : "failure",
              details,
            );
            if (result.stall !== undefined) log(`[turn ${turn}] ${result.stall}`);
            commands.push(...shellCommands(result.toolCalls));
            return { text: result.text, toolCalls };
          },
        });

        const projectWorkspace =
          authoringCase.projectDirectory === undefined
            ? workspace
            : `${workspace}/${authoringCase.projectDirectory}`;
        const context = setupContext(activeSandbox, workspace);
        await prepareGraderDirectory(context);
        await context.write(
          `${AGENT_EVAL_DIRECTORY}/results.json`,
          JSON.stringify({ o11y: { shellCommands: commands.map((command) => ({ command })) } }),
        );
        await context.write(
          `${AGENT_EVAL_DIRECTORY}/harness-transcript.json`,
          JSON.stringify(transcript),
        );
        await Promise.all([
          context.write(
            `${AGENT_EVAL_DIRECTORY}/EVAL.test.ts`,
            readFileSync(`${fixturePath}/EVAL.ts`, "utf8"),
          ),
          context.write(
            `${AGENT_EVAL_DIRECTORY}/grader.ts`,
            readFileSync(new URL("./grader.ts", import.meta.url), "utf8"),
          ),
          context.write(
            `${AGENT_EVAL_DIRECTORY}/paths.ts`,
            readFileSync(new URL("./paths.ts", import.meta.url), "utf8"),
          ),
          context.write(
            `${AGENT_EVAL_DIRECTORY}/protocol.ts`,
            readFileSync(new URL("./protocol.ts", import.meta.url), "utf8"),
          ),
        ]);

        log("[grade] running deterministic assertions");
        const test = await timings.measure("validation.grader", () =>
          resultOf(
            activeSandbox!,
            `ln -s ${workspace}/${AGENT_EVAL_DIRECTORY} .eve-grader && trap 'rm -f .eve-grader' EXIT && vitest run .eve-grader/EVAL.test.ts`,
            projectWorkspace,
          ),
        );
        const scriptsResults = Object.fromEntries(
          await Promise.all(
            (options.scripts ?? []).map(async (script) => {
              log(`[${script}] running`);
              const result = await timings.measure(`validation.${script}`, () =>
                resultOf(activeSandbox!, `npm run ${shellQuote(script)}`, projectWorkspace),
              );
              return [
                script,
                { success: result.exitCode === 0, output: `${result.stdout}${result.stderr}` },
              ] as const;
            }),
          ),
        );
        const scriptsPassed = Object.values(scriptsResults).every((result) => result.success);
        timings.record("run.total", Date.now() - startedAt);
        await context.write(
          `${AGENT_EVAL_DIRECTORY}/timings.json`,
          JSON.stringify(timings.entries),
        );
        logTimingSummary(log, timings);
        log(`[result] ${test.exitCode === 0 && scriptsPassed ? "passed" : "failed"}`);
        return {
          success: test.exitCode === 0 && scriptsPassed,
          output: transcript.at(-1)?.content ?? "",
          error:
            test.exitCode === 0 && scriptsPassed ? undefined : `${test.stdout}\n${test.stderr}`,
          duration: Date.now() - startedAt,
          testResult: { success: test.exitCode === 0, output: `${test.stdout}${test.stderr}` },
          transcript: harnessTranscript(transcript),
          scriptsResults,
          sandboxId: activeSandbox.id,
          generatedFiles: timingArtifact(timings),
        };
      } catch (error) {
        timings.record("run.total", Date.now() - startedAt, "failure");
        if (activeSandbox !== undefined && workspace !== undefined) {
          await prepareGraderDirectory(setupContext(activeSandbox, workspace)).catch(
            () => undefined,
          );
          await Promise.all([
            setupContext(activeSandbox, workspace).write(
              `${AGENT_EVAL_DIRECTORY}/harness-transcript.json`,
              JSON.stringify(transcript),
            ),
            setupContext(activeSandbox, workspace).write(
              `${AGENT_EVAL_DIRECTORY}/timings.json`,
              JSON.stringify(timings.entries),
            ),
          ]).catch(() => undefined);
        }
        const result: AgentRunResult = {
          success: false,
          output: transcript.at(-1)?.content ?? "",
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startedAt,
          transcript: harnessTranscript(transcript),
          scriptsResults: {},
          generatedFiles: timingArtifact(timings),
        };
        if (activeSandbox !== undefined) result.sandboxId = activeSandbox.id;
        return result;
      } finally {
        await session?.destroy();
      }
    },
  };
}

interface AuthoringTurnResult extends AuthoringTurn {
  readonly usage: AuthoringTokenUsage;
  /** Set when the turn did not finish on its own and was cut short. */
  readonly stall?: string;
}

// One streaming path for every turn, so a turn that never finishes still yields
// the text and tool calls it produced. The underlying runtime can leave a turn
// open indefinitely after the model's last message, and a turn that consumed the
// whole eval budget used to discard the transcript along with it.
async function runTurn(input: {
  readonly agent: AuthoringHarnessAgent;
  readonly session: HarnessAgentSession;
  readonly prompt: string;
  readonly timeout: number;
  readonly verbose: boolean;
  readonly abortSignal?: AbortSignal;
}): Promise<AuthoringTurnResult> {
  const { agent, session, prompt, timeout, verbose } = input;
  const steps: string[] = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  };
  let current = "";
  let lineOpen = false;
  const turnTimeout = Math.min(timeout, TURN_TIMEOUT_SECONDS);
  let stall: string | undefined;

  // The runtime routinely leaves a turn open after the model's last message and
  // honors neither the total nor the per-chunk budget the SDK passes down, so
  // the harness has to decide when a turn is over. Text the model never follows
  // with a tool call is its closing message, so silence after it ends the turn;
  // silence anywhere else can still be work in flight.
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.abortSignal?.addEventListener("abort", abort, { once: true });
  const deadline = Date.now() + turnTimeout * 1000;

  try {
    const result = await agent.stream({
      session,
      prompt,
      timeout: { totalMs: turnTimeout * 1000, chunkMs: TURN_STALL_SECONDS * 1000 },
      abortSignal: controller.signal,
    });
    const stream = result.fullStream[Symbol.asyncIterator]();
    const tracing = process.env.EVE_BENCHMARK_TRACE_PARTS === "1";
    let lastPartAt = Date.now();
    let pendingTools = 0;
    let stepCalledTool = false;
    let turnLooksDone = false;
    for (;;) {
      const idle = pendingTools > 0 ? Number.POSITIVE_INFINITY : idleBudget(turnLooksDone);
      const budget = Math.min(idle, deadline - Date.now());
      const next = await withDeadline(stream.next(), budget);
      if (next === "expired") {
        if (Date.now() >= deadline) stall = `turn exceeded its ${turnTimeout}s budget`;
        else if (!turnLooksDone) stall = `turn produced no output for ${TURN_STALL_SECONDS}s`;
        await settleStalledTurn(stream, controller, stall ?? "turn ended on its closing message");
        break;
      }
      if (next.done === true) break;
      const part = next.value;
      if (tracing) {
        const now = Date.now();
        console.log(`[part] +${((now - lastPartAt) / 1000).toFixed(1)}s ${part.type}`);
        lastPartAt = now;
      }
      if (part.type === "text-delta") {
        current += part.text;
        // Text the model is not following with a tool call is it signing off.
        // The runtime often emits nothing after that closing message, not even
        // the step boundary, so the text itself has to be the signal.
        turnLooksDone = true;
        if (verbose) {
          if (!lineOpen) process.stdout.write("[assistant] ");
          lineOpen = true;
          process.stdout.write(part.text);
        }
        continue;
      }
      if (verbose && lineOpen) process.stdout.write("\n");
      lineOpen = false;
      if (part.type === "tool-call") {
        // Only a tool call reopens the turn. The parts that bracket a message
        // (`text-start`, `text-end`) are not work, and treating them as work is
        // what used to hide a closing message behind the full stall budget.
        turnLooksDone = false;
        pendingTools += 1;
        stepCalledTool = true;
        toolCalls.push({ name: part.toolName, input: part.input });
        if (verbose) console.log(`[tool] ${formatToolCall(part.toolName, part.input)}`);
      } else if (part.type === "tool-result" || part.type === "tool-error") {
        pendingTools = Math.max(0, pendingTools - 1);
      } else if (part.type === "finish-step") {
        if (current.trim().length > 0) steps.push(current.trim());
        current = "";
        addUsage(usage, (part as { usage?: unknown }).usage);
        turnLooksDone = !stepCalledTool;
        stepCalledTool = false;
      } else if (part.type === "finish") {
        turnLooksDone = true;
      }
    }
  } catch (error) {
    stall = `turn did not finish: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    input.abortSignal?.removeEventListener("abort", abort);
    if (verbose && lineOpen) process.stdout.write("\n");
  }

  if (current.trim().length > 0) steps.push(current.trim());
  const turn: AuthoringTurnResult = { text: steps.join("\n\n"), toolCalls, usage };
  return stall === undefined ? turn : { ...turn, stall };
}

function idleBudget(turnLooksDone: boolean): number {
  return turnLooksDone ? CLOSING_IDLE_MILLIS : TURN_STALL_SECONDS * 1000;
}

// Aborting is what marks the turn finished. Walking away from the stream is not
// enough: the session keeps the turn open and rejects the next prompt as one
// already in progress, which loses every remaining turn of the case. Draining
// afterwards gives that settlement time to land before the next prompt.
async function settleStalledTurn(
  stream: AsyncIterator<unknown>,
  controller: AbortController,
  reason: string,
): Promise<void> {
  controller.abort(new Error(reason));
  await withDeadline(
    (async () => {
      try {
        while ((await stream.next()).done !== true);
      } catch {
        // The abort surfaces here as a rejection, which is the settlement.
      }
    })(),
    TURN_SETTLE_MILLIS,
  );
}

async function withDeadline<T>(promise: Promise<T>, millis: number): Promise<T | "expired"> {
  if (millis <= 0) return "expired";
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"expired">((resolve) => {
        timer = setTimeout(() => resolve("expired"), millis);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function addUsage(total: Record<string, number>, value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const [field, amount] of Object.entries(value as Record<string, unknown>)) {
    if (typeof amount === "number" && Number.isFinite(amount) && total[field] !== undefined) {
      total[field] += amount;
    }
  }
}

function openCodeModel(model: string): string {
  const gatewayModel = model.includes("/") ? model : `anthropic/${model}`;
  // OpenCode's Moonshot provider supplies the OpenAI-compatible transport; the
  // canonical model ID still makes AI Gateway select the requested provider.
  return `moonshotai/${gatewayModel}`;
}

function formatToolCall(name: string, input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string") return command;
  }
  return `${name} ${JSON.stringify(input)}`;
}

async function bootstrapSubject(
  sandbox: HarnessV1NetworkSandboxSession,
  workspace: string,
  workspaceKind: "scaffolded" | "empty",
  archive: Uint8Array,
  timings: BenchmarkTimings,
): Promise<void> {
  await timings.measure("subject.source-upload", async () => {
    await sandbox.writeBinaryFile({ path: SOURCE_ARCHIVE_PATH, content: archive });
  });
  await timings.measure("subject.source-install", () =>
    run(
      sandbox,
      `rm -rf ${SOURCE_ROOT} && mkdir -p ${SOURCE_ROOT} && tar -xzf ${SOURCE_ARCHIVE_PATH} -C ${SOURCE_ROOT} && pnpm --dir ${SOURCE_ROOT} install --frozen-lockfile --offline`,
    ),
  );
  await timings.measure("subject.eve-build", () =>
    run(sandbox, `pnpm --dir ${SOURCE_ROOT} --filter eve build`),
  );
  await timings.measure("subject.eve-pack-and-cli", () =>
    run(
      sandbox,
      `mkdir -p /tmp/eve-package && pnpm --dir ${SOURCE_ROOT}/packages/eve pack --pack-destination /tmp/eve-package && mv $(find /tmp/eve-package -name '*.tgz' -print -quit) ${EVE_PACKAGE_PATH} && ln -sf ${SOURCE_ROOT}/packages/eve/bin/eve.js /usr/local/bin/eve && command -v eve`,
    ),
  );
  const workspaceCommands: string[] = [];
  if (workspaceKind === "scaffolded") {
    workspaceCommands.push(`cd ${shellQuote(workspace)} && AI_AGENT=benchmark eve init .`);
  }
  workspaceCommands.push("command -v vitest >/dev/null");
  if (workspaceKind === "scaffolded") {
    workspaceCommands.push(`test -f ${workspace}/package.json`);
  }
  await timings.measure("subject.workspace-bootstrap", () =>
    run(sandbox, workspaceCommands.join(" && ")),
  );
}

function setupContext(
  sandbox: HarnessV1NetworkSandboxSession,
  workspace: string,
): AuthoringSetupContext {
  return {
    sandbox,
    workspace,
    artifactsRoot: AUTHORING_EVAL_DIRECTORY,
    run: async (command, workingDirectory = workspace) => {
      await run(sandbox, command, workingDirectory);
    },
    write: async (path, content) => {
      await sandbox.writeTextFile({
        path: path.startsWith("/") ? path : `${workspace}/${path}`,
        content,
      });
    },
  };
}

// Created only after the agent's turns finish: an `empty` starting point has to
// look empty to `eve init .`, which refuses to scaffold into a directory that
// already holds entries it does not recognize.
async function prepareGraderDirectory(context: AuthoringSetupContext): Promise<void> {
  await context.run(
    `mkdir -p ${AGENT_EVAL_DIRECTORY} && printf '{"private":true,"type":"module"}\\n' >${AGENT_EVAL_DIRECTORY}/package.json`,
  );
}

async function installBaselineEveWrapper(context: AuthoringSetupContext): Promise<void> {
  await context.run(`
cli_path="/usr/local/bin/eve"
test -x "$cli_path"
real_cli="$cli_path.guided"
if [ ! -e "$real_cli" ]; then mv "$cli_path" "$real_cli"; fi
cat >"$cli_path" <<'EOF'
#!/bin/sh
"$0.guided" "$@"
status=$?
rm -f AGENTS.md CLAUDE.md GEMINI.md
exit "$status"
EOF
chmod +x "$cli_path"
`);
}

function timingArtifact(timings: BenchmarkTimings): Record<string, string> {
  return { "benchmark/timings.json": `${JSON.stringify(timings.entries, null, 2)}\n` };
}

function logTimingSummary(log: (message: string) => void, timings: BenchmarkTimings): void {
  for (const timing of timings.entries) {
    log(`[timing] ${timing.phase}: ${timing.durationMs}ms (${timing.outcome})`);
  }
}

function harnessTranscript(transcript: ReadonlyArray<AuthoringTranscriptEntry>): string {
  return transcript
    .map((entry) => {
      const message: {
        role: AuthoringTranscriptEntry["role"];
        content: unknown;
        usage?: AuthoringTokenUsage;
      } = {
        role: entry.role,
        content:
          entry.role === "assistant"
            ? [
                ...(entry.content ? [{ type: "text", text: entry.content }] : []),
                ...(entry.toolCalls ?? []).map((call) => ({
                  type: "tool_use",
                  name: call.name,
                  input: call.input,
                })),
              ]
            : entry.content,
      };
      if (entry.usage !== undefined) message.usage = entry.usage;
      return JSON.stringify({ type: entry.role, message });
    })
    .join("\n");
}

function shellCommands(toolCalls: ReadonlyArray<{ input: unknown }>): string[] {
  return toolCalls.flatMap((call) => {
    if (typeof call.input !== "object" || call.input === null) return [];
    const command = (call.input as { command?: unknown }).command;
    return typeof command === "string" ? [command] : [];
  });
}

function bootstrapHash(authoringCase: AuthoringCase, subject: { readonly digest: string }): string {
  const setupIds = [authoringCase.startingPoint.setup, authoringCase.setup]
    .filter((setup): setup is AuthoringSetup => setup !== undefined)
    .map((setup) => setup.id)
    .join("-");
  return `eve-authoring-${BOOTSTRAP_VERSION}-${subject.digest}-${authoringCase.startingPoint.id}-${setupIds}`;
}

async function resultOf(
  sandbox: HarnessV1NetworkSandboxSession,
  command: string,
  workingDirectory?: string,
) {
  const options: { command: string; workingDirectory?: string } = { command };
  if (workingDirectory !== undefined) options.workingDirectory = workingDirectory;
  return sandbox.run(options);
}

async function run(
  sandbox: HarnessV1NetworkSandboxSession,
  command: string,
  workingDirectory?: string,
): Promise<void> {
  const result = await resultOf(sandbox, command, workingDirectory);
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed (${result.exitCode}):\n${result.stdout}\n${result.stderr}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
