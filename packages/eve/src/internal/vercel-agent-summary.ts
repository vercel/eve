/**
 * Public, versioned summary of an eve agent emitted by `eve`
 * during `eve build`.
 *
 * This schema is the stable contract between eve and Vercel platform
 * surfaces (eg. the dashboard's project overview card). It is intentionally
 * smaller and more conservative than the internal {@link CompiledAgentManifest}
 * — only fields safe to render in product UI live here, and the schema is
 * versioned independently of the internal compiler manifest.
 *
 * **Storage** — the file is written to {@link VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH}
 * (under the agent's `appRoot`, outside the Build Output API surface). On
 * Vercel deployments, the build container uploads it to a top-level S3
 * artifact at `<projectId>/<deploymentId>/eve_agent_summary.json` — the
 * same tier as `deploy_metadata.json` and `turbo_summary.json`, never
 * reachable from the public CDN. The dashboard reads it through the
 * dedicated `/v6/deployments/:id/files/eve-agent-summary` endpoint with
 * team-scoped authentication.
 *
 * **Privacy** — non-public by storage location. The summary contains
 * user-authored business logic (tool descriptions, connection URLs,
 * source paths, subagent prompts) and is never served on the deployment
 * URL because the public proxy only resolves URLs against `basepath/`.
 *
 * **Self-hosted setups** — the file exists at the same path on disk
 * (`<appRoot>/.eve/agent-summary.json`) and is consumed by whatever
 * HTTP layer the operator wires up.
 */

/**
 * Stable schema kind embedded in every emitted summary file.
 */
export const VERCEL_EVE_AGENT_SUMMARY_KIND = "vercel-eve-agent-summary" as const;

/**
 * Current public schema version. Bump only when adding required fields or
 * making semantic changes consumers must opt into. Adding optional fields
 * does not require a version bump.
 */
export const VERCEL_EVE_AGENT_SUMMARY_VERSION = 3;

/**
 * Output path (relative to the agent's `appRoot`) where eve writes the
 * summary file at build time.
 *
 * Lives under `.eve/` — the existing eve-internal cache namespace that
 * already holds `nitro/`, `nitro-output/`, `sandbox-cache/`, etc. (see
 * `packages/eve/src/internal/application/paths.ts`). Intentionally
 * outside `.vercel/output/` so the file is not part of the Build Output
 * API surface — the Vercel build container picks it up from this path
 * and uploads it to a top-level deployment artifact, matching how the
 * Turbo run summary works.
 */
export const VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH = ".eve/agent-summary.json";

/**
 * Display category eve exposes to the dashboard for one channel chip. Built
 * from the channel's reported {@link CompiledChannelDefinition.adapterKind}.
 */
export type VercelEveChannelType = "slack" | "http" | "webhook" | "unknown";

/**
 * Top-level agent identity used to label the dashboard card.
 */
export interface VercelEveAgentEntry {
  readonly name: string;
  readonly description?: string;
  readonly modelId: string;
}

/**
 * Authored agent instructions resolved at build time from the agent's
 * `instructions.md` or `instructions.{ts,cts,mts,js,cjs,mjs}` source.
 * Agents without authored instructions fall back to the framework default
 * and the summary's `instructions` field is `null`.
 *
 * The dashboard renders the markdown body verbatim, so the field carries
 * the full resolved content rather than a preview. For module-backed
 * sources the markdown is the result the module produced at build time,
 * not the module's source code.
 */
export interface VercelEveInstructionsEntry {
  /**
   * Logical path of the discovered instructions source, relative to the
   * agent root (eg. `instructions.md`).
   */
  readonly logicalPath: string;
  /**
   * How the instructions were authored. `markdown` is a literal markdown
   * file at the agent root; `module` is a TypeScript / JavaScript module
   * that produces the instructions at build time.
   */
  readonly sourceKind: "markdown" | "module";
  /** Resolved markdown body of the instructions. */
  readonly markdown: string;
}

export interface VercelEveScheduleEntry {
  readonly name: string;
  readonly cron: string;
  readonly logicalPath: string;
}

export interface VercelEveToolEntry {
  readonly name: string;
  readonly description: string;
  readonly logicalPath: string;
}

/**
 * Wire protocol the authored connection speaks, mirrored from the
 * compiled connection's `protocol` discriminator. `"mcp"` is a
 * {@link defineMcpClientConnection} server; `"openapi"` is a
 * {@link defineOpenAPIConnection} REST API. New primitives extend this
 * union when they ship.
 */
