import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, ChannelInstrumentationKey } from "#context/keys.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import {
  buildTelemetryRuntimeContext,
  type BuildTelemetryRuntimeContextInput,
} from "#harness/instrumentation-runtime-context.js";
import type { HarnessSession } from "#harness/types.js";
import type {
  InstrumentationStepStartedEventInput,
  InstrumentationStepStartedEventResult,
} from "#public/instrumentation/index.js";

const session: HarnessSession = {
  agent: {
    modelReference: { id: "test-model" },
    system: "You are a test assistant.",
    tools: [],
  },
  compaction: { recentWindowSize: 10, threshold: 100_000 },
  continuationToken: "http:test-session",
  history: [],
  sessionId: "test-session",
};

const emissionState: HarnessEmissionState = {
  sessionStarted: true,
  sequence: 2,
  stepIndex: 1,
  turnId: "turn_2",
};

const messages: readonly ModelMessage[] = [{ content: "hello", role: "user" }];

const FRAMEWORK_KEYS = {
  "eve.channel.kind": "unknown",
  "eve.environment": "test",
  "eve.session.id": "test-session",
  "eve.step.index": "1",
  "eve.turn.id": "turn_2",
  "eve.turn.sequence": "2",
  "eve.version": "0.0.0-test",
};

function build(
  overrides: Partial<BuildTelemetryRuntimeContextInput> = {},
): Record<string, unknown> | undefined {
  return buildTelemetryRuntimeContext({
    eveVersion: "0.0.0-test",
    authored: { events: {} },
    emissionState,
    environment: "test",
    modelInput: { instructions: undefined, messages },
    session,
    ...overrides,
  });
}

describe("buildTelemetryRuntimeContext", () => {
  it("returns undefined when no instrumentation is authored", () => {
    expect(build({ authored: undefined })).toBeUndefined();
  });

  it("emits framework identifiers when no resolver is configured", () => {
    expect(build()).toEqual(FRAMEWORK_KEYS);
  });

  it("merges authored step.started runtime context beneath framework keys", () => {
    const runtimeContext = build({
      authored: { events: { "step.started": () => ({ runtimeContext: { team: "platform" } }) } },
    });

    expect(runtimeContext).toEqual({ ...FRAMEWORK_KEYS, team: "platform" });
  });

  it("drops reserved eve.* keys from authored runtime context", () => {
    const runtimeContext = build({
      authored: {
        events: {
          "step.started": () =>
            ({
              runtimeContext: {
                "eve.session.id": "user-override",
                count: 1,
                nested: { ok: true },
                team: "platform",
              },
            }) as never,
        },
      },
    });

    expect(runtimeContext).toEqual({
      ...FRAMEWORK_KEYS,
      count: 1,
      nested: { ok: true },
      team: "platform",
    });
  });

  it("keeps framework context authoritative when authored runtime context throws", () => {
    const runtimeContext = build({
      authored: {
        events: {
          "step.started": () => {
            throw new Error("runtime context resolver failed");
          },
        },
      },
    });

    expect(runtimeContext).toEqual(FRAMEWORK_KEYS);
  });

  it("ignores authored runtime context that returns a Promise", () => {
    const runtimeContext = build({
      authored: {
        events: {
          "step.started": () => Promise.resolve({ runtimeContext: { team: "platform" } }) as never,
        },
      },
    });

    expect(runtimeContext).toEqual(FRAMEWORK_KEYS);
  });

  it("ignores authored event results without runtimeContext", () => {
    const runtimeContext = build({
      authored: {
        events: {
          "step.started": () => ({}) as never,
        },
      },
    });

    expect(runtimeContext).toEqual(FRAMEWORK_KEYS);
  });

  it("treats undefined event results as no-op without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const runtimeContext = build({
        authored: {
          events: {
            "step.started": () => undefined,
          },
        },
      });

      expect(runtimeContext).toEqual(FRAMEWORK_KEYS);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("reflects the active channel kind and exposes channel metadata to the resolver", () => {
    const ctx = new ContextContainer();
    ctx.set(ChannelInstrumentationKey, {
      kind: "channel:support",
      metadata: { triggeringUserId: "U999" },
    });

    const runtimeContext = contextStorage.run(ctx, () =>
      build({
        authored: {
          events: {
            "step.started": (
              input: InstrumentationStepStartedEventInput,
            ): InstrumentationStepStartedEventResult =>
              input.channel.kind === "channel:support"
                ? {
                    runtimeContext: {
                      "slack.user_id":
                        typeof input.channel.metadata["triggeringUserId"] === "string"
                          ? input.channel.metadata["triggeringUserId"]
                          : "",
                    },
                  }
                : { runtimeContext: {} },
          },
        },
      }),
    );

    expect(runtimeContext).toMatchObject({
      "eve.channel.kind": "channel:support",
      "slack.user_id": "U999",
    });
  });

  it("snapshots resolver input so mutating live context cannot change it", () => {
    const roles = ["admin"];
    const channelMetadata = { nested: { value: "original" }, triggeringUserId: "U999" };
    const ctx = new ContextContainer();
    ctx.set(ChannelInstrumentationKey, {
      kind: "channel:support",
      metadata: channelMetadata,
    });
    ctx.set(AuthKey, {
      attributes: { roles },
      authenticator: "jwt",
      principalId: "user-current",
      principalType: "user",
    });

    let captured: InstrumentationStepStartedEventInput | undefined;
    contextStorage.run(ctx, () =>
      build({
        authored: {
          events: {
            "step.started": (input: InstrumentationStepStartedEventInput) => {
              captured = input;
              return { runtimeContext: {} };
            },
          },
        },
      }),
    );

    roles.push("mutated");
    channelMetadata.nested.value = "mutated";

    expect(captured?.session.auth.current?.attributes.roles).toEqual(["admin"]);
    if (captured?.channel.kind !== "channel:support") {
      throw new Error("expected support channel");
    }
    expect(captured.channel.metadata).toMatchObject({ nested: { value: "original" } });
  });
});
