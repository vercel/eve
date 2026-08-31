import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSessionAttributes,
  buildSubagentRootAttributes,
  buildTurnAttributes,
  deriveSessionTitle,
  EVE_SESSION_TITLE_MAX_CHARS,
  isWorkflowTraceContentVisible,
  readChannelKind,
  readChannelRequestId,
  readParentLineage,
  readParentSessionId,
  readRootSessionId,
  readScheduleId,
  readSessionTraceId,
} from "#execution/eve-workflow-attributes.js";
import {
  ChannelInstrumentationKey,
  ChannelRequestIdKey,
  ForwardedTraceAudienceKey,
  ScheduleIdKey,
} from "#context/keys.js";
import { CHANNEL_CONTEXT_KEY_NAME } from "#context/key-names.js";
import { FORWARDED_AUDIENCE_SOURCE, FORWARDED_AUDIENCE_SOURCE_KEY } from "#protocol/baggage.js";

const slackChannelCtx = {
  "eve.channel": { kind: "slack", state: { team: "T1" }, audience: "public" },
} satisfies Record<string, unknown>;

const subagentChainCtx = {
  "eve.channel": { kind: "slack", state: {}, audience: "public" },
  "eve.parentSession": {
    callId: "call_subagent_0",
    sessionId: "wrun_parent_subagent",
    rootSessionId: "wrun_top_level_session",
    turn: { id: "turn_0", sequence: 0 },
  },
} satisfies Record<string, unknown>;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readChannelKind", () => {
  it("returns the channel kind when the slot is well-formed", () => {
    expect(readChannelKind(slackChannelCtx)).toBe("slack");
  });

  it("returns undefined when the slot is missing or malformed", () => {
    expect(readChannelKind({})).toBeUndefined();
    expect(readChannelKind({ "eve.channel": { kind: "" } })).toBeUndefined();
    expect(readChannelKind({ "eve.channel": { kind: 42 } })).toBeUndefined();
  });
});

describe("readScheduleId", () => {
  it("reads only a non-empty schedule name", () => {
    expect(readScheduleId({ [ScheduleIdKey.name]: "dynamic-tasks" })).toBe("dynamic-tasks");
    expect(readScheduleId({ [ScheduleIdKey.name]: "" })).toBeUndefined();
    expect(readScheduleId({ [ScheduleIdKey.name]: 42 })).toBeUndefined();
  });
});

describe("isWorkflowTraceContentVisible", () => {
  it("reads audience from the shared serialized channel slot", () => {
    expect(
      isWorkflowTraceContentVisible({
        [CHANNEL_CONTEXT_KEY_NAME]: { audience: "public", kind: "slack" },
      }),
    ).toBe(true);
  });

  it("prefers an accepted forwarded audience and exposes its audit source", () => {
    const serializedContext = {
      [CHANNEL_CONTEXT_KEY_NAME]: { audience: "unknown", kind: "http" },
      [ForwardedTraceAudienceKey.name]: "public",
      [ChannelInstrumentationKey.name]: {
        kind: "eve",
        metadata: {
          audience: "public",
          [FORWARDED_AUDIENCE_SOURCE_KEY]: FORWARDED_AUDIENCE_SOURCE,
        },
      },
    };

    expect(isWorkflowTraceContentVisible(serializedContext)).toBe(true);
    expect(buildSessionAttributes({ inputMessage: "research", serializedContext })).toMatchObject({
      "$eve.is_trace_content_visible": true,
      "$eve.trace_audience_source": "trusted_forwarder",
    });
  });

  it("does not infer forwarded acceptance from projected metadata", () => {
    const serializedContext = {
      [CHANNEL_CONTEXT_KEY_NAME]: { audience: "unknown", kind: "http" },
      [ChannelInstrumentationKey.name]: {
        kind: "eve",
        metadata: {
          audience: "public",
          [FORWARDED_AUDIENCE_SOURCE_KEY]: FORWARDED_AUDIENCE_SOURCE,
        },
      },
    };

    expect(isWorkflowTraceContentVisible(serializedContext)).toBe(false);
    expect(buildSessionAttributes({ inputMessage: "research", serializedContext })).toMatchObject({
      "$eve.is_trace_content_visible": false,
      "$eve.trace_audience_source": undefined,
    });
  });
});

