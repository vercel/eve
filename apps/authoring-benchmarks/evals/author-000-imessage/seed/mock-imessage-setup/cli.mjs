#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const PROTOCOL_VERSION = 2;
const EVENT_LOG = "__authoring_eval__/world-events.jsonl";
const STATE_FILE = "__authoring_eval__/mock-imessage-state.json";
const EXPECTED_PHONE = process.env.EVE_AUTHORING_PHONE_NUMBER ?? "+15551234567";

const { values } = parseArgs({
  options: {
    answer: { type: "string", multiple: true, default: [] },
    "non-interactive": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
  strict: true,
});
const answers = Object.fromEntries(
  values.answer.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator === -1) throw new Error(`Invalid answer ${JSON.stringify(entry)}.`);
    return [entry.slice(0, separator), JSON.parse(entry.slice(separator + 1))];
  }),
);
const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { projectCreated: false, phoneRegistered: false };

process.send?.({ type: "ready", version: PROTOCOL_VERSION });
record("setup.started", { nonInteractive: values["non-interactive"], yes: values.yes });

let exiting = false;
let outcome;
if (!values["non-interactive"]) {
  finish({
    kind: "failed",
    error: { message: "This deterministic setup requires --non-interactive." },
  });
} else if (answers.phoneNumber === undefined) {
  record("phone.requested");
  finish({
    kind: "blocked",
    blocker: {
      status: "input_required",
      question: {
        key: "phoneNumber",
        kind: "text",
        message: "What phone number should receive iMessages?",
        required: true,
        sensitive: false,
      },
    },
  });
} else if (answers.phoneNumber !== EXPECTED_PHONE) {
  record("phone.rejected", { supplied: String(answers.phoneNumber) });
  finish({
    kind: "blocked",
    blocker: {
      status: "input_required",
      question: {
        key: "phoneNumber",
        kind: "text",
        message: "What phone number should receive iMessages?",
        required: true,
        sensitive: false,
      },
      issue: { code: "invalid_answer", message: "Use the user's supplied phone number." },
    },
  });
} else {
  if (!state.projectCreated) {
    state.projectCreated = true;
    record("project.created", { id: "mock-imessage-project" });
  }
  if (!state.phoneRegistered) {
    state.phoneRegistered = true;
    record("phone.registered", { phoneNumber: EXPECTED_PHONE });
  }
  persist();
  record("setup.completed");
  finish({
    kind: "completed",
    facts: [
      { label: "Provider project", value: "mock-imessage-project" },
      { label: "Phone number", value: EXPECTED_PHONE, kind: "phone" },
    ],
    deploymentRequired: true,
  });
}

function record(type, data) {
  appendFileSync(EVENT_LOG, `${JSON.stringify({ at: new Date().toISOString(), type, data })}\n`);
}

function persist() {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function finish(result) {
  if (exiting) return;
  exiting = true;
  outcome = result;
  process.send?.({ type: "result", outcome: result });
  setImmediate(() => process.exit(result.kind === "failed" ? 1 : 0));
}

process.on("disconnect", () => {
  if (!exiting) process.exit(1);
});

process.on("message", (message) => {
  if (message?.type === "cancel") finish({ kind: "cancelled" });
});

process.on("exit", () => {
  if (outcome === undefined) record("setup.aborted");
});
