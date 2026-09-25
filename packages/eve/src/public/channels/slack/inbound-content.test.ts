import { describe, expect, it } from "vitest";

import {
  projectSlackInboundContent,
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

    expect(result).toContain("see <https://example.com|the docs>:rocket:");
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

  it("uses fallback per attachment even when earlier attachments already contributed content", () => {
    const result = resolveSlackInboundMrkdwn("", {
      attachments: [
        { title: "First alert", text: "Latency is high" },
        { fallback: "Second alert: deploy blocked" },
      ],
    });

    expect(result).toBe("First alert\nLatency is high\nSecond alert: deploy blocked");
  });

  it("does not duplicate fallback when nested attachment blocks carry the content", () => {
    const result = resolveSlackInboundMrkdwn("", {
      attachments: [
        {
          fallback: "Alert: latency high",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Alert:* latency high" } }],
        },
      ],
    });

    expect(result).toBe("*Alert:* latency high");
  });

  it("preserves rich_text link labels and URLs as mrkdwn links", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "See " },
                { type: "link", text: "incident dashboard", url: "https://example.com/incident" },
              ],
            },
          ],
        },
      ],
    });

    expect(result).toBe("See <https://example.com/incident|incident dashboard>");
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

  it("extracts shared Slack messages from message unfurl attachments", () => {
    const result = resolveSlackInboundMrkdwn(":crosspost:", {
      attachments: [
        {
          from_url: "https://example.slack.com/archives/C_SOURCE/p1700000000000100",
          is_msg_unfurl: true,
          message_blocks: [
            {
              channel: "C_SOURCE",
              message: {
                blocks: [
                  {
                    type: "rich_text",
                    elements: [
                      {
                        type: "rich_text_section",
                        elements: [
                          {
                            type: "text",
                            text: "I can't find deployment protection or agent runs in the new sidebar.",
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              team: "T_SOURCE",
              ts: "1700000000.000100",
            },
          ],
        },
      ],
    });

    expect(result).toBe(
      ":crosspost:\nI can't find deployment protection or agent runs in the new sidebar.",
    );
  });

  it("projects all visible unfurl fields through one provenance boundary", () => {
    const result = projectSlackInboundContent("investigate", {
      attachments: [
        {
          service_name: "Deploys",
          pretext: "Production alert",
          fields: [{ title: "Status", value: "Failed" }],
          footer: "Open dashboard",
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: "Rollback required" },
            },
          ],
        },
      ],
    });

    expect(result.text).toContain("Production alert");
    expect(result.modelText).toBe("investigate");
    expect(result.unfurls).toEqual([
      {
        content: "Production alert\nStatus: Failed\nOpen dashboard\nRollback required",
        source: "Deploys link preview",
      },
    ]);
  });

  it("keeps classic attachment content in model text", () => {
    const result = projectSlackInboundContent("", {
      attachments: [{ fields: [{ title: "Status", value: "Complete" }] }],
    });

    expect(result.text).toBe("Status: Complete");
    expect(result.modelText).toBe("Status: Complete");
    expect(result.unfurls).toEqual([]);
  });

  it("falls back to shared Slack message text when its blocks are absent", () => {
    const result = resolveSlackInboundMrkdwn("", {
      attachments: [
        {
          is_msg_unfurl: true,
          message_blocks: [{ message: { text: "Forwarded feedback" } }],
        },
      ],
    });

    expect(result).toBe("Forwarded feedback");
  });

  it("keeps a top-level comment alongside a shorter shared Slack message", () => {
    const result = resolveSlackInboundMrkdwn(
      "This seems related to the navigation feedback we discussed yesterday.",
      {
        attachments: [
          {
            is_msg_unfurl: true,
            message_blocks: [{ message: { text: "Agent runs are missing." } }],
          },
        ],
      },
    );

    expect(result).toBe(
      "This seems related to the navigation feedback we discussed yesterday.\nAgent runs are missing.",
    );
  });

  it.each(["is_share", "is_msg_unfurl", "is_reply_unfurl"])(
    "keeps short shared-message content alongside a longer human comment for %s attachments",
    (sharedMessageFlag) => {
      const result = resolveSlackInboundMrkdwn("<@U123> :eyes:", {
        attachments: [
          {
            [sharedMessageFlag]: true,
            text: "Ship it",
            from_url: "https://example.slack.com/archives/C123/p1234567890000100",
          },
        ],
      });

      expect(result).toBe("<@U123> :eyes:\nShip it");
    },
  );

  it("does not repeat shared-message content already present in the human comment", () => {
    const result = resolveSlackInboundMrkdwn("Please review: Ship it", {
      attachments: [{ is_share: true, text: "Ship it" }],
    });

    expect(result).toBe("Please review: Ship it");
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

  it("does not throw when a rich_text link URL contains Slack control characters", () => {
    expect(() =>
      resolveSlackInboundMrkdwn("", {
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "link", url: "https://example.com/?q=a|b", text: "incident link" },
                ],
              },
            ],
          },
        ],
      }),
    ).not.toThrow();

    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "link", url: "https://example.com/?q=a|b", text: "incident link" },
              ],
            },
          ],
        },
      ],
    });

    expect(result).toBe("incident link (https://example.com/?q=a|b)");
  });

  it("formats safe rich_text links as Slack mrkdwn tokens", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "link", url: "https://example.com", text: "docs" }],
            },
          ],
        },
      ],
    });

    expect(result).toBe("<https://example.com|docs>");
  });

  it("returns top-level text when block extraction throws", () => {
    const badBlock: Record<string, unknown> = {};
    Object.defineProperty(badBlock, "type", {
      get() {
        throw new Error("boom");
      },
    });

    expect(
      resolveSlackInboundMrkdwn("keep this comment", {
        blocks: [badBlock],
      }),
    ).toBe("keep this comment");
  });

  it("keeps a human comment when legacy attachment content is much longer", () => {
    const result = resolveSlackInboundMrkdwn("this is the bug we saw yesterday", {
      attachments: [
        {
          is_share: true,
          text: "Deploy 142 failed in us-east-1 because the health check never recovered. See the incident doc for rollback steps.",
        },
      ],
    });

    expect(result).toContain("this is the bug we saw yesterday");
    expect(result).toContain("Deploy 142 failed");
  });

  it("prefers extracted block content when whitespace differs from top-level text", () => {
    const result = resolveSlackInboundMrkdwn("Alert: latency high\nin checkout region now", {
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Alert: latency high in checkout region now" },
        },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "Acknowledge" }, action_id: "ack" },
          ],
        },
      ],
    });

    expect(result).toContain("Alert: latency high in checkout region now");
    expect(result).toContain("[Acknowledge]");
  });

  it("extracts section accessory button labels as bracketed controls", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Approve this deploy?" },
          accessory: {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            action_id: "approve",
          },
        },
      ],
    });

    expect(result).toBe("Approve this deploy?\n[Approve]");
  });

  it("extracts image alt_text from context block elements", () => {
    const result = resolveSlackInboundMrkdwn("", {
      blocks: [
        {
          type: "context",
          elements: [
            { type: "image", image_url: "https://example.com/graph.png", alt_text: "error graph" },
            { type: "mrkdwn", text: "opened 5m ago" },
          ],
        },
      ],
    });

    expect(result).toBe("error graph\nopened 5m ago");
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