describe("readParentSessionId", () => {
  it("returns the immediate parent's session id", () => {
    expect(readParentSessionId(subagentChainCtx)).toBe("wrun_parent_subagent");
  });

  it("returns undefined for top-level runs", () => {
    expect(readParentSessionId({})).toBeUndefined();
  });
});

describe("readParentLineage", () => {
  it("returns the parent session, call, turn, and root ids", () => {
    expect(readParentLineage(subagentChainCtx)).toEqual({
      callId: "call_subagent_0",
      rootSessionId: "wrun_top_level_session",
      sessionId: "wrun_parent_subagent",
      turnId: "turn_0",
    });
  });

  it("returns an empty object for top-level runs", () => {
    expect(readParentLineage({})).toEqual({});
  });
});

describe("readRootSessionId", () => {
  it("reads the denormalized rootSessionId the parent carries", () => {
    expect(readRootSessionId(subagentChainCtx)).toBe("wrun_top_level_session");
  });

  it("returns undefined for top-level runs", () => {
    expect(readRootSessionId({})).toBeUndefined();
  });

  it("returns undefined when a malformed parent omits the root", () => {
    expect(
      readRootSessionId({
        "eve.parentSession": {
          sessionId: "wrun_parent",
          turn: { id: "turn_0", sequence: 0 },
        },
      }),
    ).toBeUndefined();
  });
});

describe("readChannelRequestId", () => {
  it("returns the channel request id when the context slot is well-formed", () => {
    expect(
      readChannelRequestId({
        [ChannelRequestIdKey.name]: "req_123",
      }),
    ).toBe("req_123");
  });

  it("returns undefined when the slot is missing or malformed", () => {
    expect(readChannelRequestId({})).toBeUndefined();
    expect(readChannelRequestId({ [ChannelRequestIdKey.name]: "" })).toBeUndefined();
    expect(readChannelRequestId({ [ChannelRequestIdKey.name]: 42 })).toBeUndefined();
  });
});

