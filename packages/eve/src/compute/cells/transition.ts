import { Buffer } from "node:buffer";

import { decodeWireValue, encodeWireValue } from "#compute/codec.js";
import { ComputeError } from "#compute/errors.js";
import { DEFAULT_COMPUTE_LIMITS, type ComputeLimits } from "#compute/limits.js";
import type {
  CellAddress,
  CellMessage,
  DurableEvent,
  EffectRequest,
  WireValue,
} from "#compute/protocol.js";
import {
  assertDefinitionId,
  assertExactKeys,
  assertLocalKey,
  assertRecord,
  assertUtcTimestamp,
  assertUuid,
  assertVersion,
  invalidInput,
} from "#compute/validation.js";

export interface NormalizedEffectRequest extends Omit<EffectRequest, "input"> {
  input: WireValue;
}

export interface NormalizedCellMessage extends Omit<CellMessage, "message"> {
  message: WireValue;
}

export type NormalizedTimerRequest =
  | { action: "cancel"; key: string }
  | {
      action: "set";
      deadline: string;
      key: string;
      message: WireValue;
      messageVersion: number;
    };

export interface NormalizedDurableEvent extends Omit<DurableEvent, "value"> {
  value: WireValue;
}

export interface NormalizedCellTransition {
  effects: NormalizedEffectRequest[];
  events: NormalizedDurableEvent[];
  sends: NormalizedCellMessage[];
  state: WireValue;
  terminal: boolean;
  timers: NormalizedTimerRequest[];
}

function assertPayloadSize(value: WireValue, maxBytes: number, label: string): void {
  if (Buffer.byteLength(value.data, "utf8") > maxBytes) {
    throw new ComputeError("PAYLOAD_TOO_LARGE", `${label} exceeds the configured byte limit.`);
  }
}

function parseArray(value: unknown, label: string, maximum: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidInput(`${label} must be an array.`);
  if (value.length > maximum) {
    throw new ComputeError("PAYLOAD_TOO_LARGE", `${label} exceeds the configured item limit.`);
  }
  return value;
}

function assertDistinctKeys(values: readonly { key: string }[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.key)) invalidInput(`${label} contains duplicate key "${value.key}".`);
    seen.add(value.key);
  }
}

function parseEffect(
  value: unknown,
  index: number,
  limits: ComputeLimits,
): NormalizedEffectRequest {
  const label = `transition.effects[${index}]`;
  assertRecord(value, label);
  assertExactKeys(value, ["key", "definition", "inputVersion", "input"], label);
  assertLocalKey(value.key, `${label}.key`);
  assertDefinitionId(value.definition, `${label}.definition`);
  assertVersion(value.inputVersion, `${label}.inputVersion`);
  const input = encodeWireValue(value.input);
  assertPayloadSize(input, limits.maxEffectInputBytes, `${label}.input`);
  return {
    key: value.key,
    definition: value.definition,
    inputVersion: value.inputVersion,
    input,
  };
}

function parseAddress(value: unknown, label: string): CellAddress {
  assertRecord(value, label);
  assertExactKeys(value, ["namespaceId", "definition", "key"], label);
  assertUuid(value.namespaceId, `${label}.namespaceId`);
  assertDefinitionId(value.definition, `${label}.definition`);
  assertLocalKey(value.key, `${label}.key`);
  return {
    namespaceId: value.namespaceId,
    definition: value.definition,
    key: value.key,
  };
}

function parseSend(value: unknown, index: number, limits: ComputeLimits): NormalizedCellMessage {
  const label = `transition.sends[${index}]`;
  assertRecord(value, label);
  assertExactKeys(value, ["key", "destination", "messageVersion", "message"], label);
  assertLocalKey(value.key, `${label}.key`);
  const destination = parseAddress(value.destination, `${label}.destination`);
  assertVersion(value.messageVersion, `${label}.messageVersion`);
  const message = encodeWireValue(value.message);
  assertPayloadSize(message, limits.maxMessageBytes, `${label}.message`);
  return {
    key: value.key,
    destination,
    messageVersion: value.messageVersion,
    message,
  };
}

function parseTimer(value: unknown, index: number, limits: ComputeLimits): NormalizedTimerRequest {
  const label = `transition.timers[${index}]`;
  assertRecord(value, label);
  if (value.action === "cancel") {
    assertExactKeys(value, ["action", "key"], label);
    assertLocalKey(value.key, `${label}.key`);
    return { action: "cancel", key: value.key };
  }
  if (value.action !== "set") invalidInput(`${label}.action must be "set" or "cancel".`);
  assertExactKeys(value, ["action", "key", "deadline", "messageVersion", "message"], label);
  assertLocalKey(value.key, `${label}.key`);
  assertUtcTimestamp(value.deadline, `${label}.deadline`);
  assertVersion(value.messageVersion, `${label}.messageVersion`);
  const message = encodeWireValue(value.message);
  assertPayloadSize(message, limits.maxMessageBytes, `${label}.message`);
  return {
    action: "set",
    key: value.key,
    deadline: value.deadline,
    messageVersion: value.messageVersion,
    message,
  };
}

function parseEvent(value: unknown, index: number, limits: ComputeLimits): NormalizedDurableEvent {
  const label = `transition.events[${index}]`;
  assertRecord(value, label);
  assertExactKeys(value, ["key", "value"], label);
  assertLocalKey(value.key, `${label}.key`);
  const event = encodeWireValue(value.value);
  assertPayloadSize(event, limits.maxEventBytes, `${label}.value`);
  return { key: value.key, value: event };
}

export function normalizeCellTransition(
  transition: WireValue,
  limits: ComputeLimits = DEFAULT_COMPUTE_LIMITS,
): NormalizedCellTransition {
  const value = decodeWireValue(transition);
  assertRecord(value, "transition");
  assertExactKeys(
    value,
    ["state", "effects", "sends", "timers", "children", "events", "terminal"],
    "transition",
  );
  const children = parseArray(value.children, "transition.children", 100);
  if (children.length > 0) {
    throw new ComputeError(
      "DEPLOYMENT_UNAVAILABLE",
      "Resumable child starts are not available before milestone B1.",
    );
  }
  const state = encodeWireValue(value.state);
  assertPayloadSize(state, limits.maxCellStateBytes, "transition.state");
  const effects = parseArray(value.effects, "transition.effects", limits.maxTransitionEffects).map(
    (entry, index) => parseEffect(entry, index, limits),
  );
  const sends = parseArray(value.sends, "transition.sends", limits.maxTransitionSends).map(
    (entry, index) => parseSend(entry, index, limits),
  );
  const timers = parseArray(value.timers, "transition.timers", limits.maxTransitionTimers).map(
    (entry, index) => parseTimer(entry, index, limits),
  );
  const events = parseArray(value.events, "transition.events", limits.maxTransitionEvents).map(
    (entry, index) => parseEvent(entry, index, limits),
  );
  if (value.terminal !== undefined && typeof value.terminal !== "boolean") {
    invalidInput("transition.terminal must be a boolean.");
  }
  assertDistinctKeys(effects, "transition.effects");
  assertDistinctKeys(sends, "transition.sends");
  assertDistinctKeys(timers, "transition.timers");
  assertDistinctKeys(events, "transition.events");
  return {
    state,
    effects,
    sends,
    timers,
    events,
    terminal: value.terminal ?? false,
  };
}

export function encodeCellTransition(value: unknown): WireValue {
  return encodeWireValue(value);
}
