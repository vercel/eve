import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { z } from "#compiled/zod/index.js";
import { isDeepStrictEqual } from "node:util";
import {
  resolveApprovalPolicy,
  type Approval,
  type ApprovalContext,
  type ApprovalPolicy,
  type ApprovalResponsePolicy,
} from "#approval/definition.js";
import { requesterOnlyResponse } from "#approval/requester-only.js";
import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import {
  inheritApprovalContext,
  isApprovalRecheck,
  scopeApprovalEvaluation,
} from "#approval/evaluation.js";
import { bindScheduleCollection, schedules } from "#public/experimental/schedules/client.js";
import type {
  DefinedDynamicSchedules,
  DynamicSchedulesDefinition,
  ScheduleCreateApproval,
} from "#public/schedules/subscription.js";
import type { PreparedScheduleWrite } from "#runtime/schedules/collection-client.js";
import { scheduleDisplayName } from "#runtime/schedules/record.js";
import { MAX_SCHEDULE_DELAY_MINUTES } from "#runtime/schedules/validation.js";
import { scheduleCollectionToolPrefix } from "#shared/schedule-collection-tools.js";
import { always } from "#tools/approval/policies.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import type { DynamicToolEntry } from "#tools/dynamic.js";

// Approval must retain prepared data across durable suspension, not in a resolver closure.
const PreparedWritesKey = new ContextKey<Readonly<Record<string, PreparedScheduleWrite>>>(
  "eve.schedulePreparedWrites",
);
const nameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[0-9A-Za-z][0-9A-Za-z._-]*$/)
  .describe("Readable display label; it may repeat. Creation returns a unique management name.");
const nameInput = z
  .object({
    name: z
      .string()
      .min(1)
      .max(256)
      .describe("Exact unique management name returned by create/get/list, not the display label."),
  })
  .strict();
const timezoneSchema = z
  .string()
  .describe("IANA timezone; omission means UTC. Delays need no timezone.");
const expressionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cron"),
      cron: z.string().describe("Five-field cron: minute hour day-of-month month day-of-week."),
      timezone: timezoneSchema.optional(),
      jitter: z.number().int().min(1).max(15).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("single"),
      at: z.string().describe("Local YYYY-MM-DDTHH:mm, without offset or fractions."),
      timezone: timezoneSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("delay"),
      minutes: z.number().int().min(1).max(MAX_SCHEDULE_DELAY_MINUTES),
    })
    .strict(),
]);
const timingGuidance =
  "For relative requests use expression { type: 'delay', minutes: 1 }; eve resolves timing after approval and rounds up to minute precision (up to 59 seconds later). Do not guess the clock or ask for a timezone for delays.";

/** One collection behind a set of schedule tools; `scope` names it when it is a named scope. */
export interface ScheduleToolsMember {
  readonly definition: DynamicSchedulesDefinition<any, any, any>;
  readonly collection: string;
  readonly scope?: string;
  /** Explains the named scope, not the shared definition. */
  readonly description?: string;
}

type ReadOrStateOperation = "get" | "list" | "enable" | "disable" | "invoke" | "delete";

/**
 * The tools a schedule collection offers the model, named `schedule__<collection>__<action>`, or
 * `null` when its `tool` is `false`.
 */
export function scheduleCollectionTools<TInput, TPrepared = TInput>(
  definition: DynamicSchedulesDefinition<TInput, StandardSchemaV1<unknown, TInput>, TPrepared>,
  collection: string,
): Record<string, DynamicToolEntry> | null {
  if (definition.tool === false) return null;
  return scheduleTools([{ definition, collection }], scheduleCollectionToolPrefix(collection));
}

/**
 * The one set of tools a definition's named scopes share, under the tool slot `slug`. Each call
 * names a scope, and that scope's resolver, `preparePayload`, and approval policies apply.
 */
export function scheduleScopesTools(
  scopes: readonly (ScheduleToolsMember & { readonly scope: string })[],
  slug: string,
): Record<string, DynamicToolEntry> {
  if (scopes.length === 0) throw new Error(`Schedule tools "${slug}" have no scopes.`);
  return scheduleTools(scopes, slug);
}

