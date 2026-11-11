import { generateId } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { SessionPerson } from "#context/session-auth.js";
import { resolveToolCallInputObject } from "#harness/coordination.js";
import { delegatedMessages, sentBy, turnMessages } from "#harness/sender-line.js";
import { liveProjection } from "#harness/session-machine/current.js";
import type { ApprovalAsk } from "#harness/session-machine/view.js";
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
const HIDDEN_NAMES_LIMIT = 5;

/**
 * What eve asks a person whose identity a call needs. The short parts come first, so a channel that
 * cuts a long prompt still shows them, and nothing the model wrote names the call.
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
  // JSON keeps the quoted text and the ids a channel chose inside their own quotes, so they can't
  // pass for eve's words.
  const quote =
    latest === undefined
      ? ""
      : ` The latest message from someone else, from ${JSON.stringify(latest.from)}, reads: ${encodeText(latest.text, QUOTE_LIMIT)}.`;
  // Under `callerConfirmation: "once"`, the approval is remembered for the person who spoke last.
  const remembered =
    identity.steeredBy === undefined
      ? ""
      : ` Approving also lets ${JSON.stringify(identity.steeredBy)} steer calls that use your identity for the rest of this conversation.`;
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
  // A local child's own messages come from the agent that delegated to it, so the messages its
  // parent's turn read count too, before the child's own.
  const latest = [...(delegatedMessages() ?? []), ...turnMessages(projection)]
    .filter((message) => message.text !== "" && !sentBy(message, person))
    .at(-1);
  return latest === undefined ? undefined : { from: latest.from.id, text: latest.text };
}

/**
 * The call's input as an identity request shows it: every top-level field, each cut on its own
 * with a marker that says how much is hidden. Only an input with more fields than the limit fits
 * at their smallest share is cut short, and the fields it hides are counted and the first named.
 */
function describeInput(input: JsonObject): string {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return "no input";
  const limit = Math.min(
    FIELD_LIMIT,
    Math.max(MIN_FIELD_LIMIT, Math.floor(INPUT_LIMIT / entries.length)),
  );
  const total = entries.length * MIN_FIELD_LIMIT <= INPUT_LIMIT ? Infinity : INPUT_LIMIT;
  return describeEntries(entries, limit, total, "fields");
}

/**
 * `key: value` pairs, each value cut at `limit` shown characters, until `total` is spent. The rest
 * are counted, and the first few named.
 */
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
      const hidden = entries.length - index;
      const named = entries
        .slice(index, index + HIDDEN_NAMES_LIMIT)
        .flatMap(([other]) => (other === undefined ? [] : [encodeText(other, KEY_LIMIT)]));
      const names =
        named.length === 0 ? "" : ` (${named.join(", ")}${hidden > named.length ? ", …" : ""})`;
      shown.push(`and ${String(hidden)} more ${noun} not shown${names}`);
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
