import { createHash } from "node:crypto";

import { modelMessageSchema, type ModelMessage } from "ai";

import { toModelMessages, type HistoryMessage } from "#execution/tools/workflow/history.js";
import type { SessionStateMap } from "#harness/types.js";

const HISTORY_APPEND_STATE_KEY = "eve.runtime.historyAppends";
const MAX_HISTORY_APPEND_BYTES = 256 * 1024;
const MAX_HISTORY_APPEND_MESSAGES = 256;
const MAX_OPERATION_ID_LENGTH = 256;

interface HistoryAppendRecord {
  readonly digest: string;
}

export type HistoryAppendOutcome = "appended" | "already_appended";

interface HistoryAppendSession {
  readonly history: readonly ModelMessage[];
  readonly state?: SessionStateMap;
}

export class HistoryAppendError extends Error {
  readonly code: "conflict" | "invalid_input";

  constructor(code: HistoryAppendError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HistoryAppendError";
    this.code = code;
  }
}

/** Validates and atomically records one application-owned history contribution. */
export function appendSessionHistory<TSession extends HistoryAppendSession>(input: {
  readonly messages: readonly HistoryMessage[];
  readonly operationId: string;
  readonly session: TSession;
}): { readonly outcome: HistoryAppendOutcome; readonly session: TSession } {
  const messages = validateHistoryAppend(input.operationId, input.messages);
  const digest = digestMessages(messages);
  const appends = readHistoryAppendRecords(input.session.state);
  const existing = Object.hasOwn(appends, input.operationId)
    ? appends[input.operationId]
    : undefined;
  if (existing !== undefined) {
    if (existing.digest !== digest) {
      throw new HistoryAppendError(
        "conflict",
        `History append operation "${input.operationId}" was retried with different messages.`,
      );
    }
    return { outcome: "already_appended", session: input.session };
  }
  return {
    outcome: "appended",
    session: {
      ...input.session,
      history: [...input.session.history, ...messages],
      state: {
        ...input.session.state,
        [HISTORY_APPEND_STATE_KEY]: {
          ...appends,
          [input.operationId]: { digest },
        },
      },
    } as TSession,
  };
}

function validateHistoryAppend(
  operationId: string,
  authored: readonly HistoryMessage[],
): ModelMessage[] {
  if (!operationId || operationId.length > MAX_OPERATION_ID_LENGTH) {
    throw invalid(`History append operationId must be 1-${MAX_OPERATION_ID_LENGTH} characters.`);
  }
  if (authored.length === 0 || authored.length > MAX_HISTORY_APPEND_MESSAGES) {
    throw invalid(`History append requires 1-${MAX_HISTORY_APPEND_MESSAGES} messages.`);
  }
  let messages: ModelMessage[];
  try {
    messages = toModelMessages(authored).map((message) => modelMessageSchema.parse(message));
  } catch (error) {
    throw new HistoryAppendError("invalid_input", "History append contains an invalid message.", {
      cause: error,
    });
  }
  if (messages.some((message) => message.role === "system")) {
    throw invalid("History append does not accept system messages.");
  }
  const encoded = encodeDigestValue(messages);
  if (Buffer.byteLength(encoded, "utf8") > MAX_HISTORY_APPEND_BYTES) {
    throw invalid(`History append messages exceed ${MAX_HISTORY_APPEND_BYTES} bytes.`);
  }
  validateToolExchanges(messages);
  return messages;
}

function validateToolExchanges(messages: readonly ModelMessage[]): void {
  const pending = new Set<string>();
  const pendingApprovals = new Set<string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "tool-approval-request") {
          if (pendingApprovals.has(part.approvalId)) {
            throw invalid("History append contains a duplicate approval request.");
          }
          pendingApprovals.add(part.approvalId);
          continue;
        }
        if (part.type !== "tool-call") continue;
        if (seen.has(part.toolCallId))
          throw invalid("History append contains a duplicate tool call.");
        seen.add(part.toolCallId);
        pending.add(part.toolCallId);
      }
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-approval-response") {
          if (!pendingApprovals.delete(part.approvalId)) {
            throw invalid("History append contains an orphaned approval response.");
          }
          continue;
        }
        if (part.type !== "tool-result" || !pending.delete(part.toolCallId)) {
          throw invalid("History append contains an orphaned or duplicate tool result.");
        }
      }
    }
  }
  if (pendingApprovals.size > 0) {
    throw invalid("History append does not accept a pending approval request.");
  }
  if (pending.size > 0) throw invalid("History append contains a tool call without its result.");
}

function digestMessages(messages: readonly ModelMessage[]): string {
  return createHash("sha256").update(encodeDigestValue(messages)).digest("base64url");
}

function encodeDigestValue(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof URL) return { $type: "url", value: item.href };
    if (item instanceof Uint8Array) {
      return { $type: "bytes", value: Buffer.from(item).toString("base64") };
    }
    return item;
  });
}

function invalid(message: string): HistoryAppendError {
  return new HistoryAppendError("invalid_input", message);
}

function readHistoryAppendRecords(
  state: SessionStateMap | undefined,
): Readonly<Record<string, HistoryAppendRecord>> {
  const value = state?.[HISTORY_APPEND_STATE_KEY];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.create(null);
  }
  const records: Record<string, HistoryAppendRecord> = Object.create(null);
  for (const [operationId, record] of Object.entries(value)) {
    if (
      typeof record === "object" &&
      record !== null &&
      typeof Reflect.get(record, "digest") === "string"
    ) {
      records[operationId] = record as HistoryAppendRecord;
    }
  }
  return records;
}
