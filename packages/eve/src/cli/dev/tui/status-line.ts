import { clipVisible, stripAnsi, visibleLength } from "./terminal-text.js";
import type { Theme } from "./theme.js";
import type { LogDisplayMode } from "./log-display-mode.js";
import type { RemoteConnectionSnapshot } from "./remote-connection.js";
import { remoteHost } from "./target.js";
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
  /** Remote server identity and its current connection/authentication state. */
  remote?: RemoteConnectionSnapshot;
  theme: Theme;
  width: number;
}

function renderModel(
  input: Pick<StatusLineInput, "model" | "remote" | "theme">,
): string | undefined {
  if (input.model === undefined) return undefined;
  const model =
    input.remote === undefined ? input.model : stripAnsi(input.model).replace(/\s+/gu, " ").trim();
  return input.theme.colors.dim(model);
}

function renderEndpoint(
  input: Pick<StatusLineInput, "endpoint" | "remote" | "theme" | "vercel">,
): string | undefined {
  if (input.remote !== undefined || input.endpoint === undefined) return undefined;

  const c = input.theme.colors;
  if (input.endpoint.kind === "external") return c.dim("External endpoint");
  if (!input.endpoint.connected) return c.yellow(`${input.theme.glyph.warning} AI Gateway`);

  const projectName = input.vercel?.identity?.projectName;
  return c.dim(projectName === undefined ? "AI Gateway" : `AI Gateway (${projectName})`);
}

/**
 * Builds `↗ project (environment) · model · tokens · /deploy pending`.
 * Remote sessions omit endpoint state and keep their badge as the final
 * narrow-width fallback. Returns undefined when every segment is empty.
 */
export function buildStatusLine(input: StatusLineInput): string | undefined {
  const { theme, width } = input;
  const c = theme.colors;

  const logLevel = input.logLevel === undefined ? undefined : c.cyan(`logs: ${input.logLevel}`);
  const model = renderModel(input);
  const tokens = input.tokens === undefined ? undefined : c.dim(input.tokens);
  const pending = input.vercel?.pendingDeploy ? c.yellow("/deploy pending") : undefined;
  const remote = input.remote === undefined ? undefined : formatRemoteStatus(input.remote, theme);
  const endpoint = renderEndpoint(input);

  const separator = `  ${c.dim(theme.glyph.dot)}  `;
  const compose = (segments: ReadonlyArray<string | undefined>): string =>
    segments.filter((segment) => segment !== undefined).join(separator);

  // Descending fidelity; the first variant that fits wins. The remote target
  // leads every variant and gets the final stand-alone fallback. Without a
  // remote, the logs hint retains its previous priority.
  const variants = [
    compose([remote?.full, logLevel, model, tokens, endpoint, pending]),
    compose([remote?.full, logLevel, model, tokens, pending]),
    compose([remote?.full, logLevel, tokens, pending]),
    compose([remote?.full, logLevel]),
    compose([remote?.badge, logLevel]),
    compose([remote?.badge]),
  ];

  if (variants[0]!.length === 0) return undefined;
  for (const variant of variants) {
    if (variant.length > 0 && visibleLength(variant) <= width) return variant;
  }
  // Later variants can be empty, for example when a model-only line has no tokens.
  const narrowest = variants.findLast((variant) => variant.length > 0)!;
  return clipVisible(narrowest, width);
}

function formatRemoteStatus(
  snapshot: RemoteConnectionSnapshot,
  theme: Theme,
): { readonly full: string; readonly badge: string } {
  const c = theme.colors;
  const label =
    snapshot.deployment === undefined
      ? remoteHost(snapshot.target)
      : `${snapshot.deployment.projectName} (${snapshot.deployment.environment})`;
  const arrow = theme.unicode ? "↗" : "->";
  const badge = formatRemoteBadge(` ${arrow} ${label} `, snapshot.connection.state, theme);
  const separator = ` ${c.dim(theme.glyph.dot)} `;
  let suffix: string | undefined;

  switch (snapshot.connection.state) {
    case "checking":
      suffix = c.dim("Checking access…");
      break;
    case "ready":
      break;
    case "auth-required":
      suffix = c.yellow("Authenticate via OIDC");
      break;
    case "authenticating":
      suffix = c.dim("Authenticating via OIDC…");
      break;
    case "auth-failed":
      suffix = c.yellow("Authentication failed");
      break;
    case "unavailable":
      suffix = c.yellow("Remote unavailable");
      break;
  }

  return {
    badge,
    full: suffix === undefined ? badge : `${badge}${separator}${suffix}`,
  };
}

function formatRemoteBadge(
  label: string,
  state: RemoteConnectionSnapshot["connection"]["state"],
  theme: Theme,
): string {
  const c = theme.colors;
  switch (state) {
    case "checking":
      return c.inverse(c.gray(label));
    case "ready":
      return c.inverse(c.blue(label));
    case "unavailable":
    case "auth-required":
    case "authenticating":
    case "auth-failed":
      return c.inverse(c.yellow(label));
  }
}
