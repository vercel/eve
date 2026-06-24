import { describe, expect, test } from "vitest";

import {
  formatPromptSubmission,
  formatRailLine,
  renderMultiselectPrompt,
  renderSearchableSelect,
  renderSelectPrompt,
  type PromptColors,
} from "./prompt-ui.js";

const identity = (text: string) => text;

const colors: PromptColors = {
  blue: identity,
  bold: identity,
  cyan: identity,
  dim: identity,
  gray: identity,
  green: identity,
  inverse: identity,
  red: identity,
  strikethrough: identity,
  white: identity,
  yellow: identity,
};

const styledColors: PromptColors = {
  ...colors,
  blue: (text) => `<blue>${text}</blue>`,
  bold: (text) => `<b>${text}</b>`,
  dim: (text) => `<dim>${text}</dim>`,
  green: (text) => `<green>${text}</green>`,
  cyan: (text) => `<cyan>${text}</cyan>`,
  inverse: (text) => `<inverse>${text}</inverse>`,
  strikethrough: (text) => `<strike>${text}</strike>`,
  yellow: (text) => `<yellow>${text}</yellow>`,
};

describe("formatRailLine", () => {
  test("keeps each explicit newline attached to the rail", () => {
    expect(
      formatRailLine(
        [
          "",
          "Agent created: test00",
          "  • Project path:    /Users/rconti/wrk/test00",
          "  • Model:           anthropic/claude-haiku-4.5",
          "  • Channels:        web",
        ].join("\n"),
        colors,
        undefined,
      ),
    ).toBe(
      [
        "│",
        "│  Agent created: test00",
        "│    • Project path:    /Users/rconti/wrk/test00",
        "│    • Model:           anthropic/claude-haiku-4.5",
        "│    • Channels:        web",
        "",
      ].join("\n"),
    );
  });
});

describe("renderSelectPrompt", () => {
  test("marks the highlighted single-select option with a subtle arrow and dims its hint", () => {
    const rendered = renderSelectPrompt({
      colors: styledColors,
      cursor: 0,
      message: "Deploy this agent to Vercel?",
      options: [
        { value: true, label: "Yes", hint: "Create or link a project" },
        { value: false, label: "No" },
      ],
      state: "active",
    });

    expect(rendered).toContain(
      "<inverse><blue> ▶ Yes </blue></inverse><dim>· Create or link a project</dim>",
    );
    // No check or legacy checkbox glyphs on a single-select row.
    expect(rendered).not.toContain("✓");
    expect(rendered).not.toContain("◻");
    expect(rendered).not.toContain("◼");
  });

  test("moves the dimmed question to the front of the chosen answer on submit", () => {
    const rendered = renderSelectPrompt({
      colors: styledColors,
      cursor: 0,
      message: "Deploy this agent to Vercel?",
      options: [{ value: true, label: "Yes", hint: "Create or link a project" }],
      state: "submit",
    });

    expect(rendered).toContain("<dim>Deploy this agent to Vercel?</dim> Yes");
  });

  test("omits the inline hint from the chosen answer on submit", () => {
    const rendered = renderSelectPrompt({
      colors: styledColors,
      cursor: 0,
      message: "Deploy this agent to Vercel?",
      options: [{ value: true, label: "Yes", hint: "Create or link a project" }],
      state: "submit",
    });

    expect(rendered).not.toContain("Create or link a project");
  });

  test("shows the highlighted option's description on the line below, dimmed", () => {
    const rendered = renderSelectPrompt({
      colors: styledColors,
      cursor: 1,
      message: "Deploy this agent to Vercel?",
      options: [
        { value: true, label: "Yes", description: "Fastest path to production" },
        { value: false, label: "No", description: "Set up locally and wire yourself" },
      ],
      state: "active",
    });

    expect(rendered).toContain(
      "<inverse><blue> ▶ No </blue></inverse>\n│    <dim>Set up locally and wire yourself</dim>",
    );
    // The non-highlighted option keeps its description hidden.
    expect(rendered).not.toContain("Fastest path to production");
  });

  test("hides the description once a choice is submitted, leaving only the label", () => {
    const rendered = renderSelectPrompt({
      colors: styledColors,
      cursor: 1,
      message: "Deploy this agent to Vercel?",
      options: [
        { value: true, label: "Yes", description: "Fastest path to production" },
        { value: false, label: "No", description: "Set up locally and wire yourself" },
      ],
      state: "submit",
    });

    expect(rendered).toContain("<dim>Deploy this agent to Vercel?</dim> No");
    expect(rendered).not.toContain("Set up locally and wire yourself");
  });

  test("tucks a footer note onto the corner line while active", () => {
    const rendered = renderSelectPrompt({
      colors,
      cursor: 0,
      footerNote: "Press Esc again to quit",
      message: "Pick a model",
      options: [{ value: "a", label: "A" }],
      state: "active",
    });

    expect(rendered).toContain("└  Press Esc again to quit");
  });

  test("omits the footer note when none is given", () => {
    const rendered = renderSelectPrompt({
      colors,
      cursor: 0,
      message: "Pick a model",
      options: [{ value: "a", label: "A" }],
      state: "active",
    });

    expect(rendered.trimEnd().endsWith("└")).toBe(true);
  });
});

