import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, ChannelInstrumentationKey } from "#context/keys.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import {
  buildTelemetryRuntimeContext,
  type BuildTelemetryRuntimeContextInput,
} from "#instrumentation/runtime-context.js";
import type { RuntimeContextResolver } from "#tracing/otel-declaration.js";
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
    capturesContent: false,
    eveVersion: "0.0.0-test",
    emissionState,
    environment: "test",
    modelInput: { instructions: undefined, messages },
    session,
    stepStartedResolver: () => undefined,
    ...overrides,
  });
}

describe("buildTelemetryRuntimeContext", () => {
  it("returns undefined when no instrumentation is authored", () => {
    expect(build({ stepStartedResolver: undefined })).toBeUndefined();
  });

  it("emits framework identifiers when no resolver is configured", () => {
    expect(build()).toEqual(FRAMEWORK_KEYS);
  });

  it("merges authored step.started runtime context beneath framework keys", () => {
    const runtimeContext = build({
      stepStartedResolver: () => ({ runtimeContext: { team: "platform" } }),
    });

    expect(runtimeContext).toEqual({ ...FRAMEWORK_KEYS, team: "platform" });
  });

  it("drops reserved eve.* keys from authored runtime context", () => {
    const runtimeContext = build({
      stepStartedResolver: () =>
        ({
          runtimeContext: {
            "eve.session.id": "user-override",
            count: 1,
            nested: { ok: true },
            team: "platform",
          },
        }) as never,
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
      stepStartedResolver: () => {
        throw new Error("runtime context resolver failed");
      },
    });

    expect(runtimeContext).toEqual(FRAMEWORK_KEYS);
  });

  it("ignores authored runtime context that returns a Promise", () => {
    const runtimeContext = build({
      stepStartedResolver: () => Promise.resolve({ runtimeContext: { team: "platform" } }) as never,
    });

    expect(runtimeContext).toEqual(FRAMEWORK_KEYS);
  });

  it("ignores authored event results without runtimeContext", () => {
    const runtimeContext = build({
      stepStartedResolver: () => ({}) as never,
    });

    expect(runtimeContext).toEqual(FRAMEWORK_KEYS);
  });

  it("treats undefined event results as no-op without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const runtimeContext = build({
        stepStartedResolver: () => undefined,
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
        stepStartedResolver: (
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
      }),
    );

    expect(runtimeContext).toMatchObject({
      "eve.channel.kind": "channel:support",
      "slack.user_id": "U999",
    });
  });

  it("withholds model content from hosted unknown-audience resolvers", () => {
    let captured: InstrumentationStepStartedEventInput | undefined;

    build({
      stepStartedResolver: (input: InstrumentationStepStartedEventInput) => {
        captured = input;
        return { runtimeContext: {} };
      },
    });

    expect(captured?.modelInput).toEqual({ instructions: undefined, messages: [] });
  });

  it("exposes model content when worker controls allow it", () => {
    const ctx = new ContextContainer();
    ctx.set(ChannelInstrumentationKey, {
      kind: "channel:public",
      metadata: { audience: "public" },
    });
    let captured: InstrumentationStepStartedEventInput | undefined;

    contextStorage.run(ctx, () =>
      build({
        capturesContent: true,
        stepStartedResolver: (input: InstrumentationStepStartedEventInput) => {
          captured = input;
          return { runtimeContext: {} };
        },
      }),
    );

    expect(captured?.modelInput.messages).toEqual(messages);
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
        stepStartedResolver: (input: InstrumentationStepStartedEventInput) => {
          captured = input;
          return { runtimeContext: {} };
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

  describe("provider runtimeContext resolvers", () => {
    it("emits framework keys when a provider resolver returns undefined", () => {
      const resolver: RuntimeContextResolver = () => undefined;
      const runtimeContext = build({
        providerResolvers: [resolver],
        stepStartedResolver: undefined,
      });

      expect(runtimeContext).toEqual(FRAMEWORK_KEYS);
    });

    it("merges a single provider resolver beneath framework keys", () => {
      const resolver: RuntimeContextResolver = () => ({ team: "platform" });
      const runtimeContext = build({
        providerResolvers: [resolver],
        stepStartedResolver: undefined,
      });

      expect(runtimeContext).toEqual({ ...FRAMEWORK_KEYS, team: "platform" });
    });

    it("merges multiple provider resolvers, later ones overriding earlier", () => {
      const first: RuntimeContextResolver = () => ({ env: "prod", team: "a" });
      const second: RuntimeContextResolver = () => ({ team: "b" });
      const runtimeContext = build({
        providerResolvers: [first, second],
        stepStartedResolver: undefined,
      });

      expect(runtimeContext).toEqual({ ...FRAMEWORK_KEYS, env: "prod", team: "b" });
    });

    it("drops reserved eve.* keys from provider resolver results", () => {
      const resolver: RuntimeContextResolver = () =>
        ({ "eve.session.id": "override", team: "platform" }) as never;
      const runtimeContext = build({
        providerResolvers: [resolver],
        stepStartedResolver: undefined,
      });

      expect(runtimeContext).toEqual({ ...FRAMEWORK_KEYS, team: "platform" });
    });

    it("continues when a provider resolver throws", () => {
      const failing: RuntimeContextResolver = () => {
        throw new Error("boom");
      };
      const healthy: RuntimeContextResolver = () => ({ team: "platform" });
      const runtimeContext = build({
        providerResolvers: [failing, healthy],
        stepStartedResolver: undefined,
      });

      expect(runtimeContext).toEqual({ ...FRAMEWORK_KEYS, team: "platform" });
    });

    it("returns undefined when no authored config and no provider resolvers", () => {
      expect(
        build({ providerResolvers: undefined, stepStartedResolver: undefined }),
      ).toBeUndefined();
      expect(build({ providerResolvers: [], stepStartedResolver: undefined })).toBeUndefined();
    });

    it("merges provider resolver results alongside the legacy step.started hook", () => {
      const resolver: RuntimeContextResolver = () => ({ source: "provider" });
      const runtimeContext = build({
        providerResolvers: [resolver],
        stepStartedResolver: () => ({ runtimeContext: { source: "legacy" } }),
      });

      expect(runtimeContext).toEqual({ ...FRAMEWORK_KEYS, source: "provider" });
    });
  });
});
