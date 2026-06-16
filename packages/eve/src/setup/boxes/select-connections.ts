import {
  catalogSlugs,
  CONNECTION_CATALOG,
  CUSTOM_CONNECTION_SLUG,
  effectiveProtocols,
  getCatalogEntry,
  isValidConnectionSlug,
  SUPPORTED_PROTOCOLS,
  type ConnectionInput,
  type ConnectionProtocol,
  type CustomConnectionInput,
} from "#setup/scaffold/index.js";
import { connectorServiceForEntry } from "#setup/scaffold/connections/catalog.js";
import type { ConnectionSelectOption } from "#setup/cli/index.js";

import { select, text, type Asker, type MultiSelectOption } from "../ask.js";
import type { ConnectionPlan, SetupState } from "../state.js";
import type { SetupBox } from "../step.js";

export const CONNECT_REQUIRES_VERCEL =
  "Authenticates through Vercel Connect, which needs a Vercel project. Re-run and choose to deploy to Vercel.";

const PROTOCOL_LABELS: Record<ConnectionProtocol, string> = {
  mcp: "MCP",
  openapi: "OpenAPI",
};

export interface SelectConnectionsOptions {
  /** Resolves the picker and custom sub-questions; the composed stack decides how. */
  asker: Asker;
  /**
   * Headless mode: skips the picker entirely unless `presetConnections` were
   * requested. Fixed at composition time (the same place the asker base is
   * chosen), since `gather` cannot read the mode off the asker.
   */
  headless?: boolean;
  /** Skip the picker and plan exactly these catalog slugs. */
  presetConnections?: string[];
}

/** Exported for tests: the picker rows derived from the curated catalog. */
export function buildCatalogOptions(
  disabledReasons: Readonly<Record<string, string>>,
): ConnectionSelectOption[] {
  const options: ConnectionSelectOption[] = CONNECTION_CATALOG.map((entry) => {
    const reason = disabledReasons[entry.slug];
    return reason === undefined
      ? { value: entry.slug, label: entry.label, hint: entry.hint }
      : {
          value: entry.slug,
          label: entry.label,
          hint: entry.hint,
          disabled: true,
          disabledReason: reason,
        };
  });
  return options;
}

function unknownSlugError(rawSlug: string): Error {
  return new Error(
    `Unknown connection "${rawSlug}". Known: ${catalogSlugs().join(", ")}, or pass a custom name with a definition.`,
  );
}

function assertSupportedProtocols(
  effective: readonly ConnectionProtocol[],
  label: string,
): asserts effective is readonly [ConnectionProtocol, ...ConnectionProtocol[]] {
  if (effective.length === 0) {
    throw new Error(
      `No supported protocol for "${label}". Supported: ${SUPPORTED_PROTOCOLS.join(", ")}.`,
    );
  }
}

async function resolveProtocolInteractive(
  asker: Asker,
  declared: readonly ConnectionProtocol[] | undefined,
  label: string,
): Promise<ConnectionProtocol> {
  const effective = effectiveProtocols(declared);
  assertSupportedProtocols(effective, label);
  if (effective.length === 1) return effective[0];

  return asker.ask(
    select<ConnectionProtocol>({
      key: `protocol:${label}`,
      message: `Protocol for ${label}`,
      options: effective.map((protocol) => ({
        id: protocol,
        value: protocol,
        label: PROTOCOL_LABELS[protocol],
      })),
    }),
  );
}

function resolveProtocolHeadless(
  declared: readonly ConnectionProtocol[] | undefined,
  label: string,
): ConnectionProtocol {
  const effective = effectiveProtocols(declared);
  assertSupportedProtocols(effective, label);
  if (effective.length > 1) {
    throw new Error(
      `Connection "${label}" supports multiple protocols (${effective.join(", ")}). Pass --protocol to choose one.`,
    );
  }
  return effective[0];
}

/**
 * How the connector for a Connect-backed entry gets provisioned. Interactive
 * runs provision through Connect (browser OAuth); headless runs print the
 * `vercel connect create` command instead. An underivable service degrades to
 * a manual instruction either way.
 */
function deriveProvision(entry: ConnectionInput, headless: boolean): ConnectionPlan["provision"] {
  if (entry.auth?.kind !== "connect") return { kind: "none" };
  const service = connectorServiceForEntry({ mcp: entry.mcp, auth: entry.auth });
  if (service === undefined) return { kind: "connect-manual" };
  return headless ? { kind: "command-hint", service } : { kind: "connect", service };
}

async function promptCustomSlug(asker: Asker): Promise<string> {
  return asker.ask(
    text({
      key: "connection-name",
      message: "Connection name",
      placeholder: "mycorp",
      validate: (value) => {
        const trimmed = value.trim();
        if (trimmed.length === 0) return "A name is required.";
        if (!isValidConnectionSlug(trimmed)) {
          return "Start with a lowercase letter; use only lowercase letters, digits, and hyphens (max 64 characters).";
        }
        return null;
      },
    }),
  );
}

