import { ScheduleDispatcher } from "#channel/schedule.js";
import type {
  RunInput,
  Runtime,
  SessionAuthContext,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { compileAgent } from "#compiler/compile-agent.js";
import { levenshteinSimilarity } from "#evals/expect/levenshtein.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import type { ScheduleRunHandler } from "#public/definitions/schedule.js";
import {
  loadResolvedCompiledSchedules,
  loadScheduleRun,
} from "#runtime/schedules/resolve-schedule.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { toErrorMessage } from "#shared/errors.js";
import type { MessageContent } from "#shared/message-content.js";
import { previewTurn, type TurnPreview } from "#services/turn-preview.js";

export interface ScheduleDryRunDelivery {
  readonly channel: string;
  readonly target: unknown;
  readonly auth: SessionAuthContext | null;
  readonly message: MessageContent | null;
  readonly turn: TurnPreview;
}

export interface ScheduleDryRunFetch {
  readonly method: string;
  readonly url: string;
}

export interface ScheduleDryRun {
  readonly schedule: string;
  readonly deliveries: readonly ScheduleDryRunDelivery[];
  readonly fetches: readonly ScheduleDryRunFetch[];
  readonly error: string | null;
}

export class UnknownScheduleError extends Error {
  override readonly name = "UnknownScheduleError";
  readonly available: readonly string[];
  readonly suggestion: string | undefined;

  constructor(schedule: string, available: readonly string[]) {
    const suggestion = closestName(schedule, available);
    super(
      [
        `Unknown schedule "${schedule}".`,
        suggestion === undefined ? undefined : `Did you mean "${suggestion}"?`,
        available.length === 0
          ? "This app declares no schedules in agent/schedules/."
          : `Available schedules: ${available.join(", ")}.`,
      ]
        .filter((line) => line !== undefined)
        .join(" "),
    );
    this.available = available;
    this.suggestion = suggestion;
  }
}

export async function dryRunSchedule(input: {
  readonly appRoot: string;
  readonly schedule: string;
}): Promise<ScheduleDryRun> {
  const compiled = await compileAgent({ startPath: input.appRoot });
  const compiledArtifactsSource = createAuthoredSourceRuntimeCompiledArtifactsSource(
    compiled.project.appRoot,
  );
  const schedules = await loadResolvedCompiledSchedules({ compiledArtifactsSource });
  const schedule = schedules.find((candidate) => candidate.name === input.schedule);
  if (schedule === undefined) {
    throw new UnknownScheduleError(
      input.schedule,
      schedules.map((candidate) => candidate.name),
    );
  }
  const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
  const run = schedule.hasRun ? await loadScheduleRun(schedule, bundle.moduleMap) : undefined;

  const fetches: ScheduleDryRunFetch[] = [];
  const runs = new Map<string, RunInput>();
  const targets = new Map<string, unknown>();
  const dispatcher = new ScheduleDispatcher({
    channels: bundle.graph.root.channels,
    runtime: recordingRuntime(runs),
  });

  return await withRecordedFetch(fetches, async () => {
    let error: string | null = null;
    try {
      const result = await dispatcher.trigger({
        markdown: schedule.markdown,
        run: run === undefined ? undefined : recordTargets(run, targets),
        scheduleId: schedule.name,
      });
      await Promise.all(result.waitUntilTasks);
    } catch (thrown) {
      error = toErrorMessage(thrown);
    }
    const deliveries: ScheduleDryRunDelivery[] = [];
    for (const [sessionId, started] of runs) {
      deliveries.push({
        auth: started.auth,
        channel: started.channelName ?? started.adapter.kind,
        message: started.input.message ?? null,
        target: targets.get(sessionId) ?? null,
        turn: await previewTurn({ bundle, run: started }),
      });
    }
    return { deliveries, error, fetches, schedule: schedule.name };
  });
}

function recordTargets(run: ScheduleRunHandler, targets: Map<string, unknown>): ScheduleRunHandler {
  return (args) =>
    run({
      ...args,
      to: (channel, target) => {
        const destination = args.to(channel, target);
        return {
          async send(message, options) {
            const delivery = await destination.send(message, options);
            targets.set(delivery.sessionId, target);
            return delivery;
          },
        };
      },
    });
}

function recordingRuntime(runs: Map<string, RunInput>): Runtime {
  return {
    async createSession(run) {
      const sessionId = `dry-run-session-${runs.size + 1}`;
      runs.set(sessionId, run);
      return {
        ...(run.continuationToken !== undefined && { claimedContinuation: true }),
        events: new ReadableStream(),
        sessionId,
      };
    },
    async dispatchContinuation<TCommand extends SessionCommand>() {
      return { status: "session_not_active" } as SessionCommandResult<TCommand>;
    },
    async dispatchSession() {
      throw new Error("A dry run starts no session, so it has none to send to.");
    },
    async getEventStream() {
      return new ReadableStream();
    },
    async getLineStream() {
      return new ReadableStream();
    },
    async getStreamTailIndex() {
      return -1;
    },
    async resolveContinuation() {
      return undefined;
    },
  };
}

async function withRecordedFetch<T>(
  fetches: ScheduleDryRunFetch[],
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = async (resource, init) => {
    const request = new Request(resource, init);
    fetches.push({ method: request.method, url: request.url });
    return Response.json({});
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function closestName(name: string, candidates: readonly string[]): string | undefined {
  let best: { readonly name: string; readonly score: number } | undefined;
  for (const candidate of candidates) {
    const score = candidate.includes(name)
      ? 1
      : levenshteinSimilarity(name.toLowerCase(), candidate.toLowerCase());
    if (score >= 0.5 && (best === undefined || score > best.score))
      best = { name: candidate, score };
  }
  return best?.name;
}
