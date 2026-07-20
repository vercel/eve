import { describe, expect, it } from "vitest";

import { initialSelectState } from "#setup/cli/select-state.js";
import { lineOf } from "./line-editor.js";
import {
  renderAcknowledgeQuestion,
  renderFlowPanel,
  renderModelEditorQuestion,
  renderSelectQuestion,
  renderTextQuestion,
  type SetupPanelOption,
} from "./setup-panel.js";
import { stripAnsi } from "#cli/ui/terminal-text.js";
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
      {
        title: "/channels",
        lines,
        content: { kind: "idle", indicator: { glyph: "⠏", color: "yellow" } },
      },
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
          status: {
            kind: "progress",
            text: "Loading teams…",
            indicator: { glyph: "⠼", color: "yellow" },
          },
        },
      },
      theme,
      60,
    ).join("\n");

    expect(text).toContain("⠼ Loading teams…");
  });

  it("renders the build-phase pulse for a setup status", () => {
    const text = renderFlowPanel(
      {
        title: "/model",
        lines: [],
        content: {
          kind: "status",
          status: {
            kind: "progress",
            text: "Checking the project…",
            indicator: { glyph: "▪", color: "green" },
          },
        },
      },
      colorTheme,
      60,
    ).join("\n");

    expect(text).toContain(colorTheme.colors.green("▪"));
    expect(stripAnsi(text)).toContain("▪ Checking the project…");
  });

  it("rides the status pulse above an open question for the install wait", () => {
    const text = renderFlowPanel(
      {
        title: "/channels",
        lines: [],
        content: {
          kind: "question",
          status: {
            kind: "progress",
            text: "Creating a Slackbot through Vercel Connect…",
            indicator: { glyph: "▪", color: "green" },
          },
          rows: ["  ◦ Try again", "  ◦ Cancel"],
        },
      },
      theme,
      60,
    ).join("\n");

    expect(text).toContain("▪ Creating a Slackbot through Vercel Connect…");
    expect(text).toContain("◦ Try again");
    expect(text).toContain("◦ Cancel");
    // The spinner leads; the actions follow.
    expect(text.indexOf("Creating a Slackbot")).toBeLessThan(text.indexOf("Try again"));
  });
});

