import type { ToolApprovalContent } from "#public/tools/approval/content.js";
import { clipVisible, stripTerminalControls, wrapVisibleLine } from "#cli/ui/terminal-text.js";
import type { Theme } from "./theme.js";

type ApprovalContentMove = "down" | "end" | "home" | "page-down" | "page-up" | "up";

/** Stateful viewport for tool-provided approval review content. */
export class ApprovalContentPanel {
  readonly #content: ToolApprovalContent;
  #scroll = 0;
  #visible = true;

  constructor(content: ToolApprovalContent) {
    this.#content = content;
  }

  get visible(): boolean {
    return this.#visible;
  }

  close(): void {
    this.#visible = false;
  }

  open(): void {
    this.#visible = true;
  }

  move(action: ApprovalContentMove, pageSize: number, width: number, height: number): void {
    const maxScroll = this.#maxScroll(width, height);
    const scroll = Math.min(this.#scroll, maxScroll);
    switch (action) {
      case "down":
        this.#scroll = Math.min(maxScroll, scroll + 1);
        break;
      case "up":
        this.#scroll = Math.max(0, scroll - 1);
        break;
      case "page-down":
        this.#scroll = Math.min(maxScroll, scroll + Math.max(1, pageSize));
        break;
      case "page-up":
        this.#scroll = Math.max(0, scroll - Math.max(1, pageSize));
        break;
      case "home":
        this.#scroll = 0;
        break;
      case "end":
        this.#scroll = maxScroll;
        break;
    }
  }

  render(theme: Theme, width: number, height: number): string[] {
    const body = approvalContentRows(this.#content, width);
    const bodyHeight = Math.max(1, height - 3);
    const maxScroll = this.#maxScroll(width, height);
    const scroll = Math.min(Math.max(0, this.#scroll), maxScroll);
    const visibleBody = body.slice(scroll, scroll + bodyHeight);
    const firstVisible = body.length === 0 ? 0 : scroll + 1;
    const lastVisible = Math.min(body.length, scroll + visibleBody.length);
    const earlier = scroll > 0 ? "↑ earlier content" : undefined;
    const later = scroll < maxScroll ? "↓ more content" : undefined;
    const position = [earlier, later, `Viewing ${firstVisible}–${lastVisible} of ${body.length}`]
      .filter((part) => part !== undefined)
      .join(" · ");
    const c = theme.colors;
    return [
      c.dim(theme.glyph.hrule.repeat(Math.max(1, width))),
      ...visibleBody.map((line) => `  ${line}`),
      "",
      `  ${c.dim(position)}`,
    ].map((row) => clipVisible(row, width));
  }

  #maxScroll(width: number, height: number): number {
    return Math.max(0, approvalContentRows(this.#content, width).length - Math.max(1, height - 3));
  }
}

function approvalContentRows(content: ToolApprovalContent, width: number): string[] {
  return content.text.split(/\r?\n/u).flatMap((line) => {
    const safe = stripTerminalControls(line);
    return safe === "" ? [""] : wrapVisibleLine(safe, Math.max(1, width - 2));
  });
}