function scheduleTools(
  members: readonly ScheduleToolsMember[],
  slug: string,
): Record<string, DynamicToolEntry> {
  const first = members[0]!;
  // A definition's named scopes take a `scope` input; a collection on its own takes none.
  const named = first.scope !== undefined;
  const memberOf = (input: unknown): ScheduleToolsMember => {
    if (!named) return first;
    const scope = (input as { readonly scope?: unknown } | undefined)?.scope;
    const member = members.find((candidate) => candidate.scope === scope);
    if (member === undefined)
      throw new Error(
        `Schedule scope must be one of: ${members.map((candidate) => candidate.scope).join(", ")}.`,
      );
    return member;
  };
  // The scope's client takes the input it would take as a collection of its own.
  const withoutScope = <T extends object>(input: T): T => {
    const { scope: _scope, ...rest } = input as T & { scope?: unknown };
    return rest as T;
  };
  const bind = (member: ScheduleToolsMember) =>
    bindScheduleCollection(member.definition as DefinedDynamicSchedules<any, any, any>);
  const client = (member: ScheduleToolsMember) =>
    schedules(member.definition as DefinedDynamicSchedules<any, any, any>);
  const scopeShape = named
    ? {
        scope: z
          .enum(members.map((member) => member.scope!) as [string, ...string[]])
          .describe(
            `Which schedules the call acts on. ${members
              .map((member) =>
                member.description === undefined
                  ? `"${member.scope}"`
                  : `"${member.scope}": ${member.description}`,
              )
              .join(" ")}`,
          ),
      }
    : {};
  const prefix = `${slug}__`;
  const keyFor = (operation: "create" | "update", callId: string) =>
    `${prefix}${operation}:${callId}`;
  const createSchema = z
    .object({
      ...scopeShape,
      name: nameSchema,
      expression: expressionSchema,
      payload: first.definition.inputSchema,
    })
    .strict();
  const updateSchema = createSchema
    .partial({ expression: true, payload: true })
    .extend({ name: nameInput.shape.name })
    .refine((input) => input.expression !== undefined || input.payload !== undefined, {
      message: "Schedule update requires an expression or replacement payload.",
    });
  const namedSchema = z.object({ ...scopeShape, name: nameInput.shape.name }).strict();
  // Each scope keeps its own policies, and a remembered approval stays with its scope.
  const memberPolicy = <T>(
    context: ApprovalContext,
    input: unknown,
    policyOf: (member: ScheduleToolsMember) => T,
  ): { readonly context: ApprovalContext; readonly policy: T } => {
    const member = memberOf(input);
    return {
      context: named ? scopeApprovalEvaluation(context, member.scope!) : context,
      policy: policyOf(member),
    };
  };
  const operationApproval = (
    operation: ReadOrStateOperation,
    fallback?: ApprovalPolicy,
  ): Approval | undefined => {
    const policyOf = (member: ScheduleToolsMember): Approval | undefined =>
      member.definition.approval?.[operation] ?? fallback;
    if (!named) return policyOf(first);
    if (members.every((member) => policyOf(member) === undefined)) return undefined;
    const approval: { request: ApprovalPolicy; response?: ApprovalResponsePolicy } = {
      request: async (context) => {
        const routed = memberPolicy(context, context.toolInput, policyOf);
        return routed.policy === undefined
          ? "not-applicable"
          : await resolveApprovalPolicy(routed.policy)(routed.context);
      },
    };
    // As for one collection: only a scope that sets a response policy gates the tool's responses.
    const gates = (member: ScheduleToolsMember) => {
      const policy = policyOf(member);
      return typeof policy === "object" && policy.response !== undefined;
    };
    if (members.some(gates))
      approval.response = async (context) => {
        const policy = policyOf(memberOf(context.request.toolInput));
        // A scope without a response policy keeps the default: only the requester answers.
        return typeof policy === "object" && policy.response !== undefined
          ? await policy.response(context)
          : requesterOnlyResponse(context);
      };
    return approval;
  };
  // A response policy on any scope gates the shared tool; the other scopes stay requester-only.
  const gatesResponses = (operation: "create" | "update") =>
    members.some((member) => {
      const policy = member.definition.approval?.[operation];
      return typeof policy === "object" && policy.response !== undefined;
    });
  const createApproval = writeApproval(
    (input) => memberOf(input).definition.approval?.create ?? always(),
    gatesResponses("create"),
    (context, input) => memberPolicy(context, input, () => undefined).context,
    (callId) => keyFor("create", callId),
    async (input) => {
      const parsed = await createSchema.parseAsync(input);
      return (await bind(memberOf(parsed))).prepareCreate(withoutScope(parsed));
    },
    (prepared) => prepared.envelope.payload,
  );
  const updateApproval = writeApproval(
    (input) => memberOf(input).definition.approval?.update ?? always(),
    gatesResponses("update"),
    (context, input) => memberPolicy(context, input, () => undefined).context,
    (callId) => keyFor("update", callId),
    async (input) => {
      const parsed = await updateSchema.parseAsync(input);
      const { name, expression, payload } = parsed;
      const bound = await bind(memberOf(parsed));
      return expression === undefined
        ? bound.prepareUpdate(name, { payload })
        : bound.prepareUpdate(name, { expression, payload });
    },
    (prepared) => prepared.envelope?.payload,
  );
  const define = (
    action: string,
    description: string,
    inputSchema: any,
    execute: ToolDefinition<any, unknown>["execute"],
    approval?: Approval,
  ) => {
    const preface = first.definition.description;
    const tool = defineTool({
      deferred: first.definition.tool === "deferred",
      description: `${preface ? `${preface}\n\n` : ""}${description}`,
      inputSchema,
      approval,
      label: {
        start: (input: { name?: string }) =>
          input.name ? `${action}: ${scheduleDisplayName(input.name)}` : action,
      },
      execute,
    });
    return tool as DynamicToolEntry;
  };
  const takeApproved = (key: string) => ({
    approved: loadContext().get(PreparedWritesKey)?.[key],
    forget: () => {
      const snapshots = { ...loadContext().get(PreparedWritesKey) };
      delete snapshots[key];
      loadContext().set(PreparedWritesKey, snapshots);
    },
  });
  return {
    [`${prefix}create`]: define(
      "Create schedule",
      `Create future work, not an immediate action. The display name may repeat; use the returned unique name for management. ${timingGuidance} Preparation validates the destination before approval; a changed prepared payload requires fresh approval.`,
      createSchema,
      async (input, context) => {
        const { approved, forget } = takeApproved(keyFor("create", context.callId));
        if (approved === undefined || !("displayName" in approved))
          throw new Error(
            "Schedule creation has no prepared approval snapshot. Request creation again.",
          );
        const created = await (await bind(memberOf(input))).create(withoutScope(input), approved);
        forget();
        return created;
      },
      createApproval,
    ),
    [`${prefix}update`]: define(
      "Update schedule",
      `Replace timing and/or the complete payload of an existing schedule. A payload replacement prepares new work and makes the updating caller its creator; timing-only updates preserve ownership. State and dispatch target are unchanged. Already started work is not cancelled. ${timingGuidance}`,
      updateSchema,
      async (input, context) => {
        const { approved, forget } = takeApproved(keyFor("update", context.callId));
        if (approved === undefined || !("name" in approved))
          throw new Error(
            "Schedule update has no prepared approval snapshot. Request update again.",
          );
        const { name, ...patch } = withoutScope(input);
        const updated = await (await bind(memberOf(input))).update(name, patch, approved);
        forget();
        return updated;
      },
      updateApproval,
    ),
    [`${prefix}get`]: define(
      "Read schedule",
      "Read timing/state; stored payload is not returned.",
      namedSchema,
      async (input) => await (await client(memberOf(input))).get(input.name),
      operationApproval("get"),
    ),
    [`${prefix}list`]: define(
      "List schedules",
      "List identity, timing/state, and timestamps; payload is not returned.",
      z
        .object({
          ...scopeShape,
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
      async (input) => await (await client(memberOf(input))).list(withoutScope(input)),
      operationApproval("list"),
    ),
    [`${prefix}enable`]: define(
      "Enable schedule",
      "Enable future occurrences.",
      namedSchema,
      async (input) => await (await client(memberOf(input))).enable(input.name),
      operationApproval("enable", always()),
    ),
    [`${prefix}disable`]: define(
      "Disable schedule",
      "Disable future occurrences; already started work is not cancelled.",
      namedSchema,
      async (input) => await (await client(memberOf(input))).disable(input.name),
      operationApproval("disable", always()),
    ),
    [`${prefix}invoke`]: define(
      "Run schedule",
      "Enqueue an extra occurrence as the stored creator; acceptance is not execution success.",
      namedSchema,
      async (input) => {
        await (await client(memberOf(input))).invoke(input.name);
        return { accepted: true };
      },
      operationApproval("invoke", always()),
    ),
    [`${prefix}delete`]: define(
      "Delete schedule",
      "Delete a schedule; already started work is not cancelled.",
      namedSchema,
      async (input) => ({
        deleted: await (await client(memberOf(input))).delete(input.name),
      }),
      operationApproval("delete", always()),
    ),
  };
}

function writeApproval<TWrite extends PreparedScheduleWrite, TPayload>(
  policyOf: (input: unknown) => ScheduleCreateApproval<TPayload>,
  gatesResponses: boolean,
  contextOf: (context: ApprovalContext, input: unknown) => ApprovalContext,
  keyFor: (callId: string) => string,
  prepare: (input: unknown) => Promise<TWrite>,
  payloadFor: (prepared: TWrite) => TPayload,
) {
  const approval: { request: ApprovalPolicy; response?: ApprovalResponsePolicy } = {
    request: async (context) => {
      try {
        const prepared = await prepare(context.toolInput);
        const key = keyFor(context.callId);
        const previous = loadContext().get(PreparedWritesKey) ?? {};
        if (isApprovalRecheck(context)) {
          if (previous[key] === undefined || !isDeepStrictEqual(previous[key], prepared))
            return {
              type: "denied",
              reason:
                "The prepared schedule changed or its approval expired. Request a new approval.",
            };
        } else {
          const snapshots = {
            ...Object.fromEntries(
              Object.entries(previous)
                .filter(([existing]) => existing !== key)
                .slice(-31),
            ),
            [key]: prepared,
          };
          // Evicted approvals fail closed instead of blocking future creation forever.
          while (Buffer.byteLength(JSON.stringify(snapshots)) > 512 * 1024)
            delete snapshots[Object.keys(snapshots)[0]!];
          loadContext().set(PreparedWritesKey, snapshots);
        }
        const payload = payloadFor(prepared);
        const policy = policyOf(context.toolInput);
        const scoped = contextOf(context, context.toolInput);
        const routed = inheritApprovalContext(scoped, {
          ...scoped,
          toolInput: { ...context.toolInput, payload },
          payload,
        });
        return typeof policy === "function" ? await policy(routed) : await policy.request(routed);
      } catch (error) {
        return {
          type: "denied",
          reason: error instanceof Error ? error.message : "Schedule preparation failed.",
        };
      }
    },
  };
  if (gatesResponses)
    approval.response = async (context) => {
      const policy = policyOf(context.request.toolInput);
      // A scope without a response policy keeps the default: only the requester answers.
      if (typeof policy === "function" || policy.response === undefined)
        return requesterOnlyResponse(context);
      // Each key family is written by one typed preparer; restore that type after durable suspension.
      const prepared = loadContext().get(PreparedWritesKey)?.[keyFor(context.request.callId)] as
        | TWrite
        | undefined;
      if (prepared === undefined)
        return {
          status: "rejected",
          reason: "The prepared schedule approval expired. Request approval again.",
        };
      const payload = payloadFor(prepared);
      return await policy.response({
        ...context,
        request: { ...context.request, toolInput: { ...context.request.toolInput, payload } },
        payload,
      });
    };
  return approval;
}