describe("deriveSessionTitle", () => {
  it("collapses whitespace and trims plain string messages", () => {
    expect(deriveSessionTitle("  hello\n\nworld   ")).toBe("hello world");
  });

  it("joins the text parts of a multimodal UserContent array", () => {
    const message = [
      { type: "text", text: "look at" },
      { type: "image", image: "https://example.com/a.png" },
      { type: "text", text: "this" },
    ];
    expect(deriveSessionTitle(message)).toBe("look at this");
  });

  it("returns undefined when no plain-text content is available", () => {
    expect(deriveSessionTitle(undefined)).toBeUndefined();
    expect(deriveSessionTitle("")).toBeUndefined();
    expect(deriveSessionTitle([{ type: "image", image: "https://x" }])).toBeUndefined();
  });

  it("truncates long titles to the max code points with a trailing ellipsis", () => {
    const title = deriveSessionTitle("x".repeat(EVE_SESSION_TITLE_MAX_CHARS + 120));
    expect(title).toBeDefined();
    expect(Array.from(title!).length).toBe(EVE_SESSION_TITLE_MAX_CHARS);
    expect(title!.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair at the truncation boundary", () => {
    // (max - 1) leading chars + an emoji that would land on the last slot.
    const leading = "x".repeat(EVE_SESSION_TITLE_MAX_CHARS - 1);
    const title = deriveSessionTitle(`${leading}🚀tail`);
    expect(title).toBe(`${leading}…`);
  });
});

describe("buildSessionAttributes", () => {
  it("emits type=session with trigger and derived title", () => {
    const attrs = buildSessionAttributes({
      inputMessage: "ship the thing please",
      serializedContext: slackChannelCtx,
    });

    expect(attrs).toEqual({
      "$eve.channel_request_id": undefined,
      "$eve.is_otel_trace_enabled": false,
      "$eve.is_trace_content_visible": true,
      "$eve.schedule": undefined,
      "$eve.trace_id": undefined,
      "$eve.type": "session",
      "$eve.trigger": "slack",
      "$eve.title": "ship the thing please",
    });
  });

  it("marks unknown sessions denied while retaining their stored title", () => {
    const attrs = buildSessionAttributes({
      inputMessage: "hi",
      serializedContext: {},
    });

    expect(attrs["$eve.trigger"]).toBeUndefined();
    expect(attrs["$eve.is_trace_content_visible"]).toBe(false);
    expect(attrs["$eve.is_otel_trace_enabled"]).toBe(false);
    expect(attrs["$eve.title"]).toBe("hi");
  });

  it("stamps hosted OTEL enablement without suppressing the stored title", () => {
    const attrs = buildSessionAttributes({
      inputMessage: "private prompt",
      serializedContext: { "eve.otelTraceEnabled": true },
    });

    expect(attrs["$eve.is_otel_trace_enabled"]).toBe(true);
    expect(attrs["$eve.is_trace_content_visible"]).toBe(false);
    expect(attrs["$eve.title"]).toBe("private prompt");
  });

  it("allows unknown session content during local eve dev", () => {
    vi.stubEnv("EVE_DEV", "1");

    const attrs = buildSessionAttributes({
      inputMessage: "local prompt",
      serializedContext: {},
    });

    expect(attrs["$eve.is_trace_content_visible"]).toBe(true);
    expect(attrs["$eve.title"]).toBe("local prompt");
  });

  it("emits the channel request id when present", () => {
    const attrs = buildSessionAttributes({
      inputMessage: "hi",
      serializedContext: {
        ...slackChannelCtx,
        [ChannelRequestIdKey.name]: "req_session",
      },
    });

    expect(attrs["$eve.channel_request_id"]).toBe("req_session");
  });

  it("emits the schedule while retaining the target channel trigger", () => {
    const attrs = buildSessionAttributes({
      inputMessage: "run the scheduled task",
      serializedContext: {
        ...slackChannelCtx,
        [ScheduleIdKey.name]: "dynamic-tasks",
      },
    });

    expect(attrs["$eve.schedule"]).toBe("dynamic-tasks");
    expect(attrs["$eve.trigger"]).toBe("slack");
  });

  it("emits $eve.trace_id from a sampled trace seed", () => {
    const attrs = buildSessionAttributes({
      inputMessage: "hi",
      serializedContext: {
        ...slackChannelCtx,
        "eve.sessionTraceSeed": { spanId: "a".repeat(16), traceFlags: 1, traceId: "b".repeat(32) },
      },
    });

    expect(attrs["$eve.trace_id"]).toBe("b".repeat(32));
  });

  it("withholds $eve.trace_id from an unsampled trace seed", () => {
    const attrs = buildSessionAttributes({
      inputMessage: "hi",
      serializedContext: {
        ...slackChannelCtx,
        "eve.sessionTraceSeed": { spanId: "a".repeat(16), traceFlags: 0, traceId: "b".repeat(32) },
      },
    });

    expect(attrs["$eve.trace_id"]).toBeUndefined();
  });
});

describe("buildSubagentRootAttributes", () => {
  it("emits type=subagent with parent, root session, subagent node, and trigger", () => {
    const attrs = buildSubagentRootAttributes({
      identity: { nodeId: "subagents/linear" },
      parentCallId: "call_subagent_0",
      parentSessionId: "wrun_parent_subagent",
      parentTurnId: "turn_0",
      rootSessionId: "wrun_top_level_session",
      serializedContext: subagentChainCtx,
    });

    expect(attrs).toEqual({
      "$eve.channel_request_id": undefined,
      "$eve.is_otel_trace_enabled": false,
      "$eve.is_trace_content_visible": true,
      "$eve.trace_id": undefined,
      "$eve.type": "subagent",
      "$eve.parent": "wrun_parent_subagent",
      "$eve.parent_call": "call_subagent_0",
      "$eve.parent_turn": "turn_0",
      "$eve.root": "wrun_top_level_session",
      "$eve.subagent": "subagents/linear",
      "$eve.trigger": "slack",
    });
  });

  it("emits the channel request id when present", () => {
    const attrs = buildSubagentRootAttributes({
      identity: { nodeId: "subagents/linear" },
      parentSessionId: "wrun_parent_subagent",
      rootSessionId: "wrun_top_level_session",
      serializedContext: {
        ...subagentChainCtx,
        [ChannelRequestIdKey.name]: "req_subagent",
      },
    });

    expect(attrs["$eve.channel_request_id"]).toBe("req_subagent");
  });

  it("emits $eve.trace_id from a sampled trace seed", () => {
    const attrs = buildSubagentRootAttributes({
      identity: { nodeId: "subagents/linear" },
      parentCallId: "call_subagent_0",
      parentSessionId: "wrun_parent_subagent",
      parentTurnId: "turn_0",
      rootSessionId: "wrun_top_level_session",
      serializedContext: {
        ...subagentChainCtx,
        "eve.sessionTraceSeed": { spanId: "e".repeat(16), traceFlags: 1, traceId: "f".repeat(32) },
      },
    });

    expect(attrs["$eve.trace_id"]).toBe("f".repeat(32));
  });
});

describe("buildTurnAttributes", () => {
  it("emits type=turn with parent and root session", () => {
    const attrs = buildTurnAttributes({
      parentSessionId: "wrun_session_123",
      rootSessionId: "wrun_session_123",
      serializedContext: slackChannelCtx,
    });

    expect(attrs).toEqual({
      "$eve.channel_request_id": undefined,
      "$eve.is_otel_trace_enabled": false,
      "$eve.is_trace_content_visible": true,
      "$eve.trace_id": undefined,
      "$eve.type": "turn",
      "$eve.parent": "wrun_session_123",
      "$eve.root": "wrun_session_123",
    });
  });

  it("emits the channel request id when present", () => {
    const attrs = buildTurnAttributes({
      parentSessionId: "wrun_session_123",
      requestId: "req_turn",
      rootSessionId: "wrun_session_123",
      serializedContext: slackChannelCtx,
    });

    expect(attrs["$eve.channel_request_id"]).toBe("req_turn");
  });

  it("emits $eve.trace_id from a sampled trace seed", () => {
    const attrs = buildTurnAttributes({
      parentSessionId: "wrun_session_123",
      rootSessionId: "wrun_session_123",
      serializedContext: {
        ...slackChannelCtx,
        "eve.sessionTraceSeed": { spanId: "c".repeat(16), traceFlags: 1, traceId: "d".repeat(32) },
      },
    });

    expect(attrs["$eve.trace_id"]).toBe("d".repeat(32));
  });
});

describe("readSessionTraceId", () => {
  it("returns the trace id from a sampled seed", () => {
    expect(
      readSessionTraceId({
        "eve.sessionTraceSeed": { spanId: "a".repeat(16), traceFlags: 1, traceId: "b".repeat(32) },
      }),
    ).toBe("b".repeat(32));
  });

  it("returns undefined for an unsampled seed", () => {
    expect(
      readSessionTraceId({
        "eve.sessionTraceSeed": { spanId: "a".repeat(16), traceFlags: 0, traceId: "b".repeat(32) },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when no seed is present", () => {
    expect(readSessionTraceId({})).toBeUndefined();
  });
});
