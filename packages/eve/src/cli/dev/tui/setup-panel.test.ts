import { describe, expect, it } from "vitest";

import { initialSelectState } from "#setup/cli/select-state.js";
import { lineOf } from "./line-editor.js";
import {
  renderAcknowledgeQuestion,
  renderFlowPanel,
  renderSelectQuestion,
  renderTextQuestion,
} from "./setup-panel.js";
import { createTheme } from "./theme.js";

const theme = createTheme({ color: false, unicode: true });
const colorTheme = createTheme({ color: true, unicode: true });

const OPTIONS = [
  { value: "new", label: "Create a new project", hint: "fastest" },
  { value: "link", label: "Link an existing project" },
];

describe("renderFlowPanel", () => {
  it("aligns the base-foreground title, progress, and question content", () => {
    const rows = renderFlowPanel(
      {
        title: "/deploy",
        lines: [
          { text: "Creating Vercel project…", tone: "info" },
          { text: "Linked", tone: "success" },
        ],
        content: {
          kind: "question",
          rows: ["  Vercel project", "", "  ▷ Create a new project"],
        },
      },
      theme,
      60,
    );
    const text = rows.join("\n");

    expect(rows[0]).toBe("▔".repeat(60));
    expect(rows[1]).toBe("   /deploy");
    expect(text).toContain("   · Creating Vercel project…");
    expect(text).toContain("   ✓ Linked");
    expect(text).toContain("   ▷ Create a new project");
  });

  it("keeps only the freshest progress lines in view", () => {
    const lines = Array.from({ length: 10 }, (_, index) => ({
      text: `step ${index}`,
      tone: "info" as const,
    }));
    const text = renderFlowPanel(
      { title: "/channels", lines, content: { kind: "idle", frame: "⠏" } },
      theme,
      60,
    ).join("\n");

    expect(text).not.toContain("step 3");
    expect(text).toContain("step 4");
    expect(text).toContain("step 9");
  });

  it("shows the ephemeral status spinner when no question is active", () => {
    const text = renderFlowPanel(
      {
        title: "/deploy",
        lines: [],
        content: {
          kind: "status",
          status: { text: "Loading teams…", frame: "⠼" },
        },
      },
      theme,
      60,
    ).join("\n");

    expect(text).toContain("⠼ Loading teams…");
  });

  it("rides the status spinner above an open question for the install wait", () => {
    const text = renderFlowPanel(
      {
        title: "/channels",
        lines: [],
        content: {
          kind: "question",
          status: { text: "Creating a Slackbot through Vercel Connect…", frame: "⠏" },
          rows: ["  ◦ Try again", "  ◦ Cancel"],
        },
      },
      theme,
      60,
    ).join("\n");

    expect(text).toContain("⠏ Creating a Slackbot through Vercel Connect…");
    expect(text).toContain("◦ Try again");
    expect(text).toContain("◦ Cancel");
    // The spinner leads; the actions follow.
    expect(text.indexOf("Creating a Slackbot")).toBeLessThan(text.indexOf("Try again"));
  });
});

