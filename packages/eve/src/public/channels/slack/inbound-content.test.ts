import { describe, expect, it } from "vitest";

import {
  readSlackTextObject,
  resolveSlackInboundMrkdwn,
} from "#public/channels/slack/inbound-content.js";

describe("resolveSlackInboundMrkdwn", () => {
  it("returns the top-level text unchanged when there are no blocks or attachments", () => {
    expect(resolveSlackInboundMrkdwn("hello bot", {})).toBe("hello bot");
  });

  it("returns empty for an empty event", () => {
    expect(resolveSlackInboundMrkdwn("", {})).toBe("");
  });

  it("extracts section text and fields when text is empty", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "*Alert:* latency is high" } },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: "Status: Firing" },
            { type: "mrkdwn", text: "Region: us-east-1" },
          ],
        },
      ],
    });

    expect(result).toBe("*Alert:* latency is high\nStatus: Firing\nRegion: us-east-1");
  });

  it("extracts header, context, and image blocks", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Incident INC-42" } },
        { type: "context", elements: [{ type: "mrkdwn", text: "opened 5m ago" }] },
        { type: "image", alt_text: "latency graph", title: { type: "plain_text", text: "p99" } },
      ],
    });

    expect(result).toBe("Incident INC-42\nopened 5m ago\nlatency graph\np99");
  });

  it("renders actions block button labels as bracketed controls", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Approve this deploy?" } },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "Approve" }, action_id: "a" },
            { type: "button", text: { type: "plain_text", text: "Reject" }, action_id: "r" },
          ],
        },
      ],
    });

    expect(result).toBe("Approve this deploy?\n[Approve] [Reject]");
  });

  it("skips actions elements without a text label", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        {
          type: "actions",
          elements: [
            { type: "static_select", placeholder: { type: "plain_text", text: "Pick one" } },
            { type: "button", text: { type: "plain_text", text: "Go" }, action_id: "g" },
          ],
        },
      ],
    });

    expect(result).toBe("[Go]");
  });

  it("flattens rich_text sections, links, emoji, and lists", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "see " },
                { type: "link", url: "https://example.com", text: "the docs" },
                { type: "emoji", name: "rocket" },
              ],
            },
            {
              type: "rich_text_list",
              elements: [
                { type: "rich_text_section", elements: [{ type: "text", text: "one" }] },
                { type: "rich_text_section", elements: [{ type: "text", text: "two" }] },
              ],
            },
          ],
        },
      ],
    });

    expect(result).toContain("see the docs:rocket:");
    expect(result).toContain("one\ntwo");
  });

  it("extracts markdown blocks as raw markdown", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [{ type: "markdown", text: "## Summary\n- latency is **high**" }],
    });

    expect(result).toBe("## Summary\n- latency is **high**");
  });

  it("extracts video block title and description", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        {
          type: "video",
          alt_text: "walkthrough",
          title: { type: "plain_text", text: "Deploy walkthrough" },
          description: { type: "plain_text", text: "How the rollout works" },
          video_url: "https://example.com/embed",
        },
      ],
    });

    expect(result).toBe("Deploy walkthrough\nHow the rollout works");
  });

  it("extracts table rows with mixed cell types", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        {
          type: "table",
          rows: [
            [
              { type: "raw_text", text: "Service" },
              { type: "raw_text", text: "Errors" },
            ],
            [
              {
                type: "rich_text",
                elements: [
                  { type: "rich_text_section", elements: [{ type: "text", text: "api" }] },
                ],
              },
              { type: "raw_number", value: 42 },
            ],
          ],
        },
      ],
    });

    expect(result).toBe("Service | Errors\napi | 42");
  });

  it("extracts data_table caption and rows", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        {
          type: "data_table",
          caption: { type: "plain_text", text: "Error budget" },
          rows: [
            [
              { type: "raw_text", text: "api" },
              { type: "raw_text", text: "97%" },
            ],
          ],
        },
      ],
    });

    expect(result).toBe("Error budget\napi | 97%");
  });

  it("renders rich_text mentions as mrkdwn tokens", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "cc " },
                { type: "user", user_id: "U123" },
                { type: "text", text: " in " },
                { type: "channel", channel_id: "C456" },
                { type: "text", text: " " },
                { type: "broadcast", range: "here" },
                { type: "text", text: " due " },
                { type: "date", timestamp: 1700000000, fallback: "Nov 14th" },
              ],
            },
          ],
        },
      ],
    });

    expect(result).toBe("cc <@U123> in <#C456> <!here> due Nov 14th");
  });

  it("extracts card title, subtitle, body, subtext, and action labels", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        {
          type: "card",
          title: { type: "mrkdwn", text: "INC-42" },
          subtitle: { type: "plain_text", text: "Sev-2" },
          body: { type: "mrkdwn", text: "Latency regression in checkout" },
          subtext: { type: "plain_text", text: "Opened 5m ago" },
          actions: [{ type: "button", text: { type: "plain_text", text: "Acknowledge" } }],
        },
      ],
    });

    expect(result).toBe(
      "INC-42\nSev-2\nLatency regression in checkout\nOpened 5m ago\n[Acknowledge]",
    );
  });

  it("extracts every card in a carousel", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        {
          type: "carousel",
          elements: [
            { type: "card", title: { type: "mrkdwn", text: "Option A" } },
            { type: "card", title: { type: "mrkdwn", text: "Option B" } },
          ],
        },
      ],
    });

    expect(result).toBe("Option A\nOption B");
  });

  it("extracts container title and recurses into child blocks", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        {
          type: "container",
          title: { type: "plain_text", text: "Bulk update" },
          subtitle: { type: "mrkdwn", text: "3 records changed" },
          child_blocks: [
            { type: "section", text: { type: "mrkdwn", text: "api: deployed" } },
            {
              type: "table",
              rows: [
                [
                  { type: "raw_text", text: "web" },
                  { type: "raw_text", text: "pending" },
                ],
              ],
            },
          ],
        },
      ],
    });

    expect(result).toBe("Bulk update\n3 records changed\napi: deployed\nweb | pending");
  });

  it("extracts legacy attachment pretext, title, text, fields, and footer", () => {
    const result = resolveSlackInboundMrkdwn("", {
      attachments: [
        {
          pretext: "Heads up",
          title: "Deploy failed",
          text: "The production deploy did not finish.",
          fields: [
            { title: "Service", value: "api", short: true },
            { title: "", value: "orphan value" },
            { title: "orphan title", value: "" },
          ],
          footer: "CI Bot",
        },
      ],
    });

    expect(result).toBe(
      [
        "Heads up",
        "Deploy failed",
        "The production deploy did not finish.",
        "Service: api",
        "orphan value",
        "orphan title",
        "CI Bot",
      ].join("\n"),
    );
  });

  it("falls back to the attachment fallback string when nothing else is present", () => {
    const result = resolveSlackInboundMrkdwn("", {
      attachments: [{ fallback: "Deploy failed: see dashboard" }],
    });

    expect(result).toBe("Deploy failed: see dashboard");
  });

  it("extracts Block Kit nested inside legacy attachments", () => {
    const result = resolveSlackInboundMrkdwn("", {
      attachments: [
        {
          color: "#ff0000",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "nested body" } }],
        },
      ],
    });

    expect(result).toBe("nested body");
  });

  it("keeps top-level text when rich_text blocks mirror it", () => {
    const result = resolveSlackInboundMrkdwn("Status update", {
      blocks: [
        {
          type: "rich_text",
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: "Status update" }] },
          ],
        },
      ],
    });

    expect(result).toBe("Status update");
  });

  it("prefers extracted content that contains the short top-level fallback", () => {
    const result = resolveSlackInboundMrkdwn("Alert", {
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Alert latency is high in us-east-1" } },
      ],
    });

    expect(result).toBe("Alert latency is high in us-east-1");
  });

  it("prefers extracted content that dwarfs the top-level text", () => {
    const result = resolveSlackInboundMrkdwn("New alert", {
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Service latency exceeded the p99 threshold" },
        },
      ],
    });

    expect(result).toBe("Service latency exceeded the p99 threshold");
  });

  it("keeps top-level text when extraction is comparable but different", () => {
    const result = resolveSlackInboundMrkdwn("The canonical body", {
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "A short aside" } }],
    });

    expect(result).toBe("The canonical body");
  });

  it("ignores divider and unknown block types", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        { type: "divider" },
        { type: "some_future_block", text: { type: "mrkdwn", text: "unknown" } },
        "not-an-object",
      ],
    });

    expect(result).toBe("");
  });

  it("ignores malformed blocks and attachments containers", () => {
    expect(resolveSlackInboundMrkdwn("", { blocks: "nope", attachments: 42 })).toBe("");
  });
});

describe("readSlackTextObject", () => {
  it("reads the text string from a composition object", () => {
    expect(readSlackTextObject({ type: "mrkdwn", text: "hello" })).toBe("hello");
  });

  it("returns empty for non-objects and missing text", () => {
    expect(readSlackTextObject(undefined)).toBe("");
    expect(readSlackTextObject("hello")).toBe("");
    expect(readSlackTextObject({ type: "mrkdwn" })).toBe("");
    expect(readSlackTextObject({ text: 42 })).toBe("");
  });
});
