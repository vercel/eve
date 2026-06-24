import { describe, expect, it } from "vitest";

import {
  dismissTypeahead,
  inlineCommandHint,
  isTypeaheadOpen,
  moveTypeaheadSelection,
  renderCommandSuggestions,
  selectedTypeaheadCommand,
  typeaheadCompletion,
  typeaheadFor,
} from "./command-typeahead.js";
import { PROMPT_COMMANDS, type PromptCommandSpec } from "./prompt-commands.js";
import { stripAnsi } from "./terminal-text.js";
import { createTheme } from "./theme.js";

const theme = createTheme({ color: false, unicode: true });

function spec(name: string, options?: Partial<PromptCommandSpec>): PromptCommandSpec {
  return {
    name,
    aliases: [],
    description: `${name} command`,
    takesArgument: false,
    build: () => ({ type: "new" }),
    ...options,
  };
}

const COMMANDS = [
  spec("help"),
  spec("model", { takesArgument: true, argumentHint: "[provider/model]" }),
  spec("deploy"),
  spec("exit", { aliases: ["quit"] }),
];

describe("typeaheadFor", () => {
  it("matches every command on a bare slash", () => {
    const state = typeaheadFor(COMMANDS, "/");
    expect(state.matches).toHaveLength(COMMANDS.length);
    expect(isTypeaheadOpen(state)).toBe(true);
  });

  it("narrows by name prefix", () => {
    const state = typeaheadFor(COMMANDS, "/mo");
    expect(state.matches.map((match) => match.name)).toEqual(["model"]);
  });

  it("matches aliases and keeps an exact match open", () => {
    expect(typeaheadFor(COMMANDS, "/q").matches.map((match) => match.name)).toEqual(["exit"]);
    const exact = typeaheadFor(COMMANDS, "/exit");
    expect(exact.matches.map((match) => match.name)).toEqual(["exit"]);
    expect(isTypeaheadOpen(exact)).toBe(true);
  });

  it("offers nothing for plain text, arguments, or empty input", () => {
    expect(typeaheadFor(COMMANDS, "hello").matches).toHaveLength(0);
    expect(typeaheadFor(COMMANDS, "/model x").matches).toHaveLength(0);
    expect(typeaheadFor(COMMANDS, "").matches).toHaveLength(0);
    expect(typeaheadFor(COMMANDS, "/nope").matches).toHaveLength(0);
  });

  it("preserves the highlighted command while narrowing", () => {
    let state = typeaheadFor(COMMANDS, "/");
    state = moveTypeaheadSelection(moveTypeaheadSelection(state, 1), 1);
    expect(selectedTypeaheadCommand(state)?.name).toBe("deploy");
    state = typeaheadFor(COMMANDS, "/de", state);
    expect(selectedTypeaheadCommand(state)?.name).toBe("deploy");
    expect(state.selectedIndex).toBe(0);
  });

  it("resets the highlight when the previous selection drops out", () => {
    let state = moveTypeaheadSelection(typeaheadFor(COMMANDS, "/"), 1);
    expect(selectedTypeaheadCommand(state)?.name).toBe("model");
    state = typeaheadFor(COMMANDS, "/e", state);
    expect(selectedTypeaheadCommand(state)?.name).toBe("exit");
    expect(state.selectedIndex).toBe(0);
  });
});

describe("dismissal", () => {
  it("closes the list and survives same-text re-derivation", () => {
    const dismissed = dismissTypeahead(typeaheadFor(COMMANDS, "/"));
    expect(isTypeaheadOpen(dismissed)).toBe(false);
    const repaint = typeaheadFor(COMMANDS, "/", dismissed);
    expect(isTypeaheadOpen(repaint)).toBe(false);
  });

  it("reopens once the text changes", () => {
    const dismissed = dismissTypeahead(typeaheadFor(COMMANDS, "/"));
    const edited = typeaheadFor(COMMANDS, "/m", dismissed);
    expect(isTypeaheadOpen(edited)).toBe(true);
  });
});

describe("inlineCommandHint", () => {
  it("returns the argument shape for a complete arg-taking command", () => {
    expect(inlineCommandHint(typeaheadFor(COMMANDS, "/model"))).toBe("[provider/model]");
  });

  it("returns an empty string for a complete argument-less command (still collapses)", () => {
    expect(inlineCommandHint(typeaheadFor(COMMANDS, "/help"))).toBe("");
  });

  it("matches a complete alias", () => {
    expect(inlineCommandHint(typeaheadFor(COMMANDS, "/quit"))).toBe("");
  });

  it("stays undefined for partial drafts, multiple matches, and dismissed lists", () => {
    expect(inlineCommandHint(typeaheadFor(COMMANDS, "/mod"))).toBeUndefined();
    expect(inlineCommandHint(typeaheadFor(COMMANDS, "/"))).toBeUndefined();
    expect(inlineCommandHint(dismissTypeahead(typeaheadFor(COMMANDS, "/model")))).toBeUndefined();
  });
});

