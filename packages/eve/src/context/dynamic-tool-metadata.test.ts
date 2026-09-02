import { describe, expect, it } from "vitest";

import {
  isCurrentDynamicToolMetadata,
  isOldSourceOffsetDynamicToolMetadata,
  toCurrentDynamicToolMetadata,
  type CurrentDynamicToolMetadata,
  type OldSourceOffsetDynamicToolMetadata,
  type OldStepFunctionDynamicToolMetadata,
  type PersistedDynamicToolMetadata,
} from "#context/dynamic-tool-metadata.js";

const base = {
  description: "test tool",
  entryKey: "tool",
  inputSchema: { type: "object" },
  name: "tool",
  resolverSlug: "test",
} as const;

const current: CurrentDynamicToolMetadata = {
  ...base,
  callbacks: { execute: { closure: { source: "current" } } },
};

const currentWithEveryPhase: CurrentDynamicToolMetadata = {
  ...current,
  callbacks: {
    approvalRequest: { closure: { source: "current" } },
    approvalResponse: { closure: { source: "current" } },
    execute: current.callbacks.execute,
    toModelOutput: { closure: { source: "current" } },
  },
};

const oldStepFunction: OldStepFunctionDynamicToolMetadata = {
  ...base,
  closureVars: { source: "step-function" },
  executeStepFnName: "fn_0",
};

const oldSourceOffset: OldSourceOffsetDynamicToolMetadata = {
  ...base,
  callbacks: {
    execute: {
      closure: { source: "source-offset" },
      stepId: "eve:dynamic-tool//old/execute/0-100",
    },
  },
};

describe("dynamic tool metadata schemas", () => {
  it("distinguishes the current schema from both old schemas", () => {
    expect(isCurrentDynamicToolMetadata(current)).toBe(true);
    expect(isCurrentDynamicToolMetadata(oldStepFunction)).toBe(false);
    expect(isCurrentDynamicToolMetadata(oldSourceOffset)).toBe(false);
    expect(isOldSourceOffsetDynamicToolMetadata(current)).toBe(false);
    expect(isOldSourceOffsetDynamicToolMetadata(oldSourceOffset)).toBe(true);
  });

  it("does not mistake an additive current field for a source offset", () => {
    const additiveCurrent = {
      ...current,
      callbacks: {
        execute: { ...current.callbacks.execute, futureField: true },
      },
    } as PersistedDynamicToolMetadata;

    expect(isCurrentDynamicToolMetadata(additiveCurrent)).toBe(true);
    expect(isOldSourceOffsetDynamicToolMetadata(additiveCurrent)).toBe(false);
  });

  it("preserves current metadata and replaces old step-function metadata", () => {
    expect(toCurrentDynamicToolMetadata(current)).toBe(current);
    expect(toCurrentDynamicToolMetadata(oldStepFunction, current)).toBe(current);
  });

  it("removes source offsets while preserving every callback closure", () => {
    const converted = toCurrentDynamicToolMetadata(
      {
        ...oldSourceOffset,
        callbacks: {
          approvalRequest: { closure: { phase: "request" }, stepId: "old-request" },
          approvalResponse: { closure: { phase: "response" }, stepId: "old-response" },
          execute: oldSourceOffset.callbacks.execute,
          toModelOutput: { closure: { phase: "output" }, stepId: "old-output" },
        },
      },
      currentWithEveryPhase,
    );

    expect(converted.callbacks).toEqual({
      approvalRequest: { closure: { phase: "request" } },
      approvalResponse: { closure: { phase: "response" } },
      execute: { closure: { source: "source-offset" } },
      toModelOutput: { closure: { phase: "output" } },
    });
  });

  it("fails when old step-function metadata has no current resolver replacement", () => {
    expect(() => toCurrentDynamicToolMetadata(oldStepFunction)).toThrow(
      'Dynamic tool "tool" uses old persisted metadata',
    );
  });

  it("requires a matching resolver replacement before converting source offsets", () => {
    expect(() => toCurrentDynamicToolMetadata(oldSourceOffset)).toThrow(
      'Dynamic tool "tool" uses old persisted metadata',
    );
    expect(() =>
      toCurrentDynamicToolMetadata(oldSourceOffset, {
        ...current,
        resolverSlug: "different",
      }),
    ).toThrow('Dynamic tool "tool" received current metadata from a different resolver');
  });

  it("refuses to drop approval phases from old step-function metadata", () => {
    expect(() =>
      toCurrentDynamicToolMetadata(
        { ...oldStepFunction, approvalStepFnName: "old-approval" },
        current,
      ),
    ).toThrow('Dynamic tool "tool" lost its approval-request callback');
  });
});
