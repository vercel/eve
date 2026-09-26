import { clipVisible, stripAnsi, visibleLength } from "#cli/ui/terminal-text.js";
import type { Theme } from "./theme.js";
import type { LogDisplayMode } from "./log-display-mode.js";
import type { RemoteConnectionSnapshot } from "./remote-connection.js";
import { remoteHost } from "./target.js";
import type { VercelStatusSnapshot } from "./vercel-status.js";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";
import { formatModelSummary } from "#shared/model-summary.js";

export interface DevBuildStatus {
  readonly phase: "building" | "complete";
  readonly summary: string;
}

function formatDevBuildStatus(status: DevBuildStatus, theme: Theme): string {
  const complete = status.phase === "complete";
  const glyph = complete ? theme.glyph.success : theme.glyph.validating;
  const summary = complete
    ? status.summary.replace(/ changed$/u, " updated")
    : `${status.summary.replace(/ (?:added|changed|removed)$/u, "")} updating…`;
  return `${glyph} ${summary}`;
}

interface StatusLineInput {
  /** Transient authored-source build state, independent of the server log filter. */
  devBuild?: DevBuildStatus;
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

/** Provider slugs whose display name differs from the AI SDK's identifier. */
const EXTERNAL_PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  // `chatgpt()` wraps the Codex backend; what the user connected is their
  // ChatGPT subscription, so the bar names that, not the transport.
  codex: "chatgpt-sub",
};

function renderEndpoint(
  input: Pick<StatusLineInput, "endpoint" | "remote" | "theme" | "vercel">,
): string | undefined {
  if (input.remote !== undefined || input.endpoint === undefined) return undefined;

  const c = input.theme.colors;
  const g = input.theme.glyph;
  const clause = (name: string, suffix: string) => `${name}${c.dim(suffix)}`;
  if (input.endpoint.kind === "external") {
    const provider =
      EXTERNAL_PROVIDER_DISPLAY_NAMES[input.endpoint.provider] ?? input.endpoint.provider;
    // The `⌝` mark stays at the terminal's default foreground — full
    // intensity on any theme — while the clause around it is dim.
    return `${c.dim(provider)}${g.external}`;
  }
  if (input.endpoint.kind === "chatgpt") {
    switch (input.endpoint.state) {
      case "ready":
        return `${c.dim("chatgpt-sub")}${g.external}`;
      case "checking":
        return c.dim("chatgpt-sub checking…");
      case "signed-out":
      case "reauth-required":
        return c.yellow(`${g.warning} chatgpt-sub login · /login`);
      case "unavailable":
        return c.yellow(`${g.warning} chatgpt-sub unavailable`);
    }
  }
  if (!input.endpoint.connected) {
    return c.yellow(`${g.warning} ai-gateway`);
  }
  if (input.endpoint.credential === "api-key") {
    return clause("ai-gateway", "(api-key)");
  }
  if (input.endpoint.credential === "oauth") {
    const slug = input.vercel?.modelTeamSlug;
    return c.dim(slug ? `Vercel · ${slug}` : "Vercel");
  }
  const projectName = input.vercel?.identity?.projectName;
  const scope = projectName === undefined ? "oidc" : `oidc:${projectName}`;
  return clause("ai-gateway", `(${scope})`);
}

/** Builds model and connection segments, preserving the remote badge at narrow widths. */
export function buildStatusLine(input: StatusLineInput): string | undefined {
  const { theme, width } = input;
  const c = theme.colors;

  const devBuild =
    input.devBuild === undefined ? undefined : formatDevBuildStatus(input.devBuild, theme);
  const logLevel = input.logLevel === undefined ? undefined : c.cyan(`logs: ${input.logLevel}`);
  const model = renderModel(input);
  const remote = input.remote === undefined ? undefined : formatRemoteStatus(input.remote, theme);
  const endpoint = renderEndpoint(input);
  const leading = remote?.full;
  const badge = remote?.badge;

  const separator = c.dim(" · ");
  const compose = (
    target: string | undefined,
    segments: ReadonlyArray<string | undefined>,
  ): string => {
    const body = segments.filter((segment) => segment !== undefined).join(separator);
    if (target === undefined || body.length === 0) return target ?? body;
    return `${target} ${body}`;
  };

  const leftVariants = [
    compose(leading, [logLevel, model, endpoint]),
    compose(leading, [logLevel, model]),
    compose(leading, [logLevel]),
    compose(badge, [logLevel]),
    compose(badge, []),
  ];

  if (devBuild !== undefined) {
    for (const left of leftVariants) {
      const leftWidth = visibleLength(left);
      const rightWidth = visibleLength(devBuild);
      const gap = leftWidth > 0 ? 2 : 0;
      if (leftWidth + gap + rightWidth > width) continue;
      return `${left}${" ".repeat(width - leftWidth - rightWidth)}${devBuild}`;
    }
    return clipVisible(devBuild, width);
  }

  if (leftVariants[0]!.length === 0) return undefined;
  for (const variant of leftVariants) {
    if (variant.length > 0 && visibleLength(variant) <= width) return variant;
  }
  // Later variants can be empty, for example when a badge-only line has no hint.
  const narrowest = leftVariants.findLast((variant) => variant.length > 0)!;
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
