import { sliceVisible, visibleLength } from "./terminal-text.js";
import type { Theme } from "./theme.js";
import type { LogDisplayMode } from "./log-display-mode.js";
import type { VercelStatusSnapshot } from "./vercel-status.js";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";

export interface StatusLineInput {
  /** Resolved model slug, e.g. "anthropic/claude-sonnet-4-6"; absent when `/eve/v1/info` failed. */
  model?: string;
  /** Preformatted token-flow segment (formatTokenFlow output), e.g. `↑ 394.4K ↓ 4.3K`. */
  tokens?: string;
  /**
   * Transient dev-TUI log-display mode shown after a Ctrl+L cycle, e.g.
   * `sandbox`. Rendered as a prominent leading `logs: <mode>` segment that
   * survives width degradation and can stand alone; absent once the hint times
   * out.
   */
  logLevel?: LogDisplayMode;
  /** Model endpoint readiness: external, or AI Gateway connected/not-connected. */
  endpoint?: ModelEndpointStatus;
  /** Workspace-scoped Vercel state; identity absent while unlinked or still resolving. */
  vercel?: VercelStatusSnapshot;
  theme: Theme;
  width: number;
}

/**
 * Builds the dev TUI's persistent one-row status line:
 *
 * `model  ·  tokens  ·  AI Gateway (project)  ·  /deploy pending`
 *
 * The model-endpoint segment folds in the linked project name when connected
 * (`AI Gateway (project)`), drops to a bare `AI Gateway` when connected without
 * a linked project, and goes yellow with a `⚠` when the gateway has no usable
 * credential. Everything else renders dim except the yellow action signals (a
 * pending deploy, the not-connected gateway). On narrow widths segments degrade
 * in order, the endpoint first and then the model, keeping tokens and the
 * pending-deploy marker longest. A transient `logs: <mode>` segment from a
 * Ctrl+L cycle leads the row when present and is kept longest of all. Segments
 * stay recoverable from the agent header in scrollback. Returns undefined when
 * no segment has content so callers skip the row.
 */
export function buildStatusLine(input: StatusLineInput): string | undefined {
  const { theme, width } = input;
  const c = theme.colors;

  const logLevel = input.logLevel === undefined ? undefined : c.cyan(`logs: ${input.logLevel}`);
  const model = input.model === undefined ? undefined : c.dim(input.model);
  const tokens = input.tokens === undefined ? undefined : c.dim(input.tokens);
  const pending = input.vercel?.pendingDeploy ? c.yellow("/deploy pending") : undefined;

  // The model-endpoint segment. Connected folds in the linked project name;
  // not-connected is the one actionable signal, so it goes yellow with a ⚠.
  const projectName = input.vercel?.identity?.projectName;
  const endpoint =
    input.endpoint === undefined
      ? undefined
      : input.endpoint.kind === "external"
        ? c.dim("External endpoint")
        : input.endpoint.connected
          ? c.dim(projectName === undefined ? "AI Gateway" : `AI Gateway (${projectName})`)
          : c.yellow(`${theme.glyph.warning} AI Gateway`);

  const separator = `  ${c.dim(theme.glyph.dot)}  `;
  const compose = (segments: ReadonlyArray<string | undefined>): string =>
    segments.filter((segment) => segment !== undefined).join(separator);

  // Descending fidelity; the first variant that fits wins. The transient
  // logs hint leads every variant and gets a stand-alone fallback, so a
  // Ctrl+L cycle is always visible even at a bare prompt or a narrow width.
  const variants = [
    compose([logLevel, model, tokens, endpoint, pending]),
    compose([logLevel, model, tokens, pending]),
    compose([logLevel, tokens, pending]),
    compose([logLevel]),
  ];

  if (variants[0]!.length === 0) return undefined;
  for (const variant of variants) {
    if (variant.length > 0 && visibleLength(variant) <= width) return variant;
  }
  // Nothing fits whole: clip the narrowest variant that still has content
  // (later variants can be empty, e.g. a model-only line has no tokens row).
  const narrowest = variants.findLast((variant) => variant.length > 0)!;
  return sliceVisible(narrowest, width);
}
