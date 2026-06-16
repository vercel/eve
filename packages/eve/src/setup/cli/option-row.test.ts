import { describe, expect, test } from "vitest";

import {
  renderOptionRow,
  resolveOptionRowState,
  UNICODE_ROW_GLYPHS,
  type OptionRowState,
  type RowColors,
} from "./option-row.js";

const colors: RowColors = {
  dim: (text) => `<dim>${text}</dim>`,
  green: (text) => `<green>${text}</green>`,
  cyan: (text) => `<cyan>${text}</cyan>`,
  yellow: (text) => `<yellow>${text}</yellow>`,
};

const glyphs = UNICODE_ROW_GLYPHS;

function row(
  input: Partial<Omit<Parameters<typeof renderOptionRow>[0], "state">> & {
    label: string;
    state?: OptionRowState;
  },
): string {
  return renderOptionRow({
    colors,
    glyphs,
    isCursor: false,
    state: { kind: "available", checked: false },
    placeholder: false,
    ...input,
  });
}

describe("renderOptionRow", () => {
  test("hover changes the icon to a cyan pointer and tints the label", () => {
    expect(row({ label: "Yes", isCursor: true })).toBe("<cyan>▷</cyan> <cyan>Yes</cyan>");
  });

  test("an un-hovered available row is a blank glyph and a plain label", () => {
    expect(row({ label: "No" })).toBe("  No");
  });

  test("a warning-accent row under the cursor paints the pointer and label yellow", () => {
    expect(row({ label: "Configure provider", isCursor: true, accent: "warning" })).toBe(
      "<yellow>▷</yellow> <yellow>Configure provider</yellow>",
    );
  });

  test("an un-hovered available row shows the placeholder dot when asked", () => {
    expect(row({ label: "Slack", placeholder: true })).toBe("<dim>◦</dim> Slack");
  });

  test("a checked row off the cursor shows a green check (single column, no checkbox)", () => {
    expect(row({ label: "Slack", state: { kind: "available", checked: true } })).toBe(
      "<green>✓</green> Slack",
    );
  });

  test("hovering a row takes over the icon column, even when checked", () => {
    expect(
      row({
        label: "Web Chat",
        isCursor: true,
        state: { kind: "available", checked: true },
      }),
    ).toBe("<cyan>▷</cyan> <cyan>Web Chat</cyan>");
  });

  test("a completed row under the cursor reads as inert: a dim pointer and dim label", () => {
    expect(
      row({
        label: "Web Chat",
        isCursor: true,
        state: { kind: "completed" },
        focusHint: "Already installed",
      }),
    ).toBe("<dim>▷</dim> <dim>Web Chat</dim><dim> · Already installed</dim>");
  });

  test("a completed row off the cursor keeps its green check", () => {
    expect(row({ label: "Web Chat", state: { kind: "completed" } })).toBe(
      "<green>✓</green> <dim>Web Chat</dim>",
    );
  });

  test("a locked row uses a dimmed check and reason", () => {
    expect(
      row({
        label: "Terminal UI",
        state: { kind: "locked", reason: "always available" },
      }),
    ).toBe("<dim><green>✓</green></dim> <dim>Terminal UI (always available)</dim>");
  });

  test("disabled rows dim the label and reason — no strikethrough", () => {
    expect(
      row({
        label: "Slack",
        state: { kind: "disabled", reason: "needs a Vercel project" },
      }),
    ).toBe("  <dim>Slack (needs a Vercel project)</dim>");
  });

  test("an un-hovered disabled menu row keeps the placeholder glyph", () => {
    expect(
      row({
        label: "Slack",
        state: { kind: "disabled", reason: "needs a Vercel project" },
        placeholder: true,
      }),
    ).toBe("<dim>◦</dim> <dim>Slack (needs a Vercel project)</dim>");
  });

  test("a disabled row under the cursor reads as inert: a dim pointer, not the placeholder", () => {
    expect(
      row({
        label: "Waiting",
        isCursor: true,
        state: { kind: "disabled" },
        placeholder: true,
      }),
    ).toBe("<dim>▷</dim> <dim>Waiting</dim>");
  });

  test("warning-toned disabled rows keep the label dim and turn the reason yellow", () => {
    expect(
      row({
        label: "Slack",
        state: {
          kind: "disabled",
          reason: "Requires Vercel account, see /model",
          reasonTone: "warning",
        },
      }),
    ).toBe("  <dim>Slack</dim><yellow> (Requires Vercel account, see /model)</yellow>");
  });

  test("a hint tab-aligns behind a padded label column", () => {
    expect(
      row({ label: "Slack", hint: "creates a slackbot", placeholder: true, hintPadding: 6 }),
    ).toBe("<dim>◦</dim> Slack<dim>       · creates a slackbot</dim>");
  });

  test("a persistent hint shows on any row; a focus hint only under the cursor", () => {
    expect(row({ label: "Slack", hint: "persistent" })).toBe("  Slack<dim> · persistent</dim>");
    expect(row({ label: "Slack", focusHint: "only on hover" })).toBe("  Slack");
    expect(row({ label: "Slack", isCursor: true, focusHint: "only on hover" })).toBe(
      "<cyan>▷</cyan> <cyan>Slack</cyan><dim> · only on hover</dim>",
    );
  });

  test("rejects contradictory semantic option states at the rendering boundary", () => {
    expect(() =>
      resolveOptionRowState({ disabled: true, completed: true, locked: true }, false),
    ).toThrow("cannot combine disabled, completed, or locked states");
  });
});