describe("renderSelectQuestion", () => {
  it("paints an unnumbered single-select with one state-glyph column", () => {
    const rows = renderSelectQuestion(
      {
        kind: "single",
        message: "Vercel project",
        options: OPTIONS,
        select: initialSelectState({ options: OPTIONS }),
      },
      theme,
      60,
    );
    const text = rows.join("\n");

    expect(rows[0]).toBe("  Vercel project");
    expect(text).not.toContain("▔".repeat(10));
    // The lone hint sits one space past its own label — the longer hint-less
    // "Link an existing project" no longer pads the column open.
    expect(text).toContain("  ▷ Create a new project · fastest");
    expect(text).toContain("    Link an existing project");
    expect(text).not.toContain("1.");
    expect(text).toContain("esc to cancel");
  });

  it("uses the theme's ASCII option placeholder", () => {
    const ascii = createTheme({ color: false, unicode: false });
    const rows = renderSelectQuestion(
      {
        kind: "stacked",
        message: "Vercel project",
        options: OPTIONS,
        select: initialSelectState({ options: OPTIONS }),
      },
      ascii,
      60,
    );

    expect(rows).toContain("  . Link an existing project");
    expect(rows.join("\n")).not.toContain("◦");
  });

  it("drops the numbers for a lone option", () => {
    const lone = [{ value: "relink", label: "Link to another project" }];
    const text = renderSelectQuestion(
      {
        kind: "single",
        message: "Already linked to weather-agent in Acme",
        options: lone,
        select: initialSelectState({ options: lone }),
      },
      theme,
      60,
    ).join("\n");

    expect(text).toContain("  ▷ Link to another project");
    expect(text).not.toContain("1.");
  });

  it("renders completed task rows as focusable but not highlighted actions", () => {
    const options = [
      {
        value: "tui",
        label: "Terminal UI",
        completed: true,
        focusHint: "Already installed",
      },
      {
        value: "web",
        label: "Web Chat",
        completed: true,
        focusHint: "Already installed",
      },
      { value: "slack", label: "Slack", hint: "Creates slackbot and deploys to Vercel" },
      { value: "done", label: "Done" },
    ];
    const rows = renderSelectQuestion(
      {
        kind: "task-list",
        message: "Where will you chat with your agent?",
        options,
        notices: [
          { tone: "warning", text: "Overwrote /tmp/weather-agent" },
          { tone: "success", text: "Scaffolded channel: web" },
        ],
        select: initialSelectState({ options }),
      },
      theme,
      80,
    );

    // The focused completed row reads as inert: a dim pointer, not a check.
    expect(rows).toContain("  ▷ Terminal UI · Already installed");
    expect(rows).not.toContain("  ✓ Terminal UI");
    // An unfocused completed row keeps its check.
    expect(rows).toContain("  ✓ Web Chat");
    expect(rows).toContain("  ◦ Slack       · Creates slackbot and deploys to Vercel");
    expect(rows).toContain("    Done");
    expect(rows).toContain("  ⚠ Overwrote /tmp/weather-agent");
    expect(rows).toContain("  ✓ Scaffolded channel: web");
    expect(rows.indexOf("    Done")).toBeLessThan(rows.indexOf("  ⚠ Overwrote /tmp/weather-agent"));
    expect(rows.at(-1)).toContain("↑/↓ move · enter to select · esc to cancel");

    const coloredRow = renderSelectQuestion(
      {
        kind: "task-list",
        message: "Where will you chat with your agent?",
        options,
        select: initialSelectState({ options }),
      },
      colorTheme,
      80,
    ).find((row) => row.includes("Terminal UI"));
    // Focused completed row: dim pointer matching the dim label, never green or cyan.
    expect(coloredRow).toContain("\x1b[2m▷\x1b[22m");
    expect(coloredRow).toContain("\x1b[2mTerminal UI\x1b[22m");
    expect(coloredRow).toContain("\x1b[2m · Already installed\x1b[22m");
    expect(coloredRow).not.toContain("\x1b[32m");
    expect(coloredRow).not.toContain("\x1b[36m");
  });

  it("drops the numbers for checklists and searchable lists", () => {
    const multi = renderSelectQuestion(
      {
        kind: "multi",
        message: "Select channels",
        options: OPTIONS,
        select: initialSelectState({ options: OPTIONS, submitRow: true }),
      },
      theme,
      60,
    ).join("\n");
    expect(multi).toContain("  ▷ Create a new project");
    expect(multi).not.toContain("1.");

    const searchable = renderSelectQuestion(
      {
        kind: "search",
        message: "Which model?",
        options: OPTIONS,
        select: initialSelectState({ options: OPTIONS }),
      },
      theme,
      60,
    ).join("\n");
    expect(searchable).not.toContain("1.");
  });

  it("appends a reset when clipping cuts a row before its color close", () => {
    const colored = createTheme({ color: true, unicode: true });
    // The blue span's close sits past the clip width; without a trailing
    // reset the open blue would bleed into every row painted below.
    const longName = "a-very-long-project-name-that-overflows-the-panel";
    const rows = renderFlowPanel(
      {
        title: "",
        lines: [{ tone: "warning", text: `Project named \x1b[34m${longName}\x1b[39m exists` }],
        content: { kind: "question", rows: ["  Question"] },
      },
      colored,
      30,
    );
    const clipped = rows.find((row) => row.includes("\x1b[34m"));
    expect(clipped?.endsWith("\x1b[0m")).toBe(true);
  });

  it("renders a warning-toned disabled row with a dim label and yellow reason", () => {
    const colored = createTheme({ color: true, unicode: true });
    const options = [
      { value: "web", label: "Web Chat" },
      {
        value: "slack",
        label: "Slack",
        disabled: true,
        disabledReason: "Requires Vercel account, see /model",
        disabledReasonTone: "warning" as const,
      },
    ];
    const text = renderSelectQuestion(
      {
        kind: "single",
        message: "Channels",
        options,
        select: initialSelectState({ options }),
      },
      colored,
      80,
    ).join("\n");

    // Dim label (SGR 2), un-struck, followed by the reason in yellow (SGR 33).
    expect(text).toContain(
      "\x1b[2mSlack\x1b[22m\x1b[33m (Requires Vercel account, see /model)\x1b[39m",
    );
  });

  it("rides a disabled row's description on its own dim sub-line, not inline", () => {
    const plain = createTheme({ color: false });
    const options = [
      { value: "model", label: "Change model", disabled: true, description: "Disabled here" },
      { value: "done", label: "Done" },
    ];
    const text = renderSelectQuestion(
      {
        kind: "single",
        message: "Configure the agent model",
        options,
        select: initialSelectState({ options }),
      },
      plain,
      80,
    ).join("\n");

    // The reason sits under the row (4-space indent), not as an inline parenthetical.
    expect(text).toContain("Change model\n    Disabled here");
    expect(text).not.toContain("Change model (Disabled here)");
  });

  it("wraps a long notice with a hanging indent under the glyph", () => {
    const plain = createTheme({ color: false });
    const options = [{ value: "done", label: "Done" }];
    const rows = renderSelectQuestion(
      {
        kind: "single",
        message: "Configure the agent model",
        options,
        select: initialSelectState({ options }),
        notices: [
          { tone: "warning", text: "alpha bravo charlie delta echo foxtrot golf hotel india" },
        ],
      },
      plain,
      28,
    );

    const first = rows.find((line) => line.includes("⚠"));
    expect(first).toMatch(/⚠ alpha/);
    // A continuation line is indented and carries no glyph.
    const continuation = rows.find((line) => !line.includes("⚠") && /^\s{3,}\S/.test(line));
    expect(continuation).toBeDefined();
  });

  it("renders the hovered editable row as a live field with the caret after the name", () => {
    const options = [
      { value: "new", label: "Create a new project", hint: "Named 'weather-agent'" },
      { value: "link", label: "Link an existing project" },
    ];
    const baseEdit = {
      optionValue: "new",
      defaultValue: "weather-agent",
      formatHint: (value: string) => `Named '${value}'`,
      caretVisible: true,
    };

    // Hovering the editable row: the seeded default reads back with the caret
    // parked after it, never wedged before the name, and the footer says so.
    const hover = renderSelectQuestion(
      {
        kind: "editable",
        message: "Vercel project",
        options,
        select: initialSelectState({ options }),
        edit: { ...baseEdit, editor: lineOf("weather-agent") },
      },
      theme,
      80,
    );
    expect(hover.join("\n")).toContain("Named 'weather-agent▏'");
    expect(hover.join("\n")).not.toContain("'▏weather-agent'");
    expect(hover.at(-1)).toContain("type to rename");

    // Caret off (blink) collapses to nothing — no stray space before the quote.
    const hoverOff = renderSelectQuestion(
      {
        kind: "editable",
        message: "Vercel project",
        options,
        select: initialSelectState({ options }),
        edit: { ...baseEdit, caretVisible: false, editor: lineOf("weather-agent") },
      },
      theme,
      80,
    );
    expect(hoverOff.join("\n")).toContain("Named 'weather-agent'");
    expect(hoverOff.join("\n")).not.toContain("Named 'weather-agent '");

    // A backspaced field renders the shortened name with the caret at its end.
    const edited = renderSelectQuestion(
      {
        kind: "editable",
        message: "Vercel project",
        options,
        select: initialSelectState({ options }),
        edit: { ...baseEdit, editor: lineOf("weather-fixtur") },
      },
      theme,
      80,
    );
    expect(edited.join("\n")).toContain("Named 'weather-fixtur▏'");
  });

  it("hides the rename caret and hint when the cursor is off the editable row", () => {
    const options = [
      { value: "new", label: "Create a new project", hint: "Named 'weather-agent'" },
      { value: "link", label: "Link an existing project" },
    ];
    const rows = renderSelectQuestion(
      {
        kind: "editable",
        message: "Vercel project",
        options,
        // Cursor parked on the second (non-editable) row.
        select: { ...initialSelectState({ options }), cursor: 1 },
        edit: {
          optionValue: "new",
          defaultValue: "weather-agent",
          formatHint: (value: string) => `Named '${value}'`,
          caretVisible: true,
          editor: lineOf(""),
        },
      },
      theme,
      80,
    );
    // The editable row shows its plain static hint — no caret injected.
    expect(rows.join("\n")).toContain("Named 'weather-agent'");
    expect(rows.join("\n")).not.toContain("weather-agent▏");
    expect(rows.at(-1)).not.toContain("type to rename");
  });

  it("stacks hints under labels with separators and trailing notices", () => {
    const options = [
      { value: "model", label: "Change model", hint: "anthropic/claude-sonnet-4.6" },
      { value: "provider", label: "Change provider", hint: "AI Gateway (Linked to my-agent)" },
    ];
    const rows = renderSelectQuestion(
      {
        kind: "stacked",
        message: "Configure the agent's model",
        options,
        notices: [{ tone: "success", text: "Model changed to openai/gpt-5.5" }],
        select: initialSelectState({ options }),
      },
      theme,
      80,
    );

    expect(rows).toEqual([
      "  Configure the agent's model",
      "",
      "  ▷ Change model",
      "    anthropic/claude-sonnet-4.6",
      "",
      "  ◦ Change provider",
      "    AI Gateway (Linked to my-agent)",
      "",
      "  ✓ Model changed to openai/gpt-5.5",
      "",
      "  ↑/↓ move · enter to select · esc to cancel",
    ]);
  });

  it("owns emphasis for stacked and multiline select headings", () => {
    const colored = createTheme({ color: true, unicode: true });
    const stacked = renderSelectQuestion(
      {
        kind: "stacked",
        message: "Configure the agent's model",
        options: OPTIONS,
        select: initialSelectState({ options: OPTIONS }),
      },
      colored,
      80,
    );
    const linked = renderSelectQuestion(
      {
        kind: "single",
        message: "This directory is already linked to\nweather-agent-001 in Internal Playground",
        options: OPTIONS,
        select: initialSelectState({ options: OPTIONS }),
      },
      colored,
      80,
    );

    expect(stacked[0]).toBe("  \x1b[1mConfigure the agent's model\x1b[22m");
    expect(linked[0]).toBe("  This directory is already linked to");
    expect(linked[1]).toBe("  \x1b[1mweather-agent-001 in Internal Playground\x1b[22m");
  });

  it("keeps a stacked hint dim across an embedded bold span", () => {
    const colored = createTheme({ color: true, unicode: true });
    const options = [
      {
        value: "provider",
        label: "Change provider",
        hint: "AI Gateway (Linked to \x1b[1mmy-agent\x1b[22m)",
      },
    ];
    const text = renderSelectQuestion(
      {
        kind: "stacked",
        message: "Configure the agent's model",
        options,
        select: initialSelectState({ options }),
      },
      colored,
      80,
    ).join("\n");

    // Bold's close (SGR 22) also ends dim — the renderer re-opens dim so the
    // hint's tail does not pop to full brightness.
    expect(text).toContain("\x1b[1mmy-agent\x1b[22m\x1b[2m)");
  });

  it("renders checkboxes and the Submit row for a multi-select", () => {
    const select = initialSelectState({
      options: OPTIONS,
      initialValues: ["link"],
      submitRow: true,
    });
    const text = renderSelectQuestion(
      {
        kind: "multi",
        message: "Select channels",
        options: OPTIONS,
        select,
      },
      theme,
      60,
    ).join("\n");

    expect(text).toContain("▷ Create a new project");
    expect(text).toContain("✓ Link an existing project");
    expect(text).toContain("Submit");
    expect(text).toContain("space to toggle");
  });

  it("windows a searchable list and advertises the rest", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      value: `model-${index}`,
      label: `Model ${index}`,
    }));
    const text = renderSelectQuestion(
      {
        kind: "search",
        message: "Which model?",
        options: many,
        placeholder: "type to filter",
        select: initialSelectState({ options: many }),
      },
      theme,
      60,
    ).join("\n");

    expect(text).toContain("type to filter");
    expect(text).toContain("> type to filter");
    expect(text).toContain("↑↓ 20 options, showing 1–8");
    expect(text).not.toContain("Model 12");
  });

  it("paints a validation error inside the question", () => {
    const text = renderSelectQuestion(
      {
        kind: "multi",
        message: "Select channels",
        options: OPTIONS,
        select: initialSelectState({ options: OPTIONS, submitRow: true }),
        error: "Select at least one option, then submit.",
      },
      theme,
      60,
    ).join("\n");

    expect(text).toContain("Select at least one option, then submit.");
  });

  const ACTIONS = [
    { value: "retry", label: "Try again" },
    { value: "cancel", label: "Cancel" },
  ];

  it("sets the context row apart from the actions with a blank line", () => {
    const rows = renderSelectQuestion(
      {
        kind: "actions",
        context: "Waiting for you to complete setup in the browser",
        actions: ACTIONS,
        cursor: undefined,
      },
      theme,
      70,
    );

    // An empty message contributes no header rows: the inert row leads directly.
    expect(rows[0]).toContain("Waiting for you to complete setup in the browser");
    const waiting = rows.findIndex((row) => row.includes("Waiting for you to complete setup"));
    const retry = rows.findIndex((row) => row.includes("Try again"));
    // A blank line separates the inert context row from the actions below it.
    expect(rows[waiting + 1]).toBe("");
    expect(retry).toBe(waiting + 2);
    expect(rows[waiting]).toContain("· Waiting for you to complete setup in the browser");
    expect(rows.some((row) => row.includes("◦ Try again"))).toBe(true);
    expect(rows.some((row) => row.includes("◦ Cancel"))).toBe(true);
  });

  it("focuses actions independently from the inert context row", () => {
    const rows = renderSelectQuestion(
      {
        kind: "actions",
        context: "Waiting for you to complete setup in the browser",
        actions: ACTIONS,
        cursor: 0,
      },
      colorTheme,
      70,
    );
    const context = rows.find((line) => line.includes("Waiting for you to complete setup"));
    const retry = rows.find((line) => line.includes("Try again"));

    expect(context).toContain("\x1b[2m· Waiting for you to complete setup in the browser\x1b[22m");
    expect(context).not.toContain("▷");
    expect(retry).toContain("\x1b[36m▷\x1b[39m");
  });
});

