import { describe, expect, test } from "vitest";

import type { PromptOption } from "./prompt-ui.js";
import { SelectComponent } from "./select-component.js";
import { initialSelectState, searchActionQuery, type SearchActionOption } from "./select-state.js";

const OPTIONS: PromptOption<string>[] = [
  { value: "web", label: "Web Chat" },
  { value: "slack", label: "Slack" },
];

/** Exposes the protected enter hook so its routing can be asserted directly. */
class TestSelect extends SelectComponent {
  shouldSubmit(): boolean {
    return this._shouldSubmit();
  }
}

function makeSelect(input: {
  multiple: boolean;
  search?: boolean;
  searchAction?: SearchActionOption;
  required?: boolean;
  options?: PromptOption<string>[];
}): TestSelect {
  const options = input.options ?? OPTIONS;
  return new TestSelect({
    options,
    multiple: input.multiple,
    search: input.search ?? false,
    searchAction: input.searchAction,
    required: input.required ?? false,
    initial: initialSelectState({ options, submitRow: input.multiple }),
    render: () => "",
  });
}

describe("SelectComponent enter routing", () => {
  test("single-select submits from any row", () => {
    const select = makeSelect({ multiple: false });
    expect(select.shouldSubmit()).toBe(true);
  });

  test("single-select does not submit a completed row", () => {
    const select = makeSelect({
      multiple: false,
      options: [{ value: "web", label: "Web Chat", completed: true }],
    });
    expect(select.shouldSubmit()).toBe(false);
  });

  test("multi-select enter on an option toggles it instead of submitting", () => {
    const select = makeSelect({ multiple: true });

    expect(select.shouldSubmit()).toBe(false);
    expect([...select.selectedSet]).toEqual(["web"]);

    // A second enter on the same row untoggles; the prompt still does not resolve.
    expect(select.shouldSubmit()).toBe(false);
    expect(select.selectedSet.size).toBe(0);
  });

  test("single-select search accepts spaces as filter characters", () => {
    const select = makeSelect({ multiple: false, search: true });

    select.emit("key", "w", { name: "w" });
    select.emit("key", " ", { name: "space" });
    select.emit("key", "c", { name: "c" });

    expect(select.filter).toBe("w c");
  });

  test("multi-select search keeps space as the toggle key, not a filter character", () => {
    const select = makeSelect({ multiple: true, search: true });

    select.emit("key", " ", { name: "space" });

    expect(select.filter).toBe("");
    expect([...select.selectedSet]).toEqual(["web"]);
  });

  test("search appends an action after matching options", () => {
    const select = makeSelect({
      multiple: false,
      search: true,
      options: [{ value: "veto", label: "veto" }],
      searchAction: { label: (query) => `Search for '${query}'` },
    });

    select.emit("key", "v", { name: "v" });

    const [match, action] = select.visibleOptions();
    expect(match?.label).toBe("veto");
    expect(action?.label).toBe("Search for 'v'");
    expect(searchActionQuery(action?.value ?? "")).toBe("v");
    select.optionCursor = 1;
    expect(select.shouldSubmit()).toBe(true);
  });

  test("the Submit row reads Skip until something is picked", () => {
    const select = makeSelect({ multiple: true });
    expect(select.submitLabel()).toBe("Skip");

    select.emit("key", " ", { name: "space" });
    expect(select.submitLabel()).toBe("Submit");

    select.emit("key", " ", { name: "space" });
    expect(select.submitLabel()).toBe("Skip");
  });

  test("required checklists and locked-only selections label the row honestly", () => {
    // Required: an empty confirm cannot resolve, so the row never says Skip.
    expect(makeSelect({ multiple: true, required: true }).submitLabel()).toBe("Submit");

    // A locked row is mandatory, not a pick: with nothing else marked, it is a skip.
    const withLocked = makeSelect({
      multiple: true,
      options: [
        { value: "web", label: "Web Chat" },
        { value: "tui", label: "Terminal UI", locked: true },
      ],
    });
    expect([...withLocked.selectedSet]).toEqual(["tui"]);
    expect(withLocked.submitLabel()).toBe("Skip");
  });

  test("multi-select enter submits only from the Submit row", () => {
    const select = makeSelect({ multiple: true });

    select.optionCursor = OPTIONS.length;
    expect(select.onSubmitRow()).toBe(true);
    expect(select.shouldSubmit()).toBe(true);
    // Submitting from the Submit row never toggles anything.
    expect(select.selectedSet.size).toBe(0);
  });
});
