import type { Theme } from "./theme.js";
import { sliceVisible, visibleLength } from "#cli/ui/terminal-text.js";
import { renderFlowPanel, type FlowPanelState } from "./setup-panel.js";

interface FlowDrawer {
  readonly rows: string[];
  readonly controls: string[];
}

export function renderFlowDrawer(state: FlowPanelState, theme: Theme, width: number): FlowDrawer {
  const body = renderFlowPanel({ ...state, title: "" }, theme, width);
  const footerStart = state.content.kind === "question" ? body.lastIndexOf("") : -1;
  const controls =
    footerStart === -1 ? [] : body.slice(footerStart + 1).map((row) => row.trimStart());
  const drawerBody = footerStart === -1 ? body : body.slice(0, footerStart);
  return { rows: frameDrawer(drawerBody, theme, width), controls };
}

export function renderTransientDrawer(
  body: readonly string[],
  controls: readonly string[],
  theme: Theme,
  width: number,
  corner?: string,
  compact = false,
  labelSide: "left" | "right" = "right",
): FlowDrawer {
  return {
    rows: frameDrawer(body, theme, width, corner, compact, labelSide),
    controls: controls.map((control) => `  ${theme.colors.dim(control)}`),
  };
}

function frameDrawer(
  body: readonly string[],
  theme: Theme,
  width: number,
  corner?: string,
  compact = false,
  labelSide: "left" | "right" = "right",
): string[] {
  const divider = theme.colors.dim(theme.glyph.dash.repeat(Math.max(1, width)));
  return [
    corner === undefined ? divider : labeledRule(corner, theme, width, labelSide),
    ...(compact ? [] : [""]),
    ...body,
    ...(compact ? [] : [""]),
    divider,
  ];
}

function labeledRule(label: string, theme: Theme, width: number, side: "left" | "right"): string {
  const dash = theme.glyph.dash;
  const room = width - 6;
  if (room < 1) return theme.colors.dim(dash.repeat(Math.max(1, width)));
  const text =
    visibleLength(label) <= room
      ? label
      : `${sliceVisible(label, room - visibleLength(theme.glyph.ellipsis))}${theme.glyph.ellipsis}`;
  const lead = width - visibleLength(text) - 4;
  return theme.colors.dim(
    side === "left"
      ? `${dash.repeat(2)} ${text} ${dash.repeat(lead)}`
      : `${dash.repeat(lead)} ${text} ${dash.repeat(2)}`,
  );
}
