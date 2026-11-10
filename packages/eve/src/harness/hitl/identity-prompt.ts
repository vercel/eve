import { generateId } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { principalOf, type SessionPerson } from "#context/session-auth.js";
import { resolveToolCallInputObject } from "#harness/coordination.js";
import { delegatedMessages, sessionParticipants, turnMessages } from "#harness/sender-line.js";
import { liveProjection } from "#harness/session-machine/current.js";
import type { ApprovalAsk } from "#harness/session-machine/view.js";
import type { Principal } from "#protocol/session-events/envelope.js";
import { displayTitle } from "#protocol/session-projection/display-name.js";
import type { IdentityRequest } from "#runtime/connections/caller-confirmation.js";
import type { JsonObject } from "#shared/json.js";

/**
 * How much of the latest message, and of the call's input, an identity request shows, counted as
 * shown, after escaping. Each input field, and each item inside one, is cut on its own, so a long
 * early value can't hide a later one.
 */
const QUOTE_LIMIT = 280;
const FIELD_LIMIT = 2_000;
const MIN_FIELD_LIMIT = 80;
const MIN_ITEM_LIMIT = 40;
const KEY_LIMIT = 80;
const INPUT_LIMIT = 8_000;

/**
 * What eve asks a person whose identity a call needs: what is asked and of whom, what a
 * remembered approval lets someone else do, the latest message in the turn from someone else,
 * which they approve along with the call, and then the input the call runs with. The short parts
 * come first, so a channel that cuts a long prompt still shows them. Nothing the model wrote
 * names the call. Only the person can approve it; anyone
 * signed in can cancel it.
 */
export function identityApprovalRequest(
  call: {
    readonly callId: string;
    readonly input: unknown;
    readonly toolName: string;
    readonly version?: string;
  },
  identity: IdentityRequest,
  context: {
    readonly confirmed: readonly SessionPerson[];
    readonly responder: SessionAuthContext | undefined;
  },
): ApprovalAsk {
  const { callId, toolName } = call;
  const input = resolveToolCallInputObject(call.input, { callId, toolName });
  const latest = latestMessageFromOthers(identity.person);
  // JSON keeps the quoted text inside its own quotes, so it can't pass for eve's words.
  const quote =
    latest === undefined
      ? ""
      : ` The latest message from someone else, from ${latest.from}, reads: ${encodeText(latest.text, QUOTE_LIMIT)}.`;
  // Under `callerConfirmation: "once"`, the approval is remembered for the person who spoke last.
  const remembered =
    identity.steeredBy === undefined
      ? ""
      : ` Approving also lets ${identity.steeredBy} steer calls that use your identity for the rest of this conversation.`;
  const { confirmed, responder } = context;
  return {
    call: {
      callId,
      input,
      toolName,
      ...(call.version !== undefined && { version: call.version }),
    },
    identity: {
      person: identity.person,
      ...(responder !== undefined && { responder }),
      ...(confirmed.length > 0 && { confirmed }),
    },
    interactionId: generateId(),
    ...(identity.remember !== undefined && { remember: identity.remember }),
    request: {
      allowFreeform: false,
      display: "confirmation",
      kind: "approval",
      options: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Cancel" },
      ],
      prompt: `Approve ${displayTitle(toolName)} with your identity?${remembered}${quote} It runs with ${describeInput(input)}.`,
    },
  };
}

/**
 * The text of the latest message the turn read from someone other than `person`, and who sent it,
 * from the deliveries the turn consumed that name their sender.
 */
function latestMessageFromOthers(
  person: SessionPerson,
): { readonly from: string; readonly text: string } | undefined {
  const projection = liveProjection();
  if (projection === undefined) return undefined;
  // A delivery names its sender without how they signed in, so eve compares the people who have
  // spoken by `principalOf`: a delivery is the person's only when no one else who has spoken
  // could have sent it.
  const key = principalOf(person);
  const others = (sessionParticipants() ?? []).filter((other) => principalOf(other) !== key);
  const sentBy = (principal: Principal) =>
    names(principal, person) && !others.some((other) => names(principal, other));
  // A local child's own messages come from the agent that delegated to it, so the messages its
  // parent's turn read count too, before the child's own.
  const latest = [...(delegatedMessages() ?? []), ...turnMessages(projection)]
    .filter((message) => !sentBy(message.from))
    .at(-1);
  return latest === undefined ? undefined : { from: latest.from.id, text: latest.text };
}

/** Whether a delivery's principal names `person`, as far as the wire tells. */
function names(principal: Principal, person: SessionPerson): boolean {
  return (
    principal.id === person.principalId &&
    principal.type === person.principalType &&
    (principal.issuer ?? null) === (person.issuer ?? null)
  );
}

/**
 * The call's input as an identity request shows it: every top-level field, each cut on its own
 * with a marker that says how much is hidden. Fields past the overall limit are counted.
 */
function describeInput(input: JsonObject): string {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return "no input";
  const limit = Math.min(
    FIELD_LIMIT,
    Math.max(MIN_FIELD_LIMIT, Math.floor(INPUT_LIMIT / entries.length)),
  );
  return describeEntries(entries, limit, INPUT_LIMIT, "fields");
}

/** `key: value` pairs, each value cut at `limit` shown characters, until `total` is spent. */
function describeEntries(
  entries: readonly (readonly [string | undefined, unknown])[],
  limit: number,
  total: number,
  noun: "fields" | "items",
): string {
  const shown: string[] = [];
  let length = 0;
  for (const [index, [name, value]] of entries.entries()) {
    const key = name === undefined ? "" : `${encodeText(name, KEY_LIMIT)}: `;
    const entry = `${key}${describeValue(value, limit)}`;
    if (shown.length > 0 && length + entry.length > total) {
      shown.push(`and ${String(entries.length - index)} more ${noun} not shown`);
      break;
    }
    shown.push(entry);
    length += entry.length;
  }
  return shown.join(", ");
}

/**
 * One input value as JSON, at most about `limit` characters as shown. A string is cut after
 * escaping; an array or object shares `limit` among its items, so a later item stays visible.
 */
function describeValue(value: unknown, limit: number): string {
  if (typeof value === "string") return encodeText(value, limit);
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const isArray = Array.isArray(value);
  const entries: (readonly [string | undefined, unknown])[] = isArray
    ? value.map((item: unknown) => [undefined, item] as const)
    : Object.entries(value);
  if (entries.length === 0) return isArray ? "[]" : "{}";
  const share = Math.max(MIN_ITEM_LIMIT, Math.floor(limit / entries.length));
  const inner = describeEntries(entries, share, limit, "items");
  return isArray ? `[${inner}]` : `{${inner}}`;
}

/**
 * `text` as a JSON string, cut once its escaped form reaches `limit` characters, with a marker
 * outside the quotes that says how many characters are hidden.
 */
function encodeText(text: string, limit: number): string {
  const encoded = JSON.stringify(text);
  if (encoded.length <= limit) return encoded;
  let head = "";
  let length = 2;
  let used = 0;
  for (const character of text) {
    const escaped = JSON.stringify(character).slice(1, -1);
    if (length + escaped.length > limit) break;
    head += escaped;
    length += escaped.length;
    used += character.length;
  }
  return `"${head}"… (${String(text.length - used)} more characters not shown)`;
}
