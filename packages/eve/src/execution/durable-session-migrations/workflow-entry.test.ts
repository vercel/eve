import { describe, expect, it } from "vitest";

import {
  createWorkflowEntryInput,
  migrateWorkflowEntryInput,
  WORKFLOW_ENTRY_INPUT_VERSION,
} from "./workflow-entry.js";

describe("workflow entry input migrations", () => {
  it("stamps new workflow inputs with v1", () => {
    expect(
      createWorkflowEntryInput({
        input: { message: "hello" },
        serializedContext: { mode: "conversation" },
      }),
    ).toEqual({
      input: { message: "hello" },
      serializedContext: { mode: "conversation" },
      version: WORKFLOW_ENTRY_INPUT_VERSION,
    });
  });

  it("migrates pre-version inputs without dropping additive fields", () => {
    const input = {
      additiveField: { retained: true },
      input: { message: "hello" },
      serializedContext: { mode: "conversation" },
    };

    expect(migrateWorkflowEntryInput(input)).toEqual({
      ...input,
      version: WORKFLOW_ENTRY_INPUT_VERSION,
    });
  });

  it("returns current inputs unchanged and rejects newer versions", () => {
    const input = {
      additiveField: "retained",
      input: { message: "hello" },
      serializedContext: {},
      version: WORKFLOW_ENTRY_INPUT_VERSION,
    };

    expect(migrateWorkflowEntryInput(input)).toBe(input);
    expect(() => migrateWorkflowEntryInput({ version: 2 })).toThrow(
      /workflow entry input: encountered version 2/,
    );
  });

  it("rejects malformed pre-version inputs", () => {
    expect(() => migrateWorkflowEntryInput({ input: { message: "hello" } })).toThrow(
      /not a recognized pre-version shape/,
    );
    expect(() => migrateWorkflowEntryInput({ input: { message: "hello" }, version: "1" })).toThrow(
      /has no numeric "version" field/,
    );
  });
});
