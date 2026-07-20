import { clipVisible, stripAnsi, visibleLength } from "#cli/ui/terminal-text.js";
import type { Theme } from "./theme.js";
import type { LogDisplayMode } from "./log-display-mode.js";
import type { RemoteConnectionSnapshot } from "./remote-connection.js";
import { remoteHost } from "./target.js";
import type { VercelStatusSnapshot } from "./vercel-status.js";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";
import { formatModelSummary } from "#shared/model-summary.js";

export interface StatusLineInput {
  /** Port of the connected local development server; omitted for remote sessions. */
  serverPort?: string;
  /** Resolved model slug, e.g. "anthropic/claude-sonnet-5"; absent when `/eve/v1/info` failed. */
  model?: string;
  /** Authored reasoning effort, rendered bold after the model id, e.g. `(xhigh)`. */
  reasoning?: string;
  /** True when the Gateway priority tier is on; renders a `»fast` marker. */
  fastMode?: boolean;
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
  input: Pick<StatusLineInput, "model" | "reasoning" | "fastMode" | "remote" | "theme">,
): string | undefined {
  if (input.model === undefined) return undefined;
  const c = input.theme.colors;
  const summary: Parameters<typeof formatModelSummary>[0] = { model: input.model };
  if (input.reasoning !== undefined) summary.reasoning = input.reasoning;
  if (input.fastMode === true) summary.fastGlyph = input.theme.glyph.fast;
  if (input.remote !== undefined) {
    // Sanitize the untrusted remote id before appending suffixes, so its
    // trailing whitespace is trimmed instead of collapsing into an interior
    // space ahead of the reasoning level.
    summary.model = stripAnsi(input.model).replace(/\s+/gu, " ").trim();
    const plain = stripAnsi(formatModelSummary(summary)).replace(/\s+/gu, " ").trim();
    return c.dim(plain);
  }
  return c.dim(formatModelSummary(summary));
}

function renderServerPort(
  input: Pick<StatusLineInput, "remote" | "serverPort" | "theme">,
): string | undefined {
  if (input.remote !== undefined || input.serverPort === undefined) return undefined;
  const c = input.theme.colors;
  return c.inverse(c.gray(` :${input.serverPort} `));
}

/** Provider slugs whose display name differs from the AI SDK's identifier. */
const EXTERNAL_PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  // `experimental_chatgpt` wraps the Codex backend; what the user connected
  // is their ChatGPT subscription, so the bar names that, not the transport.
  codex: "chatgpt-sub",
};

/**
 * The endpoint reads as the model's routing clause (`via ai-gateway(oidc:…)`),
 * so it fuses onto the model segment with a plain space instead of standing
 * behind a `·` separator. Only the disconnected warning stands alone. The
 * clause is keyed strictly off the credential the AI SDK will actually use —
 * an `api-key` never shows the linked project, because the link is not what
 * authenticates the call.
 */
function renderEndpoint(
  input: Pick<StatusLineInput, "endpoint" | "remote" | "theme" | "vercel">,
): { readonly text: string; readonly standalone: boolean } | undefined {
  if (input.remote !== undefined || input.endpoint === undefined) return undefined;

  const c = input.theme.colors;
  const g = input.theme.glyph;
  // Only the gateway stands at the terminal's DEFAULT foreground — plain,
  // not bold — while `via` and the credential scope stay dim around it;
  // external providers render fully quiet. Explicit bright-white (SGR 97)
  // would vanish on light themes.
  const clause = (name: string, suffix: string) => `${c.dim("via ")}${name}${c.dim(suffix)}`;
  if (input.endpoint.kind === "external") {
    const provider =
      EXTERNAL_PROVIDER_DISPLAY_NAMES[input.endpoint.provider] ?? input.endpoint.provider;
    // The `⌝` mark stays at the terminal's default foreground — full
    // intensity on any theme — while the clause around it is dim.
    return { text: `${c.dim(`via ${provider}`)}${g.external}`, standalone: false };
  }
  if (!input.endpoint.connected) {
    return { text: c.yellow(`${g.warning} ai-gateway`), standalone: true };
  }
  if (input.endpoint.credential === "api-key") {
    return { text: clause("ai-gateway", "(api-key)"), standalone: false };
  }
  const projectName = input.vercel?.identity?.projectName;
  const scope = projectName === undefined ? "oidc" : `oidc:${projectName}`;
  return { text: clause("ai-gateway", `(${scope})`), standalone: false };
}

/**
 * Builds a leading local `:port` or remote badge followed by the model (with
 * its reasoning level and Fast mode marker), endpoint, and deploy status
 * segments. Both badges are the final narrow-width fallback. Remote sessions
 * omit endpoint state. Returns undefined when every segment is empty.
 */
export function buildStatusLine(input: StatusLineInput): string | undefined {
  const { theme, width } = input;
  const c = theme.colors;

  const logLevel = input.logLevel === undefined ? undefined : c.cyan(`logs: ${input.logLevel}`);
  const serverPort = renderServerPort(input);
  const model = renderModel(input);
  const pending = input.vercel?.pendingDeploy ? c.yellow("/deploy pending") : undefined;
  const remote = input.remote === undefined ? undefined : formatRemoteStatus(input.remote, theme);
  const endpoint = renderEndpoint(input);
  const leading = remote?.full ?? serverPort;
  const badge = remote?.badge ?? serverPort;

  // A routing clause rides the model segment itself; the disconnected
  // warning (or a clause with no model to attach to) stays its own segment.
  const fused = endpoint !== undefined && !endpoint.standalone && model !== undefined;
  const modelSegment = fused ? `${model} ${endpoint.text}` : model;
  const endpointSegment = endpoint === undefined || fused ? undefined : endpoint.text;

  // Whitespace separators: the dim segments read as columns without bullets.
  const separator = "  ";
  const compose = (
    target: string | undefined,
    segments: ReadonlyArray<string | undefined>,
  ): string => {
    const body = segments.filter((segment) => segment !== undefined).join(separator);
    if (target === undefined || body.length === 0) return target ?? body;
    return `${target} ${body}`;
  };

  // Descending fidelity; the first variant that fits wins. The server badge
  // leads every variant and gets the final stand-alone fallback. Without one,
  // the logs hint retains its previous priority.
  const variants = [
    compose(leading, [logLevel, modelSegment, endpointSegment, pending]),
    compose(leading, [logLevel, model, pending]),
    compose(leading, [logLevel, pending]),
    compose(leading, [logLevel]),
    compose(badge, [logLevel]),
    compose(badge, []),
  ];

  if (variants[0]!.length === 0) return undefined;
  for (const variant of variants) {
    if (variant.length > 0 && visibleLength(variant) <= width) return variant;
  }
  // Later variants can be empty, for example when a badge-only line has no hint.
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
  // The badge carries its own trailing pad, so one space reads as a column gap.
  const separator = " ";
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
