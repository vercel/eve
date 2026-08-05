import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import {
  type AuthorizationSignal,
  authorizationPendingAsJsonObject,
  isAuthorizationPendingModelOutput,
  isAuthorizationSignal,
  modelFacingAuthorizationOutput,
  redactSignalResume,
  requestAuthorization,
} from "#harness/authorization.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { readToolInterrupt, stashToolInterrupt } from "#harness/tool-interrupts.js";
import { wrapToolExecute } from "#harness/tools.js";
import { ToolOutputSerializationError } from "#harness/tool-output-serialization.js";

function signalWithVerifier(): AuthorizationSignal {
  return requestAuthorization([
    {
      name: "linear",
      challenge: { url: "https://idp.example/auth" },
      hookUrl: "https://app.example/cb",
      resume: { verifier: "pkce-secret" },
    },
  ]);
}

const baseDef = {
  name: "t",
  description: "",
  inputSchema: jsonSchema({ type: "object" }),
};

describe("authorizationPendingAsJsonObject", () => {
  it("projects connection names to a plain JsonObject without OAuth fields", () => {
    expect(
      authorizationPendingAsJsonObject({
        connections: ["linear", "github"],
      }),
    ).toEqual({
      __eveAuthorizationPending: true,
      connections: ["linear", "github"],
    });
  });

  it("feeds action.result coercion without double casts", () => {
    const signal = signalWithVerifier();
    const result = createRuntimeToolResultFromValue({
      callId: "call_1",
      output: modelFacingAuthorizationOutput(signal),
      toolName: "linear_submit_issue",
    });

    expect(result.output).toEqual({
      __eveAuthorizationPending: true,
      connections: ["linear"],
    });
  });
});

describe("redactSignalResume", () => {
  it("strips resume but keeps the signal shape + other challenge fields", () => {
    const redacted = redactSignalResume(signalWithVerifier());
    expect(isAuthorizationSignal(redacted)).toBe(true);
    expect(redacted.challenges[0]).toEqual({
      name: "linear",
      challenge: { url: "https://idp.example/auth" },
      hookUrl: "https://app.example/cb",
    });
    expect(redacted.challenges[0]).not.toHaveProperty("resume");
  });
});

describe("tool-interrupt stash", () => {
  it("stores per toolCallId and is never serialized", () => {
    const ctx = new ContextContainer();
    const signal = signalWithVerifier();
    stashToolInterrupt(ctx, "call_1", signal);

    expect(readToolInterrupt(ctx, "call_1")).toBe(signal);
    expect(readToolInterrupt(ctx, "other")).toBeUndefined();
    expect(serializeContext(ctx)["eve.pendingToolInterrupts"]).toBeUndefined();

    ctx.clearVirtualContext();
    expect(readToolInterrupt(ctx, "call_1")).toBeUndefined();
  });
});

describe("wrapToolExecute", () => {
  it("returns opaque model output and stashes the full signal (direct)", async () => {
    const signal = signalWithVerifier();
    const wrapped = wrapToolExecute({ ...baseDef, execute: async () => signal })!;
    const ctx = new ContextContainer();
    const output = await contextStorage.run(ctx, () =>
      wrapped({}, { messages: [], toolCallId: "call_1" }),
    );

    expect(isAuthorizationPendingModelOutput(output)).toBe(true);
    expect(output).toEqual(modelFacingAuthorizationOutput(signal));
    expect(output).not.toHaveProperty("challenges");
    // The full signal (with resume) is available to the park detector.
    expect(readToolInterrupt(ctx, "call_1")).toBe(signal);
  });

  it("passes non-interrupt outputs through unchanged", async () => {
    const wrapped = wrapToolExecute({ ...baseDef, execute: async () => ({ ok: true }) })!;
    const ctx = new ContextContainer();
    const output = await contextStorage.run(ctx, () =>
      wrapped({}, { messages: [], toolCallId: "call_3" }),
    );

    expect(output).toEqual({ ok: true });
    expect(readToolInterrupt(ctx, "call_3")).toBeUndefined();
  });

  it("preserves generators and normalizes every yielded result", async () => {
    const wrapped = wrapToolExecute({
      ...baseDef,
      async *execute() {
        yield { phase: "starting" };
        yield { phase: "complete" };
      },
    })!;
    const ctx = new ContextContainer();

    const outputs = await contextStorage.run(ctx, async () => {
      const output = wrapped({}, { messages: [], toolCallId: "call_4" });
      if (!isAsyncIterable(output)) {
        throw new TypeError("Expected an async iterable.");
      }

      const values: unknown[] = [];
      for await (const value of output) values.push(value);
      return values;
    });

    expect(outputs).toEqual([{ phase: "starting" }, { phase: "complete" }]);
  });

  it("stashes authorization signals yielded from a generator", async () => {
    const signal = signalWithVerifier();
    const wrapped = wrapToolExecute({
      ...baseDef,
      async *execute() {
        yield signal;
      },
    })!;
    const ctx = new ContextContainer();

    const outputs = await contextStorage.run(ctx, async () => {
      const output = wrapped({}, { messages: [], toolCallId: "call_5" });
      if (!isAsyncIterable(output)) {
        throw new TypeError("Expected an async iterable.");
      }

      const values: unknown[] = [];
      for await (const value of output) values.push(value);
      return values;
    });

    expect(outputs).toEqual([modelFacingAuthorizationOutput(signal)]);
    expect(readToolInterrupt(ctx, "call_5")).toBe(signal);
  });

  it("applies execute serialization checks to every yielded result", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const wrapped = wrapToolExecute({
      ...baseDef,
      async *execute() {
        yield circular;
      },
    })!;
    const ctx = new ContextContainer();

    await expect(
      contextStorage.run(ctx, async () => {
        const output = wrapped({}, { messages: [], toolCallId: "call_6" });
        if (!isAsyncIterable(output)) {
          throw new TypeError("Expected an async iterable.");
        }
        for await (const _value of output) void _value;
      }),
    ).rejects.toBeInstanceOf(ToolOutputSerializationError);
  });

  it("returns undefined for client-side tools (no execute)", () => {
    expect(wrapToolExecute(baseDef)).toBeUndefined();
  });
});

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}
