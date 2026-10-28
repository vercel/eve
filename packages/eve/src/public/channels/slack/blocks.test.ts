import { describe, expect, expectTypeOf, it } from "vitest";

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
  TextInput,
} from "#public/channels/slack/cards.js";
import type * as Owned from "#public/channels/slack/cards.js";
import type * as Sdk from "#compiled/chat/index.js";

import { cardToBlocks, cardToFallbackText } from "#public/channels/slack/blocks.js";

describe("cardToBlocks", () => {
  it("keeps owned card data and props aligned with the SDK boundary", () => {
    expectTypeOf<Owned.ActionsElement>().toEqualTypeOf<Sdk.ActionsElement>();
    expectTypeOf<Owned.ButtonElement>().toEqualTypeOf<Sdk.ButtonElement>();
    expectTypeOf<Owned.ButtonOptions>().toEqualTypeOf<Sdk.ButtonOptions>();
    expectTypeOf<Owned.ButtonProps>().toEqualTypeOf<Sdk.ButtonProps>();
    expectTypeOf<Owned.ButtonStyle>().toEqualTypeOf<Sdk.ButtonStyle>();
    expectTypeOf<Owned.CardChild>().toEqualTypeOf<Sdk.CardChild>();
    expectTypeOf<Owned.CardElement>().toEqualTypeOf<Sdk.CardElement>();
    expectTypeOf<Owned.CardJSXProps>().toEqualTypeOf<Sdk.CardJSXProps>();
    expectTypeOf<Owned.CardLinkProps>().toEqualTypeOf<Sdk.CardLinkProps>();
    expectTypeOf<Owned.CardOptions>().toEqualTypeOf<Sdk.CardOptions>();
    expectTypeOf<Owned.CardProps>().toEqualTypeOf<Sdk.CardProps>();
    expectTypeOf<Owned.ContainerProps>().toEqualTypeOf<Sdk.ContainerProps>();
    expectTypeOf<Owned.DividerElement>().toEqualTypeOf<Sdk.DividerElement>();
    expectTypeOf<Owned.DividerProps>().toEqualTypeOf<Sdk.DividerProps>();
    expectTypeOf<Owned.ExternalSelectElement>().toEqualTypeOf<Sdk.ExternalSelectElement>();
    expectTypeOf<Owned.ExternalSelectOptions>().toEqualTypeOf<Sdk.ExternalSelectOptions>();
    expectTypeOf<Owned.ExternalSelectProps>().toEqualTypeOf<Sdk.ExternalSelectProps>();
    expectTypeOf<Owned.FieldElement>().toEqualTypeOf<Sdk.FieldElement>();
    expectTypeOf<Owned.FieldProps>().toEqualTypeOf<Sdk.FieldProps>();
    expectTypeOf<Owned.FieldsElement>().toEqualTypeOf<Sdk.FieldsElement>();
    expectTypeOf<Owned.ImageElement>().toEqualTypeOf<Sdk.ImageElement>();
    expectTypeOf<Owned.ImageProps>().toEqualTypeOf<Sdk.ImageProps>();
    expectTypeOf<Owned.LinkButtonElement>().toEqualTypeOf<Sdk.LinkButtonElement>();
    expectTypeOf<Owned.LinkButtonOptions>().toEqualTypeOf<Sdk.LinkButtonOptions>();
    expectTypeOf<Owned.LinkButtonProps>().toEqualTypeOf<Sdk.LinkButtonProps>();
    expectTypeOf<Owned.LinkElement>().toEqualTypeOf<Sdk.LinkElement>();
    expectTypeOf<Owned.ModalChild>().toEqualTypeOf<Sdk.ModalChild>();
    expectTypeOf<Owned.ModalElement>().toEqualTypeOf<Sdk.ModalElement>();
    expectTypeOf<Owned.ModalOptions>().toEqualTypeOf<Sdk.ModalOptions>();
    expectTypeOf<Owned.ModalProps>().toEqualTypeOf<Sdk.ModalProps>();
    expectTypeOf<Owned.RadioSelectElement>().toEqualTypeOf<Sdk.RadioSelectElement>();
    expectTypeOf<Owned.RadioSelectOptions>().toEqualTypeOf<Sdk.RadioSelectOptions>();
    expectTypeOf<Owned.SectionElement>().toEqualTypeOf<Sdk.SectionElement>();
    expectTypeOf<Owned.SelectElement>().toEqualTypeOf<Sdk.SelectElement>();
    expectTypeOf<Owned.SelectOptionElement>().toEqualTypeOf<Sdk.SelectOptionElement>();
    expectTypeOf<Owned.SelectOptionProps>().toEqualTypeOf<Sdk.SelectOptionProps>();
    expectTypeOf<Owned.SelectOptions>().toEqualTypeOf<Sdk.SelectOptions>();
    expectTypeOf<Owned.SelectProps>().toEqualTypeOf<Sdk.SelectProps>();
    expectTypeOf<Owned.TableAlignment>().toEqualTypeOf<Sdk.TableAlignment>();
    expectTypeOf<Owned.TableElement>().toEqualTypeOf<Sdk.TableElement>();
    expectTypeOf<Owned.TableOptions>().toEqualTypeOf<Sdk.TableOptions>();
    expectTypeOf<Owned.TextElement>().toEqualTypeOf<Sdk.TextElement>();
    expectTypeOf<Owned.TextInputElement>().toEqualTypeOf<Sdk.TextInputElement>();
    expectTypeOf<Owned.TextInputOptions>().toEqualTypeOf<Sdk.TextInputOptions>();
    expectTypeOf<Owned.TextInputProps>().toEqualTypeOf<Sdk.TextInputProps>();
    expectTypeOf<Owned.TextProps>().toEqualTypeOf<Sdk.TextProps>();
    expectTypeOf<Owned.TextStyle>().toEqualTypeOf<Sdk.TextStyle>();
  });

  it("renders a text input as its label, like the Slack adapter", () => {
    const blocks = cardToBlocks(
      Card({ children: [Section([TextInput({ id: "reason", label: "Reason" })])] }),
    );
    expect(blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: "Reason" } }]);
  });

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
            Button({ id: "cancel", label: "Cancel", style: "danger", value: "force" }),
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
            action_id: "cancel",
            text: { type: "plain_text", text: "Cancel", emoji: true },
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

  it("renders the first Table as a native Slack data table block", () => {
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
      type: "data_table",
      caption: "Table",
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
    expect(blocks[0]?.type).toBe("data_table");
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
