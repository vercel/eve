import { describe, expect, it } from "vitest";

import {
  Actions,
  Button,
  Card,
  CardText,
  Divider,
  Fields,
  LinkButton,
  Section,
  Table,
  Field,
  Image,
} from "#compiled/chat/index.js";

import { cardToBlocks, cardToFallbackText } from "#public/channels/slack/blocks.js";

describe("cardToBlocks", () => {
  it("renders title and subtitle as header + context blocks", () => {
    const blocks = cardToBlocks(
      Card({ title: "Order #1234", subtitle: "Ready for pickup", children: [] }),
    );
    expect(blocks).toEqual([
      { type: "header", text: { type: "plain_text", text: "Order #1234", emoji: true } },
      { type: "context", elements: [{ type: "mrkdwn", text: "Ready for pickup" }] },
    ]);
  });

  it("converts plain, bold, and muted text children", () => {
    const blocks = cardToBlocks(
      Card({
        children: [
          CardText("Hello"),
          CardText("Important", { style: "bold" }),
          CardText("hint", { style: "muted" }),
        ],
      }),
    );
    expect(blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Hello" } },
      { type: "section", text: { type: "mrkdwn", text: "*Important*" } },
      { type: "context", elements: [{ type: "mrkdwn", text: "hint" }] },
    ]);
  });

  it("converts an actions block with primary and danger buttons", () => {
    const blocks = cardToBlocks(
      Card({
        children: [
          Actions([
            Button({ id: "approve", label: "Approve", style: "primary" }),
            Button({ id: "deny", label: "Deny", style: "danger", value: "force" }),
          ]),
        ],
      }),
    );
    expect(blocks).toEqual([
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "approve",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
          },
          {
            type: "button",
            action_id: "deny",
            text: { type: "plain_text", text: "Deny" },
            value: "force",
            style: "danger",
          },
        ],
      },
    ]);
  });

  it("converts link buttons with a synthetic action_id and url", () => {
    const blocks = cardToBlocks(
      Card({
        children: [Actions([LinkButton({ url: "https://example.com/docs", label: "View docs" })])],
      }),
    );
    const actions = blocks[0] as { elements: Array<Record<string, unknown>> };
    expect(actions.elements[0]).toEqual({
      type: "button",
      action_id: "link:https://example.com/docs",
      text: { type: "plain_text", text: "View docs" },
      url: "https://example.com/docs",
    });
  });

  it("converts divider, image, and fields children", () => {
    const blocks = cardToBlocks(
      Card({
        children: [
          Divider(),
          Image({ url: "https://example.com/cat.png", alt: "cat" }),
          Fields([
            Field({ label: "Name", value: "Alice" }),
            Field({ label: "Role", value: "Engineer" }),
          ]),
        ],
      }),
    );
    expect(blocks[0]).toEqual({ type: "divider" });
    expect(blocks[1]).toEqual({
      type: "image",
      image_url: "https://example.com/cat.png",
      alt_text: "cat",
    });
    expect(blocks[2]).toEqual({
      type: "section",
      fields: [
        { type: "mrkdwn", text: "*Name*\nAlice" },
        { type: "mrkdwn", text: "*Role*\nEngineer" },
      ],
    });
  });

  it("flattens a Section's children into the surrounding block sequence", () => {
    const blocks = cardToBlocks(
      Card({
        children: [Section([CardText("inner"), Divider()])],
      }),
    );
    expect(blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "inner" } },
      { type: "divider" },
    ]);
  });

  it("renders the first Table as a native Slack table block", () => {
    const blocks = cardToBlocks(
      Card({
        children: [
          Table({
            headers: ["Name", "Role"],
            rows: [
              ["Alice", "Engineer"],
              ["Bob", "Designer"],
            ],
          }),
        ],
      }),
    );
    expect(blocks[0]).toEqual({
      type: "table",
      rows: [
        [
          { type: "raw_text", text: "Name" },
          { type: "raw_text", text: "Role" },
        ],
        [
          { type: "raw_text", text: "Alice" },
          { type: "raw_text", text: "Engineer" },
        ],
        [
          { type: "raw_text", text: "Bob" },
          { type: "raw_text", text: "Designer" },
        ],
      ],
    });
  });

  it("falls back to fixed-width mrkdwn for additional tables", () => {
    const blocks = cardToBlocks(
      Card({
        children: [
          Table({ headers: ["A"], rows: [["1"]] }),
          Table({ headers: ["B"], rows: [["2"]] }),
        ],
      }),
    );
    expect(blocks[0]?.type).toBe("table");
    const section = blocks[1] as { type: string; text: { text: string } };
    expect(section.type).toBe("section");
    expect(section.text.text).toContain("```");
    expect(section.text.text).toContain("B");
  });
});

describe("cardToFallbackText", () => {
  it("joins title, subtitle, and child fallback text", () => {
    const text = cardToFallbackText(
      Card({
        title: "Heading",
        subtitle: "Caption",
        children: [CardText("Body content"), Divider()],
      }),
    );
    expect(text).toContain("Heading");
    expect(text).toContain("Caption");
    expect(text).toContain("Body content");
  });
});
