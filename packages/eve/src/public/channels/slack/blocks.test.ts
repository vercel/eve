import { describe, expect, it } from "vitest";

import {
  Actions,
  Button,
  Card,
  CardText,
  Divider,
  Fields,
  LinkButton,
  Select,
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
            text: { type: "plain_text", text: "Approve", emoji: true },
            style: "primary",
          },
          {
            type: "button",
            action_id: "deny",
            text: { type: "plain_text", text: "Deny", emoji: true },
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
        children: [
          Actions([
            LinkButton({ url: "https://example.com/docs", label: "View docs" }),
            LinkButton({
              id: "account",
              url: "https://example.com/account",
              label: "Account",
            }),
          ]),
        ],
      }),
    );
    expect(blocks[0]).toEqual({
      elements: [
        {
          action_id: "link:https://example.com/docs",
          text: { emoji: true, text: "View docs", type: "plain_text" },
          type: "button",
          url: "https://example.com/docs",
        },
        {
          action_id: "account",
          text: { emoji: true, text: "Account", type: "plain_text" },
          type: "button",
          url: "https://example.com/account",
        },
      ],
      type: "actions",
    });
  });

  it("preserves a selected option", () => {
    const blocks = cardToBlocks(
      Card({
        children: [
          Actions([
            Select({
              id: "priority",
              initialOption: "high",
              label: "Priority",
              options: [
                { label: "Low", value: "low" },
                { label: "High", value: "high" },
              ],
            }),
          ]),
        ],
      }),
    );
    expect(blocks[0]).toMatchObject({
      elements: [
        {
          initial_option: {
            text: { text: "High", type: "plain_text" },
            value: "high",
          },
        },
      ],
    });
  });

  it("limits the number of blocks", () => {
    const blocks = cardToBlocks(
      Card({ children: Array.from({ length: 60 }, (_, index) => CardText(`item ${index}`)) }),
    );
    expect(blocks).toHaveLength(50);
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
    expect(text).toBe("Heading\nCaption\nBody content");
  });
});