describe("moveTypeaheadSelection", () => {
  it("wraps at both ends", () => {
    const state = typeaheadFor(COMMANDS, "/");
    expect(moveTypeaheadSelection(state, -1).selectedIndex).toBe(COMMANDS.length - 1);
    const last = { ...state, selectedIndex: COMMANDS.length - 1 };
    expect(moveTypeaheadSelection(last, 1).selectedIndex).toBe(0);
  });
});

describe("typeaheadCompletion", () => {
  it("appends a trailing space only for argument-taking commands", () => {
    expect(typeaheadCompletion(spec("channels"))).toBe("/channels");
    expect(typeaheadCompletion(spec("model", { takesArgument: true }))).toBe("/model ");
  });
});

describe("renderCommandSuggestions", () => {
  it("marks the highlighted row and shows aliases and descriptions, not argument hints", () => {
    const state = moveTypeaheadSelection(typeaheadFor(COMMANDS, "/"), 1);
    const colored = createTheme({ color: true, unicode: true });
    const rendered = renderCommandSuggestions(state, colored, 80);
    expect(rendered[1]).toContain(
      colored.colors.inverse(colored.colors.blue(` ${colored.glyph.selectedPointer} /model `)),
    );
    const rows = rendered.map(stripAnsi);
    expect(rows).toHaveLength(COMMANDS.length);
    expect(rows[0]?.startsWith("   /help")).toBe(true);
    expect(rows[1]?.startsWith(" ▶ /model ")).toBe(true);
    expect(rows[1]).toContain(theme.glyph.selectedPointer);
    expect(rows[0]).not.toContain(theme.glyph.selectedPointer);
    expect(rows[1]).toContain("/model");
    expect(rows[1]).toContain("model command");
    // The argument hint is held back for the inline exact-match view.
    expect(rows[1]).not.toContain("[provider/model]");
    expect(rows[3]).toContain("/exit (/quit)");
  });

  it("keeps aliases and descriptions fixed when the selected label gains padding", () => {
    const initial = typeaheadFor(COMMANDS, "/");
    const next = moveTypeaheadSelection(initial, 1);
    const helpSelected = renderCommandSuggestions(initial, theme, 80).map(stripAnsi);
    const helpUnselected = renderCommandSuggestions(next, theme, 80).map(stripAnsi);

    expect(helpSelected[0]?.indexOf("help command")).toBe(
      helpUnselected[0]?.indexOf("help command"),
    );

    const exitSelected = renderCommandSuggestions(
      moveTypeaheadSelection(initial, -1),
      theme,
      80,
    ).map(stripAnsi);
    expect(exitSelected[3]?.indexOf("(/quit)")).toBe(helpUnselected[3]?.indexOf("(/quit)"));
  });

  it("windows long lists around the highlight without a count row", () => {
    const many = Array.from({ length: 14 }, (_, index) => spec(`command-${index}`));
    const state = { ...typeaheadFor(many, "/"), selectedIndex: 13 };
    const rows = renderCommandSuggestions(state, theme, 80).map(stripAnsi);
    expect(rows).toHaveLength(10);
    expect(rows.some((row) => row.includes("command-13"))).toBe(true);
    expect(rows.some((row) => row.includes("command-0"))).toBe(false);
    expect(rows.some((row) => row.includes("commands, showing"))).toBe(false);
  });

  it("shows the whole command registry on a bare slash", () => {
    const state = typeaheadFor(PROMPT_COMMANDS, "/");
    const rows = renderCommandSuggestions(state, theme, 80).map(stripAnsi);
    expect(rows).toHaveLength(PROMPT_COMMANDS.length);
    expect(rows.some((row) => row.includes("/exit (/quit)"))).toBe(true);
  });

  it("clips rows to the terminal width", () => {
    const state = typeaheadFor(COMMANDS, "/");
    for (const row of renderCommandSuggestions(state, theme, 24)) {
      expect(stripAnsi(row).length).toBeLessThanOrEqual(24);
    }
  });

  it("renders the real registry on a bare slash with /help leading", () => {
    const state = typeaheadFor(PROMPT_COMMANDS, "/");
    const rows = renderCommandSuggestions(state, theme, 80).map(stripAnsi);
    expect(rows[0]).toContain("/help");
    expect(rows[0]).toContain(theme.glyph.selectedPointer);
  });
});
