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

  it("returns undefined for client-side tools (no execute)", () => {
    expect(wrapToolExecute(baseDef)).toBeUndefined();
  });
});

function isAsyncIterableValue(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

async function collect(value: unknown): Promise<unknown[]> {
  expect(isAsyncIterableValue(value)).toBe(true);
  const collected: unknown[] = [];
  for await (const item of value as AsyncIterable<unknown>) {
    collected.push(item);
  }
  return collected;
}

describe("wrapToolExecute (async-generator execute)", () => {
  it("streams each yield in order and preserves value identity", async () => {
    const first = { step: 1 };
    const second = { step: 2 };
    const wrapped = wrapToolExecute({
      ...baseDef,
      async *execute() {
        yield first;
        yield second;
      },
    })!;
    const ctx = new ContextContainer();
    const collected = await contextStorage.run(ctx, () =>
      collect(wrapped({}, { messages: [], toolCallId: "call_s1" })),
    );

    expect(collected).toHaveLength(2);
    expect(collected[0]).toBe(first);
    expect(collected[1]).toBe(second);
  });

  it("normalizes top-level undefined yields to null", async () => {
    const wrapped = wrapToolExecute({
      ...baseDef,
      async *execute() {
        yield undefined;
      },
    })!;
    const ctx = new ContextContainer();
    const collected = await contextStorage.run(ctx, () =>
      collect(wrapped({}, { messages: [], toolCallId: "call_s2" })),
    );

    expect(collected).toEqual([null]);
  });

  it("rejects a non-JSON-serializable yield at the tool boundary", async () => {
    const wrapped = wrapToolExecute({
      ...baseDef,
      async *execute() {
        yield { now: new Date("2026-01-02T03:04:05.000Z") };
      },
    })!;
    const ctx = new ContextContainer();

    await expect(
      contextStorage.run(ctx, () => collect(wrapped({}, { messages: [], toolCallId: "call_s3" }))),
    ).rejects.toThrow(
      'Tool "t" call "call_s3" returned a non-JSON-serializable result. Expected a JSON-serializable value.',
    );
  });

  it("stashes an authorization-signal yield and ends the stream with opaque model output", async () => {
    const signal = signalWithVerifier();
    let pulledPastSignal = false;
    const wrapped = wrapToolExecute({
      ...baseDef,
      async *execute() {
        yield { partial: true };
        yield signal;
        pulledPastSignal = true;
        yield { never: true };
      },
    })!;
    const ctx = new ContextContainer();
    const collected = await contextStorage.run(ctx, () =>
      collect(wrapped({}, { messages: [], toolCallId: "call_s4" })),
    );

    expect(collected).toHaveLength(2);
    expect(collected[0]).toEqual({ partial: true });
    expect(isAuthorizationPendingModelOutput(collected[1])).toBe(true);
    expect(collected[1]).toEqual(modelFacingAuthorizationOutput(signal));
    expect(collected[1]).not.toHaveProperty("challenges");
    expect(readToolInterrupt(ctx, "call_s4")).toBe(signal);
    expect(pulledPastSignal).toBe(false);
  });
});