async function planCustomInteractive(asker: Asker, slug: string): Promise<ConnectionPlan> {
  const protocol = await resolveProtocolInteractive(asker, undefined, slug);
  const description = await asker.ask(
    text({
      key: `description:${slug}`,
      message: `Description for ${slug}`,
      placeholder: "What this connection exposes",
    }),
  );

  if (protocol === "mcp") {
    const url = await asker.ask(
      text({
        key: `mcp-url:${slug}`,
        message: `MCP server URL for ${slug}`,
        placeholder: "https://mcp.example.com/sse",
        validate: (value) => (value.trim().length === 0 ? "A URL is required." : null),
      }),
    );
    const entry: CustomConnectionInput = {
      slug,
      description,
      protocols: ["mcp"],
      mcp: { url: url.trim() },
      auth: { kind: "connect", connector: slug },
    };
    return { slug, protocol, entry, provision: deriveProvision(entry, false) };
  }

  const spec = await asker.ask(
    text({
      key: `openapi-spec:${slug}`,
      message: `OpenAPI spec URL for ${slug}`,
      placeholder: "https://api.example.com/openapi.json",
      validate: (value) => (value.trim().length === 0 ? "A spec URL is required." : null),
    }),
  );
  const baseUrl = await asker.ask(
    text({
      key: `openapi-base-url:${slug}`,
      message: `Base URL for ${slug} (optional)`,
      placeholder: "https://api.example.com",
    }),
  );
  const openapi =
    baseUrl.trim().length > 0
      ? { spec: spec.trim(), baseUrl: baseUrl.trim() }
      : { spec: spec.trim() };
  const entry: CustomConnectionInput = {
    slug,
    description,
    protocols: ["openapi"],
    openapi,
    auth: { kind: "connect", connector: slug },
  };
  return { slug, protocol, entry, provision: deriveProvision(entry, false) };
}

async function planSelectionInteractive(asker: Asker, rawSlug: string): Promise<ConnectionPlan> {
  if (rawSlug === CUSTOM_CONNECTION_SLUG) {
    const slug = (await promptCustomSlug(asker)).trim();
    return planCustomInteractive(asker, slug);
  }

  const entry = getCatalogEntry(rawSlug);
  if (entry !== undefined) {
    const protocol = await resolveProtocolInteractive(asker, entry.protocols, rawSlug);
    return { slug: rawSlug, protocol, entry, provision: deriveProvision(entry, false) };
  }

  if (!isValidConnectionSlug(rawSlug)) {
    throw unknownSlugError(rawSlug);
  }
  return planCustomInteractive(asker, rawSlug);
}

function planPresetHeadless(rawSlug: string): ConnectionPlan {
  if (rawSlug === CUSTOM_CONNECTION_SLUG) {
    throw new Error("Custom connection requires interactive input or a preset definition.");
  }

  const entry = getCatalogEntry(rawSlug);
  if (entry !== undefined) {
    return {
      slug: rawSlug,
      protocol: resolveProtocolHeadless(entry.protocols, rawSlug),
      entry,
      provision: deriveProvision(entry, true),
    };
  }

  if (!isValidConnectionSlug(rawSlug)) {
    throw unknownSlugError(rawSlug);
  }
  throw new Error(
    `Custom connection "${rawSlug}" requires interactive input or a preset definition.`,
  );
}

/**
 * THE CONNECTION SELECTION BOX: part of the interview phase, before any
 * filesystem write. Offers the connection catalog (plus a custom MCP / OpenAPI
 * escape hatch through preset slugs) and resolves every prompt into
 * fully-specified {@link ConnectionPlan}s recorded on the state; the
 * add-connections box executes them after the scaffold and link. The full
 * catalog is selectable: the deployment decision comes later in the interview,
 * and the provisioning box resolves to Vercel when a Connect-backed selection
 * needs a project.
 */
export function selectConnections(
  options: SelectConnectionsOptions,
): SetupBox<SetupState, ConnectionPlan[], ConnectionPlan[]> {
  return {
    id: "select-connections",

    async gather(): Promise<ConnectionPlan[]> {
      const headless = options.headless ?? false;
      const presets = options.presetConnections ?? [];

      // Headless maps presets to plans without prompting (and refuses an
      // ambiguous protocol with a flag hint), or skips entirely when no preset
      // was requested.
      if (headless) {
        return presets.map((slug) => planPresetHeadless(slug));
      }

      // The preset short-circuits the picker but still flows through the
      // interactive planners (a catalog preset can still need a protocol pick),
      // so it stays a factory option rather than a withAnswers rung.
      let selected: string[];
      if (presets.length > 0) {
        selected = [...presets];
      } else {
        const pickerOptions: MultiSelectOption<string>[] = buildCatalogOptions({}).map(
          (option) => ({
            id: String(option.value),
            value: String(option.value),
            label: option.label,
            hint: option.hint,
            disabled: option.disabled,
            disabledReason: option.disabledReason,
          }),
        );
        selected = await options.asker.askMany<string>({
          key: "connection",
          message: "What should your agent connect to?",
          options: pickerOptions,
        });
      }

      const plans: ConnectionPlan[] = [];
      for (const rawSlug of selected) {
        plans.push(await planSelectionInteractive(options.asker, rawSlug));
      }
      return plans;
    },

    async perform({ input }): Promise<ConnectionPlan[]> {
      return input;
    },

    apply(state, payload) {
      return { ...state, connectionSelection: payload };
    },
  };
}
