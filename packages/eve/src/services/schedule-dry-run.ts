import { ScheduleDispatcher } from "#channel/schedule.js";
import type {
  RunInput,
  Runtime,
  SessionAuthContext,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { levenshteinSimilarity } from "#evals/expect/levenshtein.js";
import type { ScheduleRunHandler } from "#public/definitions/schedule.js";
import type {
  DynamicSchedulesDefinition,
  SchedulePrincipalReference,
} from "#public/schedules/subscription.js";
import { createScheduleCollectionPayload } from "#runtime/schedules/payload.js";
import {
  loadResolvedCompiledSchedules,
  loadScheduleRun,
} from "#runtime/schedules/resolve-schedule.js";
import { declared } from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";
import type { MessageContent } from "#shared/message-content.js";
import { loadDryRunApp, withRecordedFetch, type DryRunFetch } from "#services/dry-run.js";
import {
  principalAuth,
  previewTurn,
  type PreviewPrincipal,
  type TurnPreview,
} from "#services/turn-preview.js";

export interface ScheduleDryRunDelivery {
  readonly channel: string;
  readonly target: unknown;
  readonly auth: SessionAuthContext | null;
  readonly message: MessageContent | null;
  readonly turn: TurnPreview;
}

export interface ScheduleDryRun {
  readonly schedule: string;
  readonly kind: "static" | "dynamic";
  readonly creator: {
    readonly principal: SchedulePrincipalReference;
    readonly auth: SessionAuthContext | null;
  } | null;
  readonly deliveries: readonly ScheduleDryRunDelivery[];
  readonly fetches: readonly DryRunFetch[];
  readonly controls: readonly ("disable" | "delete")[];
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
  readonly payload?: unknown;
  readonly principal?: PreviewPrincipal;
}): Promise<ScheduleDryRun> {
  const { bundle, compiledArtifactsSource, manifest } = await loadDryRunApp(input.appRoot);
  const schedules = await loadResolvedCompiledSchedules({ compiledArtifactsSource });
  const collections = declared(bundle.resolvedAgent, "schedules");
  const schedule = schedules.find((candidate) => candidate.name === input.schedule);
  const collection = collections.find((candidate) => candidate.name === input.schedule);
  if (schedule === undefined && collection === undefined) {
    throw new UnknownScheduleError(input.schedule, [
      ...schedules.map((candidate) => candidate.name),
      ...collections.map((candidate) => candidate.name),
    ]);
  }

  const fetches: DryRunFetch[] = [];
  const runs = new Map<string, RunInput>();
  const targets = new Map<string, unknown>();
  const controls: ("disable" | "delete")[] = [];
  let creator: ScheduleDryRun["creator"] = null;
  const dispatcher = new ScheduleDispatcher({
    channels: bundle.graph.root.channels,
    runtime: recordingRuntime(runs),
  });

  let dispatch: () => Promise<{ readonly waitUntilTasks: readonly Promise<unknown>[] }>;
  if (schedule !== undefined) {
    if (input.payload !== undefined || input.principal !== undefined) {
      throw new Error(
        `--payload and --as apply only to dynamic schedules. "${schedule.name}" is a defineSchedule() schedule, and its handler chooses the auth it sends with.`,
      );
    }
    const run = schedule.hasRun ? await loadScheduleRun(schedule, bundle.moduleMap) : undefined;
    dispatch = () =>
      dispatcher.trigger({
        markdown: schedule.markdown,
        run: run === undefined ? undefined : recordTargets(run, targets),
        scheduleId: schedule.name,
      });
  } else {
    const name = collection!.name;
    if (input.payload === undefined || input.principal === undefined) {
      throw new Error(
        `"${name}" is a dynamic schedule (defineDynamicSchedules), so a dry run needs the stored payload and the creator: pass --payload '<json>' and --as, such as --as user:id=alice.`,
      );
    }
    const principal = creatorReference(input.principal);
    creator = { auth: null, principal };
    const application =
      manifest.scheduleCollections?.find((candidate) => candidate.name === name)?.application ??
      name;
    const definition = recordCollection(collection!.definition, targets, (auth) => {
      creator = { auth, principal };
    });
    dispatch = () =>
      dispatcher.triggerCollection({
        collectionId: name,
        definition,
        occurrence: {
          collection: name,
          executionId: "dry-run-occurrence",
          name: "dry-run",
          scheduleId: "dry-run",
          scheduledAt: new Date().toISOString(),
        },
        payload: createScheduleCollectionPayload({
          application,
          collection: name,
          envelope: { payload: input.payload, principal, scope: principal.principalId, version: 3 },
        }),
        schedule: {
          async delete() {
            controls.push("delete");
          },
          async disable() {
            controls.push("disable");
          },
        },
      });
  }

  return await withRecordedFetch(fetches, async () => {
    let error: string | null = null;
    try {
      const result = await dispatch();
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
    return {
      controls,
      creator,
      deliveries,
      error,
      fetches,
      kind: schedule === undefined ? "dynamic" : "static",
      schedule: input.schedule,
    };
  });
}

function creatorReference(principal: PreviewPrincipal): SchedulePrincipalReference {
  if (principal.kind === "user" && principal.groups.length > 0) {
    throw new Error(
      "A dynamic schedule's creator has no groups of its own: its auth() returns the attributes each run gets. Drop groups= from --as.",
    );
  }
  const auth = principalAuth(principal);
  if (auth === null) {
    throw new Error(
      "A dynamic schedule always has a creator. Use --as user:id=<name> or another principal.",
    );
  }
  return {
    authenticator: auth.authenticator,
    principalId: auth.principalId,
    type: auth.principalType,
    ...(auth.issuer !== undefined && { issuer: auth.issuer }),
    ...(auth.subject !== undefined && { subject: auth.subject }),
  };
}

function recordCollection(
  definition: DynamicSchedulesDefinition<any, any, any>,
  targets: Map<string, unknown>,
  resolved: (auth: SessionAuthContext) => void,
): DynamicSchedulesDefinition<any, any, any> {
  return {
    ...definition,
    run: (args) => {
      resolved(args.auth);
      return definition.run({ ...args, to: recordTo(args.to, targets) });
    },
  };
}

function recordTargets(run: ScheduleRunHandler, targets: Map<string, unknown>): ScheduleRunHandler {
  return (args) => run({ ...args, to: recordTo(args.to, targets) });
}

interface SendHandle {
  // oxlint-disable-next-line typescript/no-explicit-any -- static and dynamic schedules send different options.
  send(message: any, options?: any): Promise<{ readonly sessionId: string }>;
}

// oxlint-disable-next-line typescript/no-explicit-any -- static and dynamic schedules take different channels.
function recordTo<T extends (channel: any, target: any) => SendHandle>(
  to: T,
  targets: Map<string, unknown>,
): T {
  return ((channel: unknown, target: unknown) => {
    const destination = to(channel, target);
    return {
      async send(message: unknown, options?: unknown) {
        const delivery = await destination.send(message, options);
        targets.set(delivery.sessionId, target);
        return delivery;
      },
    };
  }) as T;
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
