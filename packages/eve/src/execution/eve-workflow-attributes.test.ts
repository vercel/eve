import { describe, expect, it } from "vitest";

import {
  buildSessionAttributes,
  buildSubagentRootAttributes,
  buildTurnAttributes,
  deriveSessionTitle,
  EVE_SESSION_TITLE_MAX_CHARS,
  readChannelKind,
  readChannelRequestId,
  readParentLineage,
  readParentSessionId,
  readRootSessionId,
} from "#execution/eve-workflow-attributes.js";
import { ChannelRequestIdKey } from "#context/keys.js";

const slackChannelCtx = {
  "eve.channel": { kind: "slack", state: { team: "T1" } },
} satisfies Record<string, unknown>;

const subagentChainCtx = {
  "eve.channel": { kind: "slack", state: {} },
  "eve.parentSession": {
    callId: "call_subagent_0",
    sessionId: "wrun_parent_subagent",
    rootSessionId: "wrun_top_level_session",
    turn: { id: "turn_0", sequence: 0 },
  },
} satisfies Record<string, unknown>;

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
      "$eve.type": "session",
      "$eve.trigger": "slack",
      "$eve.title": "ship the thing please",
    });
  });

  it("omits the trigger when no channel is on the context", () => {
    const attrs = buildSessionAttributes({
      inputMessage: "hi",
      serializedContext: {},
    });

    expect(attrs["$eve.trigger"]).toBeUndefined();
    expect(attrs["$eve.title"]).toBe("hi");
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
});

describe("buildTurnAttributes", () => {
  it("emits type=turn with parent and root session", () => {
    const attrs = buildTurnAttributes({
      parentSessionId: "wrun_session_123",
      rootSessionId: "wrun_session_123",
    });

    expect(attrs).toEqual({
      "$eve.channel_request_id": undefined,
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
    });

    expect(attrs["$eve.channel_request_id"]).toBe("req_turn");
  });
});
