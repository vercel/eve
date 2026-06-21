import type { SetupEditableRow } from "./editable-select.js";

/** Keyboard hints for the active select interaction. */
export function selectFooterHints(input: {
  edit: SetupEditableRow | undefined;
  selectedValue: string | undefined;
  filter: boolean;
  multiple: boolean;
}): string[] {
  const hints: string[] = [];
  let cancelHint = "esc to cancel";
  if (input.edit !== undefined && input.selectedValue === input.edit.optionValue) {
    const phase = input.edit.phase;
    const clearsFirst =
      input.edit.cancelBehavior === "clear-first" &&
      phase.kind !== "inactive" &&
      phase.editor.text.length > 0;
    if (clearsFirst) cancelHint = "esc to clear";
    if (phase.kind === "validating") return [cancelHint];
    hints.push(input.edit.footerHint ?? "type to edit");
  }
  if (input.filter) hints.push("type to filter");
  hints.push("↑/↓ move");
  hints.push(input.multiple ? "space to toggle" : "enter to select");
  if (input.multiple) hints.push("enter on Submit to confirm");
  hints.push(cancelHint);
  return hints;
}
