import { describe, expect, test } from "vitest";

import {
  renderOptionRow,
  renderOptionRowContinuation,
  resolveOptionRowState,
  UNICODE_ROW_GLYPHS,
  type OptionRowState,
  type RowColors,
} from "./option-row.js";

const colors: RowColors = {
  blue: (text) => `<blue>${text}</blue>`,
  dim: (text) => `<dim>${text}</dim>`,
  green: (text) => `<green>${text}</green>`,
  inverse: (text) => `<inverse>${text}</inverse>`,
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
  test("owns continuation indentation at the option label column", () => {
    const option = row({ label: "Option" });
    const continuation = renderOptionRowContinuation("Hint");

    expect(continuation).toBe("   Hint");
    expect(continuation.indexOf("Hint")).toBe(option.indexOf("Option"));
  });

  test("highlights the cursor row in inverse blue and keeps its hint outside", () => {
    expect(row({ label: "Yes", hint: "Create a project", isCursor: true })).toBe(
      "<inverse><blue> ▶ Yes </blue></inverse><dim>· Create a project</dim>",
    );
  });

  test("keeps the hint column fixed when selection adds trailing padding", () => {
    const visible = (text: string) => text.replaceAll(/<[^>]+>/g, "");
    const unselected = visible(row({ label: "Slack", hint: "persistent" }));
    const selected = visible(row({ label: "Slack", hint: "persistent", isCursor: true }));

    expect(selected.indexOf("·")).toBe(unselected.indexOf("·"));
  });

  test("an un-hovered available row is a blank glyph and a plain label", () => {
    expect(row({ label: "No" })).toBe("   No");
  });

  test("a warning accent stays yellow under the cursor highlight", () => {
    expect(row({ label: "Configure provider", accent: "warning" })).toBe(
      "   <yellow>Configure provider</yellow>",
    );
    expect(row({ label: "Configure provider", isCursor: true, accent: "warning" })).toBe(
      "<inverse><yellow> ▶ Configure provider </yellow></inverse>",
    );
  });

  test("an un-hovered available row shows the placeholder dot when asked", () => {
    expect(row({ label: "Slack", placeholder: true })).toBe(" <dim>◦</dim> Slack");
  });

  test("a checked row off the cursor shows a green check (single column, no checkbox)", () => {
    expect(row({ label: "Slack", state: { kind: "available", checked: true } })).toBe(
      " <green>✓</green> Slack",
    );
  });

  test("hovering a checked row keeps its check inside the highlight", () => {
    // The highlight says "active", not "press to activate": the check stays.
    expect(
      row({
        label: "Web Chat",
        isCursor: true,
        state: { kind: "available", checked: true },
      }),
    ).toBe("<inverse><blue> ✓ Web Chat </blue></inverse>");
  });

  test("a completed row under the cursor reads as inert: a dim pointer and dim label", () => {
    expect(
      row({
        label: "Web Chat",
        isCursor: true,
        state: { kind: "completed" },
        focusHint: "Already installed",
      }),
    ).toBe(" <dim>▷</dim> <dim>Web Chat</dim><dim> · Already installed</dim>");
  });

  test("a completed row off the cursor keeps its green check", () => {
    expect(row({ label: "Web Chat", state: { kind: "completed" } })).toBe(
      " <green>✓</green> <dim>Web Chat</dim>",
    );
  });

  test("a locked row uses a dimmed check and reason", () => {
    expect(
      row({
        label: "Terminal UI",
        state: { kind: "locked", reason: "always available" },
      }),
    ).toBe(" <dim><green>✓</green></dim> <dim>Terminal UI (always available)</dim>");
  });

  test("disabled rows dim the label and reason — no strikethrough", () => {
    expect(
      row({
        label: "Slack",
        state: { kind: "disabled", reason: "needs a Vercel project" },
      }),
    ).toBe("   <dim>Slack (needs a Vercel project)</dim>");
  });

  test("an un-hovered disabled menu row keeps the placeholder glyph", () => {
    expect(
      row({
        label: "Slack",
        state: { kind: "disabled", reason: "needs a Vercel project" },
        placeholder: true,
      }),
    ).toBe(" <dim>◦</dim> <dim>Slack (needs a Vercel project)</dim>");
  });

  test("a disabled row under the cursor reads as inert: a dim pointer, not the placeholder", () => {
    expect(
      row({
        label: "Waiting",
        isCursor: true,
        state: { kind: "disabled" },
        placeholder: true,
      }),
    ).toBe(" <dim>▷</dim> <dim>Waiting</dim>");
  });

  test("warning-toned disabled rows keep the label dim and show a yellow alert annotation", () => {
    expect(
      row({
        label: "Slack",
        state: {
          kind: "disabled",
          reason: "Requires Vercel account, see /model",
          reasonTone: "warning",
        },
      }),
    ).toBe("   <dim>Slack</dim><yellow> ⚠ Requires Vercel account, see /model</yellow>");
  });

  test("a hint tab-aligns behind a padded label column", () => {
    expect(
      row({ label: "Slack", hint: "creates a slackbot", placeholder: true, hintPadding: 6 }),
    ).toBe(" <dim>◦</dim> Slack<dim>       · creates a slackbot</dim>");
  });

  test("a persistent hint shows on any row; a focus hint only under the cursor", () => {
    expect(row({ label: "Slack", hint: "persistent" })).toBe("   Slack<dim> · persistent</dim>");
    expect(row({ label: "Slack", focusHint: "only on hover" })).toBe("   Slack");
    expect(row({ label: "Slack", isCursor: true, focusHint: "only on hover" })).toBe(
      "<inverse><blue> ▶ Slack </blue></inverse><dim>· only on hover</dim>",
    );
  });

  test("rejects contradictory semantic option states at the rendering boundary", () => {
    expect(() =>
      resolveOptionRowState({ disabled: true, completed: true, locked: true }, false),
    ).toThrow("cannot combine disabled, completed, or locked states");
  });
});
