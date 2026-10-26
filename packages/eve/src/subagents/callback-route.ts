import { resumeRunnableHook } from "#execution/session-inbox/owner.js";
import { z } from "#compiled/zod/index.js";
import type { RouteContext } from "#public/definitions/channel.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { known } from "#protocol/session-events/common.js";
import type { ResponseOutcome } from "#protocol/session-events/families/response.js";
import { interactionSchemas } from "#protocol/session-events/families/interaction.js";
import { agentTurnOutcomeWithCostSchema } from "#shared/agent-turn-outcome.js";
import { jsonValueSchema } from "#shared/json-schemas.js";
import {
  parseProtocolTwoInputCallback,
  PROTOCOL_TWO_INPUT_CALLBACK_KINDS,
  readProtocolTwoInputCallback,
} from "#subagents/protocol-two-callback.js";
import type { SubagentInteractionHookPayload } from "#channel/types.js";
import {
  readCallbackProtocol,
  REMOTE_CALLBACK_NOT_PENDING,
  REMOTE_CALLBACK_NOT_PENDING_MESSAGE,
  V26_INPUT_REMOTE_AGENT_PROTOCOL,
} from "#protocol/remote-agent-protocol.js";

// The callback token grants access to the pending turn. Validate remote input
// before handing it to the parent; the child session ID is not authority.
const sessionInteractionCallbackSchema = z.object({
  callId: z.string().min(1),
  childSessionId: z.string().min(1),
  kind: z.literal("subagent-interaction"),
  subagentName: z.string().min(1),
  route: z
    .object({
      childContinuationToken: z.string().min(1),
      childSessionInbox: z
        .object({ sessionId: z.string().min(1) })
        .strict()
        .optional(),
      inputSource: z.string().min(1).optional(),
      remote: z
        .object({
          name: z.string().min(1),
          url: z.string().url(),
          forwardPrincipal: z.boolean().optional(),
          sessionId: z.string().min(1),
          resolverId: z.string().min(1).optional(),
        })
        .strict()
        .optional(),
    })
    .optional(),
  events: z.array(
    z.discriminatedUnion("type", [
      interactionSchemas["interaction.opened"],
      interactionSchemas["interaction.settled"],
      z.object({
        type: z.literal("response.admitted"),
        data: z.object({ deliveryId: z.string().optional(), interactionId: z.string() }),
      }),
      z.object({
        type: z.literal("response.settled"),
        data: z.object({
          deliveryId: z.string().optional(),
          interactionId: z.string(),
          outcome: known<ResponseOutcome>(),
          reason: z.string().optional(),
        }),
      }),
    ]),
  ),
});

/** A settled remote turn must state its outcome; callers do not infer its lifecycle. */
const sessionResultCallbackSchema = z.discriminatedUnion("kind", [
  z.object({
    callId: z.string().min(1),
    kind: z.literal("turn.completed"),
    outcome: agentTurnOutcomeWithCostSchema,
    output: jsonValueSchema.optional(),
    subagentName: z.string().min(1),
  }),
  z.object({
    callId: z.string().min(1),
    error: jsonValueSchema,
    kind: z.literal("turn.failed"),
    outcome: agentTurnOutcomeWithCostSchema,
    subagentName: z.string().min(1),
  }),
]);

export async function handleSessionCallbackRequest(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const token = ctx.params.token;
  if (typeof token !== "string" || token.length === 0) {
    return Response.json({ error: "Missing callback token.", ok: false }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
  }

  const forwarded = readInteractionCallback(body, readCallbackProtocol(request.url));
  if (forwarded === null) {
    return Response.json({ error: "Invalid session input callback.", ok: false }, { status: 400 });
  }
  // A protocol 2 callback that records nothing to mirror, such as an approval's own settlement.
  if (isEmptyRelay(forwarded)) return Response.json({ ok: true }, { status: 202 });
  const result = forwarded === undefined ? projectSessionCallbackResult(body) : undefined;
  if (result instanceof Response) return result;

  try {
    await resumeRunnableHook(
      token,
      forwarded ?? { kind: "runtime-action-result", results: [result] },
    );
  } catch {
    return Response.json(
      { code: REMOTE_CALLBACK_NOT_PENDING, error: REMOTE_CALLBACK_NOT_PENDING_MESSAGE, ok: false },
      { status: 404 },
    );
  }

  return Response.json({ ok: true }, { status: 202 });
}

/**
 * A child's input callback as the payload its parent run reads: `undefined` when the body is not
 * one, or comes from a protocol this parent didn't agree to, and `null` when it claims to be but
 * doesn't parse. The callback URL names the protocol the parent agreed with the child.
 */
function readInteractionCallback(
  body: unknown,
  agreedProtocol: number | undefined,
): SubagentInteractionHookPayload | object | null | undefined {
  const kind = callbackKind(body);
  if (kind === "subagent-interaction") {
    const parsed = sessionInteractionCallbackSchema.safeParse(body);
    // The envelope schemas validate each fact's data, though zod infers it as `unknown`.
    return parsed.success ? (parsed.data as SubagentInteractionHookPayload) : null;
  }
  if (!PROTOCOL_TWO_INPUT_CALLBACK_KINDS.has(kind)) return undefined;
  // A parent that agreed to protocol 2 reads its input as v27 relay facts.
  if (agreedProtocol === V26_INPUT_REMOTE_AGENT_PROTOCOL)
    return readProtocolTwoInputCallback(body) ?? null;
  // An unmarked URL is a parent run from before v27, which a child's callback reaches once the
  // deployment upgrades: it reads protocol 2 input as is, as its own deployment's route passed it.
  if (agreedProtocol === undefined) return parseProtocolTwoInputCallback(body) ?? null;
  // A child that agreed to another protocol doesn't send these: refused as an unsupported kind.
  return undefined;
}

function isEmptyRelay(payload: object | null | undefined): boolean {
  if (payload === null || payload === undefined) return false;
  if (Reflect.get(payload, "kind") !== "subagent-interaction") return false;
  const events: unknown = Reflect.get(payload, "events");
  return Array.isArray(events) && events.length === 0;
}

function callbackKind(value: unknown): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return Reflect.get(value, "kind");
}

function projectSessionCallbackResult(value: unknown): RuntimeSubagentChildResult | Response {
  if (value === null || typeof value !== "object") {
    return Response.json({ error: "Expected a JSON object.", ok: false }, { status: 400 });
  }

  const kind = callbackKind(value);
  if (kind !== "turn.completed" && kind !== "turn.failed") {
    return Response.json({ error: "Unsupported callback kind.", ok: false }, { status: 400 });
  }

  const parsed = sessionResultCallbackSchema.safeParse(value);
  if (!parsed.success) {
    return Response.json({ error: "Invalid session result callback.", ok: false }, { status: 400 });
  }
  const payload = parsed.data;

  if (payload.kind === "turn.completed") {
    return {
      callId: payload.callId,
      kind: "subagent-result",
      origin: "child",
      outcome: payload.outcome,
      output: payload.output ?? "",
      subagentName: payload.subagentName,
      // Per-result usage projection (usage spans); the run that opened the
      // child tallies `outcome.usageDelta`, never this field, when present.
      usage: payload.outcome.usageDelta,
    };
  }

  return {
    callId: payload.callId,
    isError: true,
    kind: "subagent-result",
    origin: "child",
    outcome: payload.outcome,
    output: payload.error,
    subagentName: payload.subagentName,
  };
}