describe("renderSelectQuestion", () => {
  it("shows a stacked menu's selected-row description beneath that option", () => {
    const options: SetupPanelOption[] = [
      { value: "model", label: "Change model", description: "The model your agent uses" },
      {
        value: "provider",
        label: "Configure model access",
        description: "How your agent reaches the model provider",
      },
    ];
    const rows = renderSelectQuestion(
      {
        kind: "stacked",
        message: "",
        options,
        select: initialSelectState({ options, defaultValue: "provider" }),
      },
      theme,
      80,
    );

    expect(rows.indexOf("     How your agent reaches the model provider")).toBe(
      rows.findIndex((row) => row.includes("▶ Configure model access")) + 1,
    );
    expect(rows.join("\n")).not.toContain("The model your agent uses");
  });

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
    expect(text).toContain("   ▶ Create a new project · fastest");
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

    expect(rows).toContain("   . Link an existing project");
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

    expect(text).toContain("   ▶ Link to another project ");
    expect(text).not.toContain("1.");

    const colored = renderSelectQuestion(
      {
        kind: "single",
        message: "Already linked to weather-agent in Acme",
        options: lone,
        select: initialSelectState({ options: lone }),
      },
      colorTheme,
      60,
    ).join("\n");
    expect(colored).toContain("\x1b[7m\x1b[34m ▶ Link to another project \x1b[39m\x1b[27m");
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
      { value: "done", label: "Done", trailingAction: true },
    ];
    const rows = renderSelectQuestion(
      {
        kind: "search",
        layout: "task-list",
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
    expect(rows).toContain("   ▷ Terminal UI · Already installed");
    expect(rows).not.toContain("   ✓ Terminal UI");
    // An unfocused completed row keeps its check.
    expect(rows).toContain("   ✓ Web Chat");
    expect(rows).toContain("     Done");
    const warning = rows.indexOf("  ⚠ Overwrote /tmp/weather-agent");
    const success = rows.indexOf("  ✓ Scaffolded channel: web");
    const done = rows.indexOf("     Done");
    expect(rows.indexOf("   ◦ Slack       · Creates slackbot and deploys to Vercel")).toBeLessThan(
      warning,
    );
    expect(warning).toBeLessThan(success);
    expect(success).toBeLessThan(done);
    expect([rows[warning - 1], rows[done - 1]]).toEqual(["", ""]);
    expect(rows.at(-1)).toContain("↑/↓ move · enter to select · esc to cancel");

    const coloredRows = renderSelectQuestion(
      {
        kind: "task-list",
        message: "Where will you chat with your agent?",
        options,
        select: initialSelectState({ options }),
      },
      colorTheme,
      80,
    );
    const coloredRow = coloredRows.find((row) => row.includes("Terminal UI"));
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
    expect(multi).toContain("   ▶ Create a new project ");
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

  it("renders a warning-toned disabled row with a dim label and yellow alert annotation", () => {
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

    // Dim label (SGR 2), un-struck, followed by the alert annotation in yellow (SGR 33).
    expect(text).toContain(
      "\x1b[2mSlack\x1b[22m\x1b[33m ⚠ Requires Vercel account, see /model\x1b[39m",
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

    // The reason sits under the row, indented to the label column, not as an
    // inline parenthetical.
    expect(text).toContain("Change model\n     Disabled here");
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

  it("renders the hovered editable row with the default as a placeholder", () => {
    const options = [
      { value: "new", label: "Create a new project", hint: "Name: weather-agent" },
      { value: "link", label: "Link an existing project" },
    ];
    const renameEditor = (editor: ReturnType<typeof lineOf>) =>
      ({
        kind: "rename",
        editor,
        defaultValue: "weather-agent",
        formatHint: (value: string) => `Name: ${value}`,
      }) as const;
    const baseEdit = { optionValue: "new", caretVisible: true };

    // Hovering the editable row leaves the real buffer empty and parks the
    // caret before the suggested name, so typing replaces the placeholder.
    const hover = renderSelectQuestion(
      {
        kind: "inline-edit",
        layout: "task-list",
        message: "Vercel project",
        options,
        select: initialSelectState({ options }),
        edit: { ...baseEdit, editor: renameEditor(lineOf("")) },
      },
      colorTheme,
      80,
    );
    expect(stripAnsi(hover.join("\n"))).toContain("Name: weather-agent");
    expect(hover.join("\n")).toContain(colorTheme.colors.inverse("w"));
    expect(hover.join("\n")).not.toContain("Name: \x1b[22mweather-agent");
    expect(hover.at(-1)).toContain("type to rename");

    // Caret off (blink) collapses to nothing — no stray space before the placeholder.
    const hoverOff = renderSelectQuestion(
      {
        kind: "inline-edit",
        layout: "task-list",
        message: "Vercel project",
        options,
        select: initialSelectState({ options }),
        edit: { ...baseEdit, caretVisible: false, editor: renameEditor(lineOf("")) },
      },
      colorTheme,
      80,
    );
    expect(stripAnsi(hoverOff.join("\n"))).toContain("Name: weather-agent");
    expect(stripAnsi(hover.join("\n"))).toBe(stripAnsi(hoverOff.join("\n")));

    // Entered text keeps a trailing cursor cell, so the cursor follows rather
    // than covers the final character and blinking does not shift the text.
    const edited = renderSelectQuestion(
      {
        kind: "inline-edit",
        layout: "task-list",
        message: "Vercel project",
        options,
        select: initialSelectState({ options }),
        edit: { ...baseEdit, editor: renameEditor(lineOf("weather-fixtur")) },
      },
      colorTheme,
      80,
    );
    expect(stripAnsi(edited.join("\n"))).toContain("Name: weather-fixtur");
    expect(edited.join("\n")).toContain("Name: \x1b[22mweather-fixtu");
    expect(edited.join("\n")).toContain(colorTheme.colors.inverse(" "));

    const editedOff = renderSelectQuestion(
      {
        kind: "inline-edit",
        layout: "task-list",
        message: "Vercel project",
        options,
        select: initialSelectState({ options }),
        edit: {
          ...baseEdit,
          caretVisible: false,
          editor: renameEditor(lineOf("weather-fixtur")),
        },
      },
      colorTheme,
      80,
    );
    expect(stripAnsi(edited.join("\n"))).toBe(stripAnsi(editedOff.join("\n")));
  });

  it("keeps a long masked key's inline failure visible within a narrow panel", () => {
    const options = [
      {
        value: "own-key",
        label: "AI Gateway via AI_GATEWAY_API_KEY",
        hint: ">  type your key",
      },
    ];
    const width = 44;
    const rows = renderSelectQuestion(
      {
        kind: "inline-edit",
        layout: "stacked",
        message: "Provider",
        options,
        select: initialSelectState({ options }),
        edit: {
          optionValue: "own-key",
          caretVisible: false,
          editor: {
            kind: "key",
            phase: {
              kind: "invalid",
              editor: lineOf(`sk-${"x".repeat(80)}`),
              message: "The AI Gateway rejected this key.",
            },
          },
        },
      },
      colorTheme,
      width,
    );
    const row = rows.find((line) => line.includes("API key is not valid"));
    const plain = stripAnsi(row ?? "");

    expect(plain).toContain("…");
    expect(plain).toContain("⨯ API key is not valid");
    // The masked input rides the elbow rail.
    expect(plain).toContain("⎿ ");
    expect(plain.length).toBeLessThanOrEqual(width);
    // The failure trails the masked key in plain red — no background.
    expect(row).toContain(colorTheme.colors.red(`${colorTheme.glyph.error} API key is not valid`));
  });

  it("hides the rename cursor and hint when the cursor is off the editable row", () => {
    const options = [
      { value: "new", label: "Create a new project", hint: "Name: weather-agent" },
      { value: "link", label: "Link an existing project" },
    ];
    const rows = renderSelectQuestion(
      {
        kind: "inline-edit",
        layout: "task-list",
        message: "Vercel project",
        options,
        // Cursor parked on the second (non-editable) row.
        select: { ...initialSelectState({ options }), cursor: 1 },
        edit: {
          optionValue: "new",
          caretVisible: true,
          editor: {
            kind: "rename",
            editor: lineOf(""),
            defaultValue: "weather-agent",
            formatHint: (value: string) => `Name: ${value}`,
          },
        },
      },
      theme,
      80,
    );
    // The editable row shows its plain static hint — no caret injected.
    expect(rows.join("\n")).toContain("Name: weather-agent");
    expect(rows.join("\n")).not.toContain("weather-agent▏");
    expect(rows.at(-1)).not.toContain("type to rename");
  });

  it("stacks hints under labels with separators and trailing notices", () => {
    const options = [
      { value: "model", label: "Change model", hint: "anthropic/claude-sonnet-5" },
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
      "   ▶ Change model ",
      "     anthropic/claude-sonnet-5",
      "",
      "   ◦ Change provider",
      "     AI Gateway (Linked to my-agent)",
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
    const options: SetupPanelOption[] = [
      { value: "model", label: "Change model" },
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

  it("uses the terminal foreground for a selected yellow hint and dims it otherwise", () => {
    const hint = colorTheme.colors.yellow("Not configured");
    const options: SetupPanelOption[] = [
      { value: "model", label: "Change model" },
      {
        value: "provider",
        label: "Configure model access",
        hint,
      },
    ];
    const selectedRows = renderSelectQuestion(
      {
        kind: "stacked",
        message: "",
        options,
        select: initialSelectState({ options, defaultValue: "provider" }),
      },
      colorTheme,
      80,
    );
    const unselectedRows = renderSelectQuestion(
      {
        kind: "stacked",
        message: "",
        options,
        select: initialSelectState({ options, defaultValue: "model" }),
      },
      colorTheme,
      80,
    );

    expect(selectedRows).toContain("     Not configured");
    expect(selectedRows).not.toContain(`     ${hint}`);
    expect(unselectedRows).toContain(`     ${colorTheme.colors.dim(hint)}`);
  });

  it("keeps a blue accent span inside the selected row's hint", () => {
    const hint = `xai/grok-4.5${colorTheme.colors.blue("@high ↯")}`;
    const options: SetupPanelOption[] = [
      { value: "model", label: "Change model", hint },
      { value: "done", label: "Done" },
    ];
    const rows = renderSelectQuestion(
      {
        kind: "stacked",
        message: "",
        options,
        select: initialSelectState({ options, defaultValue: "model" }),
      },
      colorTheme,
      80,
    );

    // Blue survives the cursor row's foreground normalization; other authored
    // colors (see the yellow test above) still strip.
    expect(rows).toContain(`     xai/grok-4.5${colorTheme.colors.blue("@high ↯")}`);
  });

  it("keeps a warning row yellow under the cursor highlight", () => {
    const options: SetupPanelOption[] = [
      {
        value: "provider",
        label: "Configure model access",
        accent: "warning",
      },
    ];
    const rows = renderSelectQuestion(
      {
        kind: "stacked",
        message: "",
        options,
        select: initialSelectState({ options }),
      },
      colorTheme,
      80,
    );

    expect(rows).toContain(
      `  ${colorTheme.colors.inverse(colorTheme.colors.yellow(" ▶ Configure model access "))}`,
    );
  });

  it("renders each line of a stacked hint beneath its option", () => {
    const options = [
      {
        value: "project",
        label: "AI Gateway via Project",
        hint: "Authenticates with AI Gateway automatically\nin a new or existing project. No keys to manage.",
      },
    ];
    const rows = renderSelectQuestion(
      {
        kind: "stacked",
        message: "Which model provider do you want to use?",
        options,
        select: initialSelectState({ options }),
      },
      theme,
      80,
    );

    expect(rows).toContain("     Authenticates with AI Gateway automatically");
    expect(rows).toContain("     in a new or existing project. No keys to manage.");
    expect(rows.every((row) => !row.includes("\n"))).toBe(true);
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

    expect(text).toContain("▶ Create a new project");
    expect(text).toContain("✓ Link an existing project");
    expect(text).toContain("Submit");
    expect(text).toContain("space to toggle");
  });

  it("windows the railed list to five rows with an Esc-only footer", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      value: `model-${index}`,
      label: `Model ${index}`,
    }));
    const rows = renderSelectQuestion(
      {
        kind: "search",
        message: "Which model?",
        options: many,
        placeholder: "type to filter",
        select: initialSelectState({ options: many }),
      },
      theme,
      60,
    );
    const text = rows.join("\n");

    // The filter rail sits in the option rows' glyph column.
    expect(text).toContain("   ▏ type to filter");
    expect(text).toContain("   ▶ Model 0");
    expect(text).toContain("   ▏ Model 4");
    expect(text).not.toContain("Model 5");
    // The list scrolls silently: no count row, Esc is the whole footer.
    expect(text).not.toContain("options, showing");
    expect(text).toContain("esc to cancel");
    expect(text).not.toContain("type to filter ·");
    expect(text).not.toContain("↑/↓ move");
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
    expect(retry).toContain(colorTheme.colors.inverse(colorTheme.colors.blue(" ▶ Try again ")));
  });
});

describe("renderTextQuestion", () => {
  it("paints the message, input line, and hints", () => {
    const rows = renderTextQuestion(
      { message: "Project name", editor: lineOf("my-agent"), mask: false },
      theme,
      60,
      true,
    );
    const text = rows.join("\n");

    expect(rows[0]).toBe("  Project name");
    expect(rows[1]).toContain("my-agent");
    expect(text).toContain("enter to submit · esc to cancel");
  });

  it("draws the blinking cursor as a block over the grapheme under it", () => {
    const rows = renderTextQuestion(
      { message: "Project name", editor: { text: "hello", cursor: 3 }, mask: false },
      colorTheme,
      60,
      true,
    );
    const input = rows[1] ?? "";

    expect(stripAnsi(input)).toBe("  hello");
    expect(input).toContain(colorTheme.colors.inverse("l"));
    expect(input).not.toContain(colorTheme.glyph.caret);
  });

  it("draws the block over the first placeholder grapheme", () => {
    const rows = renderTextQuestion(
      {
        message: "API key",
        editor: lineOf(""),
        mask: true,
        placeholder: "type your key",
      },
      colorTheme,
      60,
      true,
    );
    const input = rows[1] ?? "";

    expect(stripAnsi(input)).toBe("  type your key");
    expect(input).toContain(colorTheme.colors.inverse("t"));
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

  it("masks one bullet per grapheme", () => {
    const text = renderTextQuestion(
      { message: "API key", editor: lineOf("e\u0301👨‍👩‍👧‍👦"), mask: true },
      theme,
      60,
      false,
    ).join("\n");

    expect(text).toContain("••");
    expect(text).not.toContain("•••");
    expect(text).not.toContain("👨");
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

describe("renderModelEditorQuestion", () => {
  // Editor requests carry id-labeled rows (the flow's modelListRows mapping).
  const MODEL_IDS = [
    "anthropic/claude-sonnet-5",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
    "xai/grok-4.5",
    "google/gemini-3.5",
    "zai/glm-4.6",
    "meta/llama-5",
    "mistral/large-3",
    "cohere/command-b",
  ];
  const MODELS = MODEL_IDS.map((id, index) =>
    index < 2 ? { value: id, label: id, featured: true } : { value: id, label: id },
  );

  const CAPS = {
    reasoning: true,
    reasoningLevels: ["low", "medium", "high"],
    fastMode: true,
  } as const;

  function editorRequest(overrides = {}) {
    return {
      model: { kind: "pick", options: MODELS, current: "anthropic/claude-sonnet-5" },
      reasoning: null,
      serviceTier: { kind: "standard" },
      settingsEditable: true,
      externalRouting: false,
      capabilitiesFor: () => CAPS,
      ...overrides,
    } as never;
  }

  function editorState(overrides = {}) {
    return {
      screen: { kind: "menu", cursor: "model" },
      draft: { modelId: "anthropic/claude-sonnet-5", reasoning: "medium", tier: "standard" },
      capabilities: CAPS,
      ...overrides,
    } as never;
  }

  it("paints the value menu with a hint line per row and a bare Done", () => {
    const text = renderModelEditorQuestion(
      { request: editorRequest(), state: editorState() },
      theme,
      80,
    ).join("\n");

    expect(text).toContain("▶ Model");
    expect(text).toContain("anthropic/claude-sonnet-5");
    expect(text).toContain("Reasoning effort");
    // The mini track rides the hint: value first, notches joined by ━.
    expect(text).toContain("●─◉─○ medium");
    expect(text).toContain("Service tier");
    expect(text).toContain("normal");
    expect(text).toContain("Done");
    expect(text).toContain("↑/↓ move");
  });

  it("summarizes a fast-mode draft and an unset level on the menu hints", () => {
    const text = renderModelEditorQuestion(
      {
        request: editorRequest(),
        state: editorState({
          draft: { modelId: "anthropic/claude-sonnet-5", reasoning: "default", tier: "priority" },
        }),
      },
      theme,
      80,
    ).join("\n");

    expect(text).toContain("○─○─○ provider default");
    expect(text).toContain("fast ↯");
  });

  it("paints the hovered row's covered track stretch blue", () => {
    const text = renderModelEditorQuestion(
      {
        request: editorRequest(),
        state: editorState({ screen: { kind: "menu", cursor: "reasoning" } }),
      },
      colorTheme,
      80,
    ).join("\n");

    expect(text).toContain(`${colorTheme.colors.blue("●─◉")}─○`);
  });

  it("disables the reasoning row with its reason and omits the tier for a no-frills model", () => {
    const noFrills = { reasoning: false, reasoningLevels: [], fastMode: false };
    const text = renderModelEditorQuestion(
      {
        request: editorRequest(),
        state: editorState({
          capabilities: noFrills,
          draft: { modelId: "test/no-frills", reasoning: "default", tier: "standard" },
        }),
      },
      theme,
      80,
    ).join("\n");

    expect(text).toContain("Not supported by the selected model");
    expect(text).not.toContain("Service tier");
  });

  it("lists model ids on a caret rail with an inverse cursor row and enter badge", () => {
    const rows = renderModelEditorQuestion(
      {
        request: editorRequest(),
        state: editorState({
          screen: {
            kind: "model",
            select: initialSelectState({ options: MODELS, defaultValue: "openai/gpt-5.6-sol" }),
          },
        }),
      },
      theme,
      80,
    );
    const text = rows.join("\n");

    expect(text).toContain("Select the model");
    expect(text).toContain("   ▏ type to search");
    expect(text).toContain(" ▶ openai/gpt-5.6-sol ");
    expect(text).toContain("↵");
    expect(text).toContain("   ▏ anthropic/claude-sonnet-5");
    // Five rows in view, no count row, Esc-only footer.
    expect(text).toContain("openai/gpt-5.6-luna");
    expect(text).not.toContain("google/gemini-3.5");
    expect(text).not.toContain("options, showing");
    expect(text).toContain("esc to cancel");
  });

  it("falls back to ASCII track glyphs without unicode", () => {
    const ascii = createTheme({ color: false, unicode: false });
    const text = renderModelEditorQuestion(
      {
        request: editorRequest(),
        state: editorState({ screen: { kind: "menu", cursor: "reasoning" } }),
      },
      ascii,
      80,
    ).join("\n");

    expect(text).toContain("*-O-. medium");
  });
});
