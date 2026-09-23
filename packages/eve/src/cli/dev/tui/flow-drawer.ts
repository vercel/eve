import type { Theme } from "./theme.js";
import { renderFlowPanel, type FlowPanelState } from "./setup-panel.js";

/** Temporary setup content enclosed by a drawer and its navigation controls. */
export interface FlowDrawer {
  readonly rows: string[];
  readonly controls: string[];
}

/** Frames an active setup flow above the terminal footer. */
export function renderFlowDrawer(state: FlowPanelState, theme: Theme, width: number): FlowDrawer {
  const content =
    state.content.kind === "question" && state.content.title === state.title
      ? { ...state.content, title: undefined }
      : state.content;
  const body = renderFlowPanel({ ...state, title: "", content }, theme, width);
  const footerStart = state.content.kind === "question" ? body.lastIndexOf("") : -1;
  const controls =
    footerStart === -1 ? [] : body.slice(footerStart + 1).map((row) => row.trimStart());
  const drawerBody = footerStart === -1 ? body : body.slice(0, footerStart);
  return { rows: frameDrawer(state.title, drawerBody, theme, width), controls };
}

/** Frames a transient command panel with the same rules as a setup flow. */
export function renderTransientDrawer(
  title: string,
  body: readonly string[],
  controls: readonly string[],
  theme: Theme,
  width: number,
): FlowDrawer {
  return {
    rows: frameDrawer(title, body, theme, width),
    controls: controls.map((control) => `  ${theme.colors.dim(control)}`),
  };
}

function frameDrawer(
  title: string,
  body: readonly string[],
  theme: Theme,
  width: number,
): string[] {
  const divider = theme.colors.dim(theme.glyph.dash.repeat(Math.max(1, width)));
  const drawerMark = theme.unicode ? "┃" : "|";
  const header = title.length === 0 ? [] : [` ${theme.colors.dim(`${drawerMark} ${title}`)}`, ""];
  return [divider, "", ...header, ...body, "", divider];
}