describe("renderMultiselectPrompt", () => {
  test("collapses the selected labels onto the dimmed question on submit", () => {
    const rendered = renderMultiselectPrompt({
      colors: styledColors,
      cursor: 0,
      message: "Select channels",
      options: [
        { value: "web", label: "Web Chat" },
        { value: "slack", label: "Slack" },
      ],
      selectedValues: ["web", "slack"],
      state: "submit",
    });

    expect(rendered).toContain("<dim>Select channels</dim> Web Chat, Slack");
  });

  test("keeps the empty selection note dimmed and inline", () => {
    const rendered = renderMultiselectPrompt({
      colors: styledColors,
      cursor: 0,
      message: "Select connections",
      options: [{ value: "linear", label: "Linear" }],
      selectedValues: [],
      state: "submit",
    });

    expect(rendered).toContain("<dim>Select connections</dim> <dim>(none selected)</dim>");
  });

  test("tucks a footer note onto the corner line while active", () => {
    const rendered = renderMultiselectPrompt({
      colors,
      cursor: 0,
      footerNote: "Press Esc again to quit",
      message: "Select channels",
      options: [{ value: "web", label: "Web Chat" }],
      selectedValues: [],
      state: "active",
    });

    expect(rendered).toContain("└  Press Esc again to quit");
  });

  test("hover takes the icon column; a selected row off the cursor shows a check", () => {
    const rendered = renderMultiselectPrompt({
      colors: styledColors,
      cursor: 0,
      message: "Select channels",
      options: [
        { value: "web", label: "Web Chat" },
        { value: "slack", label: "Slack" },
      ],
      selectedValues: ["slack"],
      state: "active",
    });

    // Cursor row (Web Chat): the pointer. Selected row off-cursor (Slack): a check.
    expect(rendered).toContain("<inverse><blue> ▶ Web Chat </blue></inverse>");
    expect(rendered).toContain("<green>✓</green> Slack");
    // No key legend: the Submit row carries the confirm affordance.
    expect(rendered).not.toContain("space");
    expect(rendered).not.toContain("to confirm");
  });

  test("appends a Submit row after the options, dimmed until the cursor reaches it", () => {
    const render = (cursor: number) =>
      renderMultiselectPrompt({
        colors: styledColors,
        cursor,
        message: "Select channels",
        options: [
          { value: "web", label: "Web Chat" },
          { value: "slack", label: "Slack" },
        ],
        selectedValues: [],
        state: "active",
      });

    // A blank rail line sets the bold Submit row (with its green check) apart.
    expect(render(0)).toContain("│\n│     <dim><b>Submit</b></dim> <green>✓</green>");
    // Cursor one past the options sits on the Submit row: the pointer plus a
    // bright label.
    expect(render(2)).toContain(
      "<inverse><blue> ▶ <b>Submit</b> </blue></inverse><green>✓</green>",
    );
    const visible = (text: string) => text.replaceAll(/<[^>]+>/g, "");
    const unselected = visible(render(0))
      .split("\n")
      .find((line) => line.includes("Submit"));
    const selected = visible(render(2))
      .split("\n")
      .find((line) => line.includes("Submit"));
    expect(selected?.indexOf("✓")).toBe(unselected?.indexOf("✓"));
  });

  test("labels the Submit row with the caller-computed label", () => {
    const rendered = renderMultiselectPrompt({
      colors: styledColors,
      cursor: 0,
      message: "Select connections",
      options: [{ value: "linear", label: "Linear" }],
      selectedValues: [],
      state: "active",
      submitLabel: "Skip",
    });

    expect(rendered).toContain("<dim><b>Skip</b></dim> <green>✓</green>");
    expect(rendered).not.toContain("Submit");
  });

  test("renders a locked row as a dimmed always-on box beside toggleable rows", () => {
    const rendered = renderMultiselectPrompt({
      colors: styledColors,
      cursor: 0,
      message: "Select channels",
      options: [
        { value: "web", label: "Web Chat" },
        { value: "tui", label: "Terminal UI", locked: true, lockedReason: "always available" },
      ],
      selectedValues: ["tui"],
      state: "active",
    });

    expect(rendered).toContain("<inverse><blue> ▶ Web Chat </blue></inverse>");
    // A locked row is mandatory rather than user-selected, so both its check
    // and label stay dim while the reason remains inline.
    expect(rendered).toContain(
      "<dim><green>✓</green></dim> <dim>Terminal UI (always available)</dim>",
    );
  });
});

