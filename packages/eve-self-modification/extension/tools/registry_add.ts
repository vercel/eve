import { getLocalDevCapability, type LocalDevCapability } from "eve/local-dev";
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";

import { classifyCatalogEntry } from "../classify-registry-item.js";
import { runEveAdd, type SpawnLike } from "../eve-add.js";
import { withAuthoredSourceLock } from "../source-lock.js";
import {
  loadRegistryIndex,
  resolveRegistryIndexUrl,
  type CatalogEntry,
} from "./search_registry.js";

const inputSchema = {
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

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["installed", "needs-terminal"],
      description:
        "`installed` means the item's files and dependencies are in the project. `needs-terminal` means nothing was installed.",
    },
    address: { type: "string" },
    title: { type: "string" },
    envVars: {
      type: "array",
      items: { type: "string" },
      description:
        "Environment variables the item needs that are not set. The item is installed but will not work until the developer sets them. Never ask for or repeat their values.",
    },
    reason: {
      type: "string",
      description: "Why the item was not installed here. Present only for `needs-terminal`.",
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

/** What the tool reports back. Mirrors {@link outputSchema}. */
export interface RegistryAddResult {
  readonly address: string;
  /** `installed` means files and dependencies landed; `needs-terminal` means nothing did. */
  readonly status: "installed" | "needs-terminal";
  readonly message: string;
  readonly title?: string;
  readonly envVars?: readonly string[];
  readonly reason?: string;
  readonly nextCommand?: string;
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
 * `/add <address>` (`runRegistryFlow`'s `initialAddress`) skips the category
 * and search screens and opens that item's confirmation directly, so an
 * interactive client is offered the address-specific command rather than bare
 * `/add`, which would make the developer re-find the item in the category
 * browser. Headless `eve dev` has no TUI to dispatch a slash command into, so
 * the shell command is the only honest answer there.
 */
export function handoffMessage(input: {
  readonly address: string;
  readonly interactiveClient: boolean;
  readonly reason: string;
  readonly title: string;
}): { readonly message: string; readonly nextCommand: string } {
  const nextCommand = input.interactiveClient
    ? `/add ${input.address}`
    : `eve add ${input.address}`;
  return {
    message: `${input.title} was not installed. ${input.reason} Run \`${nextCommand}\` ${input.interactiveClient ? "here" : "in a terminal"} to finish it.`,
    nextCommand,
  };
}

/** Exported for tests; the tool's `execute` delegates here. */
export async function addRegistryItem(
  address: string,
  options: RegistryAddDependencies & { readonly signal?: AbortSignal } = {},
): Promise<RegistryAddResult> {
  const capability = (options.getCapability ?? getLocalDevCapability)();
  if (capability === undefined) {
    throw new Error(
      "Registry items can only be installed while `eve dev` is running. Report the item address to the developer instead of installing it.",
    );
  }

  // Shares the catalog fetch and its five-minute cache with
  // `selfmod__search_registry`, rather than reading the registry index twice.
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

  const outcome = await withAuthoredSourceLock(() =>
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
    throw new Error(outcome.message);
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

export default defineTool({
  approval: once(),
  description:
    "Install an item from the configured eve registry into this project, for example `channel/slack` or `extension/browserbase`. Only items that need no setup are installed here; an item with a setup flow or multiple components is reported back with the command that completes it, and nothing is installed. Development only. Search first, then call this with the exact item address.",
  inputSchema,
  outputSchema,
  async execute(input, ctx) {
    const { address } = input;
    if (typeof address !== "string" || address.length === 0) {
      throw new Error("address must be an exact item address from the configured eve registry.");
    }
    return await addRegistryItem(address, { signal: ctx.abortSignal });
  },
});