export type VercelEveConnectionType = "mcp" | "openapi";

export interface VercelEveConnectionEntry {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly logicalPath: string;
  readonly type: VercelEveConnectionType;
  /**
   * When the connection's auth is built by `connect()` from
   * `@vercel/connect/eve`, the connector identifier the author passed
   * (UID like `"oauth/mcp-linear-app"` or opaque `"scl_..."` form).
   * Dashboards use this to deep-link into the connector's settings page
   * — typically resolving UID → `scl_...` against
   * `GET /v6/connect/connectors` and building
   * `/[teamSlug]/[project]/connect/<scl_...>`.
   *
   * Omitted for connections backed by a raw MCP server, a static
   * token, or a custom `getToken` callback (anything not produced by
   * the Vercel Connect helper).
   */
  readonly vercelConnect?: {
    readonly connector: string;
  };
}

export interface VercelEveChannelEntry {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "WEBSOCKET";
  readonly urlPath: string;
  readonly type: VercelEveChannelType;
  /**
   * The raw `ChannelAdapter.kind` reported by the route, when present.
   * Useful when `type` is `"unknown"` and a consumer wants to render a
   * disambiguating label.
   */
  readonly adapterKind?: string;
  readonly logicalPath: string;
}

export interface VercelEveSandboxEntry {
  readonly logicalPath: string;
}

/**
 * One authored skill exposed to the dashboard.
 *
 * Skills are markdown procedures the model loads on demand through the
 * framework-owned `load_skill` tool. The summary lists the available
 * skills by `name` + `description` so the dashboard can render the
 * surface without pulling each skill's full markdown body. Consumers
 * that need the full content can drill in through a dedicated endpoint
 * later — this entry is intentionally an overview shape.
 *
 * `sourceKind` distinguishes flat markdown skills (`agent/skills/foo.md`),
 * module-backed skills (`agent/skills/foo.ts`), and packaged skills
 * (`agent/skills/foo/SKILL.md` with sibling `references/`, `assets/`,
 * `scripts/` directories).
 */
export interface VercelEveSkillEntry {
  readonly name: string;
  readonly description: string;
  readonly logicalPath: string;
  readonly sourceKind: "markdown" | "module" | "skill-package";
}

export interface VercelEveSubagentEntry {
  readonly name: string;
  readonly description: string;
  readonly logicalPath: string;
}

export interface VercelEveDiagnosticsSummary {
  readonly errors: number;
  readonly warnings: number;
}

/**
 * Versioned public summary of one eve agent, emitted into the Vercel Build
 * Output during `eve build` and ingested by Vercel as deployment metadata.
 */
export interface VercelEveAgentSummary {
  readonly kind: typeof VERCEL_EVE_AGENT_SUMMARY_KIND;
  readonly schemaVersion: typeof VERCEL_EVE_AGENT_SUMMARY_VERSION;
  /**
   * Version of the `eve` package that produced this summary,
   * for diagnostics. Format follows semver.
   */
  readonly generatorVersion: string;
  readonly agent: VercelEveAgentEntry;
  /**
   * Authored agent instructions, when declared. `null` when the agent
   * relies on the framework default.
   */
  readonly instructions: VercelEveInstructionsEntry | null;
  readonly schedules: readonly VercelEveScheduleEntry[];
  readonly tools: readonly VercelEveToolEntry[];
  readonly skills: readonly VercelEveSkillEntry[];
  readonly connections: readonly VercelEveConnectionEntry[];
  readonly channels: readonly VercelEveChannelEntry[];
  readonly sandbox: VercelEveSandboxEntry | null;
  readonly subagents: readonly VercelEveSubagentEntry[];
  readonly diagnostics: VercelEveDiagnosticsSummary;
}

/**
 * Normalizes a channel adapter's reported `kind` string to the closed set
 * the dashboard renders. Keeps the surface stable even when authors set a
 * custom `kind` on their adapter (eg. `"weather-slack"`).
 */
export function normalizeChannelKindForDisplay(
  adapterKind: string | undefined,
): VercelEveChannelType {
  if (typeof adapterKind !== "string" || adapterKind.length === 0) {
    return "unknown";
  }
  const lowered = adapterKind.toLowerCase();
  if (lowered === "slack" || lowered.includes("slack")) {
    return "slack";
  }
  if (lowered === "http") {
    return "http";
  }
  if (lowered.includes("webhook")) {
    return "webhook";
  }
  return "unknown";
}