describe("formatPromptSubmission", () => {
  test("renders the leading rail, bullet, dimmed question, then answer", () => {
    expect(
      formatPromptSubmission("submit", "What is your agent named?", "test00", {
        colors: styledColors,
        leadingRail: "green",
      }),
    ).toBe("<green>│</green>\n<green>▲</green>  <dim>What is your agent named?</dim> test00");
  });

  test("drops the trailing space when there is no answer", () => {
    expect(
      formatPromptSubmission("submit", "What is your agent named?", "", {
        colors: styledColors,
      }),
    ).toBe("│\n<green>▲</green>  <dim>What is your agent named?</dim>");
  });
});

describe("renderSearchableSelect", () => {
  const projectOptions = [
    { value: "alpha", label: "alpha" },
    { value: "beta", label: "beta" },
  ];

  test("single-select: arrow on the cursor row, no checkbox, and a no-space help line", () => {
    const rendered = renderSearchableSelect({
      colors: styledColors,
      state: "active",
      message: "Vercel project to link",
      multiple: false,
      filter: "",
      placeholder: "type to filter projects",
      options: projectOptions,
      cursor: 0,
      selectedValues: ["alpha"],
      submitDisplay: "",
    });

    expect(rendered).toContain("<inverse><blue> ▶ alpha </blue></inverse>");
    expect(rendered).toContain("<cyan>enter</cyan><dim> to select</dim>");
    expect(rendered).not.toContain("space");
    expect(rendered).not.toContain("◻");
    expect(rendered).not.toContain("Submit");
  });

  test("multi-select: checkboxes, a pinned Submit row, and only a filter hint", () => {
    const rendered = renderSearchableSelect({
      colors: styledColors,
      state: "active",
      message: "Select connections",
      multiple: true,
      filter: "",
      options: projectOptions,
      cursor: 0,
      selectedValues: ["beta"],
      submitDisplay: "",
    });

    expect(rendered).toContain("<inverse><blue> ▶ alpha </blue></inverse>");
    expect(rendered).toContain("<green>✓</green> beta");
    expect(rendered).toContain("<dim><b>Submit</b></dim> <green>✓</green>");
    // The Submit row replaces the key legend; only the filter hint remains.
    expect(rendered).toContain("<cyan>type</cyan><dim> to filter</dim>");
    expect(rendered).not.toContain("space");
    expect(rendered).not.toContain("to confirm");
  });

  test("multi-select: the cursor one past the options highlights the Submit row", () => {
    const rendered = renderSearchableSelect({
      colors: styledColors,
      state: "active",
      message: "Select connections",
      multiple: true,
      filter: "",
      options: projectOptions,
      cursor: projectOptions.length,
      selectedValues: ["beta"],
      submitDisplay: "",
    });

    expect(rendered).toContain("<inverse><blue> ▶ <b>Submit</b> </blue></inverse><green>✓</green>");
    // No option row carries the pointer while the cursor sits on Submit.
    expect(rendered).not.toContain("<inverse><blue> ▶ alpha </blue></inverse>");
  });

  test("a leading featured run sizes the default viewport; scrolling reaches the rest", () => {
    const catalog = [
      { value: "sonnet", label: "Sonnet", featured: true },
      { value: "opus", label: "Opus", featured: true },
      { value: "glm", label: "GLM" },
      { value: "grok", label: "Grok" },
    ];
    const render = (cursor: number, filter = "") =>
      renderSearchableSelect({
        colors: styledColors,
        state: "active",
        message: "Which model?",
        multiple: false,
        filter,
        options: catalog,
        cursor,
        selectedValues: [],
        submitDisplay: "",
      });

    // Default view: only the featured shortlist, with the footer advertising more.
    const initial = render(0);
    expect(initial).toContain("Sonnet");
    expect(initial).toContain("Opus");
    expect(initial).not.toContain("GLM");
    expect(initial).toContain("4 options, showing 1–2");
    // Scrolling past the shortlist moves the window into the full catalog.
    expect(render(3)).toContain("Grok");
    // Typing a filter restores the full-size window over the matches.
    expect(render(0, "g")).toContain("GLM");
  });

  test("folds to the dimmed question and chosen answer on submit", () => {
    const rendered = renderSearchableSelect({
      colors: styledColors,
      state: "submit",
      message: "Vercel project to link",
      multiple: false,
      filter: "",
      options: projectOptions,
      cursor: 1,
      selectedValues: ["beta"],
      submitDisplay: "beta",
    });

    expect(rendered).toContain("<dim>Vercel project to link</dim> beta");
  });
});