describe("renderTextQuestion", () => {
  it("paints the message, caret line, and hints", () => {
    const rows = renderTextQuestion(
      { message: "Project name", editor: lineOf("my-agent"), mask: false },
      theme,
      60,
      true,
    );
    const text = rows.join("\n");

    expect(rows[0]).toBe("  Project name");
    // The input line sits directly under the message — no blank row between.
    expect(rows[1]).toContain("my-agent");
    expect(text).toContain("enter to submit · esc to cancel");
  });

  it("paints notices above the message, gone with the question", () => {
    const rows = renderTextQuestion(
      {
        message: "New project name",
        editor: lineOf(""),
        mask: false,
        notices: [{ tone: "warning", text: "Project named 'x' already exists in 'team'" }],
      },
      theme,
      60,
      true,
    );

    expect(rows[0]).toBe("⚠ Project named 'x' already exists in 'team'");
    expect(rows[1]).toBe("  New project name");
  });

  it("masks the typed value", () => {
    const text = renderTextQuestion(
      { message: "API key", editor: lineOf("secret"), mask: true },
      theme,
      60,
      false,
    ).join("\n");

    expect(text).toContain("••••••");
    expect(text).not.toContain("secret");
  });
});

describe("renderAcknowledgeQuestion", () => {
  it("paints the heading, dim body lines, and an enter-only footer", () => {
    const rows = renderAcknowledgeQuestion(
      {
        message: "Using another model provider",
        lines: ["Set your provider's API key in .env.local.", "Point your agent at it."],
      },
      theme,
      60,
    );
    const text = rows.join("\n");

    expect(rows[0]).toBe("  Using another model provider");
    expect(text).toContain("Set your provider's API key in .env.local.");
    expect(text).toContain("Point your agent at it.");
    expect(text).toContain("enter to continue");
    expect(text).not.toContain("esc");
  });

  it("omits the body gap when there are no lines", () => {
    const rows = renderAcknowledgeQuestion({ message: "All set", lines: [] }, theme, 60);

    expect(rows[0]).toBe("  All set");
    expect(rows.filter((row) => row.trim().length > 0)).toHaveLength(2);
  });
});
