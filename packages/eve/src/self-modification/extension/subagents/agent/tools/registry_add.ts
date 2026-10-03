import { getLocalDevCapability, type LocalDevCapability } from "eve/local-dev";
import { defineTool } from "eve/tools";

import type { ResolvedSelfModificationConfig } from "../../../../config.js";
import { withSelfModificationWorkspaceLock } from "../../../../workspace-lock.js";
import { classifyCatalogEntry } from "../../../classify-registry-item.js";
import { runEveAdd, type SpawnLike } from "../../../eve-add.js";
import { defineLocalOnlyDynamic, resolveLocalOnly } from "../../../local-only.js";
import {
  loadRegistryIndex,
  resolveRegistryIndexUrl,
  type CatalogEntry,
} from "./search_registry.js";

/**
 * Local installation mutates the developer's project through `eve dev`. It may
 * hand setup-bearing items to the TUI or terminal, supports the configured
 * registry, and reports any local files that could not be restored on failure.
 */
const localInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    address: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Exact address of an item in the configured eve registry, for example `channel/slack` or `extension/browserbase`.",
    },
  },
  required: ["address"],
} as const;

const localOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["installed", "needs-terminal", "failed"] },
    address: { type: "string" },
    title: { type: "string" },
    envVars: {
      type: "array",
      items: { type: "string" },
      description:
        "Environment variables the item needs that are not set. The item is installed but will not work until the developer sets them. Never ask for or repeat their values.",
    },
    reason: { type: "string", description: "Why the item was not installed here." },
    changed: {
      type: "array",
      items: { type: "string" },
      description: "Project-relative paths a failed install could not restore.",
    },
    nextCommand: {
      type: "string",
      description: "The command that completes a `needs-terminal` item.",
    },
    message: { type: "string", description: "One-line summary to relay to the developer." },
  },
  required: ["status", "address", "message"],
} as const;

interface RegistryAddDependencies {
  readonly getCapability?: () => LocalDevCapability | undefined;
  readonly spawn?: SpawnLike;
}

/** What local registry installation reports back. Mirrors {@link localOutputSchema}. */
export interface LocalRegistryAddResult {
  readonly address: string;
  /** `failed` carries an explicit mutation outcome instead of implying nothing changed. */
  readonly status: "installed" | "needs-terminal" | "failed";
  readonly message: string;
  readonly title?: string;
  readonly envVars?: readonly string[];
  readonly reason?: string;
  readonly nextCommand?: string;
  readonly changed?: readonly string[];
}

/**
 * Names the item's declared environment variables that are not set.
 *
 * Naming a required variable is not a secret, and an installed item can still
 * be non-functional through unset variables, so this is the difference between
 * reporting outstanding work and reporting bare success. Values are never read.
 */
export function unsetEnvVars(
  entry: CatalogEntry,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  return (entry.envVars ?? []).filter((name) => {
    const value = environment[name];
    return value === undefined || value === "";
  });
}

/**
 * Builds the handoff a `needs-terminal` item carries.
 *
 * The interactive TUI consumes `status` and `address` to open the existing
 * address-specific setup flow itself, so its model-facing result deliberately
 * carries no command for the model to repeat. Headless `eve dev` has no TUI to
 * dispatch into, so the shell command is the only honest answer there.
 */
export function handoffMessage(input: {
  readonly address: string;
  readonly interactiveClient: boolean;
  readonly reason: string;
  readonly title: string;
}): { readonly message: string; readonly nextCommand?: string } {
  if (input.interactiveClient) {
    return {
      message: `${input.title} was not installed by this tool. ${input.reason} Continue in the setup panel that opens here; do not ask the developer to run another command.`,
    };
  }
  const nextCommand = `eve add ${input.address}`;
  return {
    message: `${input.title} was not installed. ${input.reason} Run \`${nextCommand}\` in a terminal to finish it.`,
    nextCommand,
  };
}

/** Exported for tests; the tool's `execute` delegates here. */
export async function addLocalRegistryItem(
  address: string,
  options: RegistryAddDependencies & { readonly signal?: AbortSignal } = {},
): Promise<LocalRegistryAddResult> {
  const capability = (options.getCapability ?? getLocalDevCapability)();
  if (capability === undefined) {
    throw new Error(
      "Registry items can only be installed while `eve dev` is running. Report the item address to the developer instead of installing it.",
    );
  }

  // Shares the catalog fetch and its five-minute cache with
  // `search_registry`, rather than reading the registry index twice.
  const entries = await loadRegistryIndex({
    nowMs: Date.now(),
    signal: options.signal,
    url: resolveRegistryIndexUrl(),
  });
  const entry = entries.find((candidate) => candidate.address === address);
  if (entry === undefined) {
    throw new Error(
      `No item in the configured eve registry is published at "${address}". Check the address before trying again.`,
    );
  }

  const classification = classifyCatalogEntry(entry);
  if (classification.kind === "self-modification-mount") {
    throw new Error(classification.reason);
  }
  if (classification.kind === "needs-terminal") {
    const handoff = handoffMessage({
      address,
      interactiveClient: capability.interactiveClient,
      reason: classification.reason,
      title: entry.title,
    });
    return {
      address,
      reason: classification.reason,
      status: "needs-terminal",
      title: entry.title,
      ...handoff,
    };
  }

  const outcome = await withSelfModificationWorkspaceLock(`local:${capability.appRoot}`, async () =>
    capability.withSuspendedSource(() =>
      runEveAdd({
        address,
        appRoot: capability.appRoot,
        signal: options.signal,
        spawn: options.spawn,
      }),
    ),
  );

  if (outcome.kind === "blocked") {
    const handoff = handoffMessage({
      address,
      interactiveClient: capability.interactiveClient,
      reason: outcome.message,
      title: entry.title,
    });
    return {
      address,
      reason: outcome.message,
      status: "needs-terminal",
      title: entry.title,
      ...handoff,
    };
  }
  if (outcome.kind === "failed") {
    if (outcome.changed === undefined) {
      return {
        address,
        status: "failed",
        title: entry.title,
        reason: outcome.message,
        message: outcome.message,
      };
    }
    return {
      address,
      status: "failed",
      title: entry.title,
      reason: outcome.message,
      message: outcome.message,
      changed: outcome.changed,
    };
  }

  const envVars = unsetEnvVars(entry);
  return {
    address,
    envVars: [...envVars],
    message:
      envVars.length === 0
        ? `Installed ${entry.title}.`
        : `Installed ${entry.title}. It will not work until ${envVars.join(", ")} ${envVars.length === 1 ? "is" : "are"} set.`,
    status: "installed",
    title: entry.title,
  };
}

function localRegistryAddTool() {
  return defineTool({
    description:
      "Install an item from the configured eve registry into this project. Items that need setup are handed to the local setup flow instead. Search first, then call this with the exact item address.",
    inputSchema: localInputSchema,
    outputSchema: localOutputSchema,
    async execute(input, ctx) {
      const { address } = input;
      if (typeof address !== "string" || address.length === 0) {
        throw new Error("address must be an exact item address from the configured eve registry.");
      }
      return await addLocalRegistryItem(address, { signal: ctx.abortSignal });
    },
  });
}

export function resolveRegistryAddTool(config: ResolvedSelfModificationConfig) {
  return resolveLocalOnly(config, localRegistryAddTool());
}

export default defineLocalOnlyDynamic(localRegistryAddTool());
