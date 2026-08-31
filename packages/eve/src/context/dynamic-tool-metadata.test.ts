import { describe, expect, it } from "vitest";

import {
  isCurrentDynamicToolMetadata,
  toCurrentDynamicToolMetadata,
  type CurrentDynamicToolMetadata,
  type OldSourceOffsetDynamicToolMetadata,
  type OldStepFunctionDynamicToolMetadata,
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
  });

  it("preserves current metadata and replaces old metadata with resolved current metadata", () => {
    expect(toCurrentDynamicToolMetadata(current, undefined)).toBe(current);
    expect(toCurrentDynamicToolMetadata(oldStepFunction, current)).toBe(current);
    expect(toCurrentDynamicToolMetadata(oldSourceOffset, current)).toBe(current);
  });

  it("fails when an old payload has no current resolver replacement", () => {
    expect(() => toCurrentDynamicToolMetadata(oldSourceOffset, undefined)).toThrow(
      'Dynamic tool "tool" uses old persisted metadata',
    );
  });
});
