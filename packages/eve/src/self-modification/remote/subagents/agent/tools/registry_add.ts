import { defineDynamic, defineTool, type ToolContext } from "eve/tools";

import { classifyCatalogEntry } from "../../../../extension/classify-registry-item.js";
import {
  loadRegistryIndex,
  officialRegistryIndexUrl,
} from "../../../../extension/subagents/agent/tools/search_registry.js";
import { readPreparedSelfModificationWorkspace } from "../../../../git-workspace.js";
import { isDeployedRuntime } from "../../../../mode.js";
import { withSelfModificationWorkspaceLock } from "../../../../workspace-lock.js";
import {
  resolveDeployedSelfModificationConfig,
  type ResolvedDeployedSelfModificationConfig,
} from "../../../config.js";
import selfModification from "../../../extension.js";
import {
  assertOfficialRegistryAddress,
  installProductionRegistryItem,
} from "../../../production-registry-add.js";

/**
 * Production installation mutates only the disposable proposal checkout. It is
 * restricted to the official registry, supports resumable non-secret setup and
 * external authorization boundaries, and reports paths destined for the draft
 * pull request rather than claiming that those changes are deployed.
 */
const productionInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    address: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Exact official eve registry address, for example `channel/slack` or `extension/browserbase`.",
    },
    answers: {
      type: "object",
      additionalProperties: true,
      description: "Non-secret answers to the setup question returned by the previous call.",
    },
    installed: {
      type: "boolean",
      description:
        "Set to true with answers when the previous input-required result installed the source.",
    },
  },
  required: ["address"],
} as const;

const productionOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["completed", "input-required", "external-action-required", "failed", "cancelled"],
    },
    address: { type: "string" },
    changedPaths: {
      type: "array",
      items: { type: "string" },
      description: "Repository-relative paths installed into the proposal.",
    },
    completedItems: { type: "array", items: { type: "string" } },
    deploymentRequired: { type: "boolean" },
    installed: {
      type: "boolean",
      description: "Whether source installation completed before setup paused.",
    },
    question: {
      type: "object",
      additionalProperties: true,
      description:
        "The current setup question. Supply only its non-secret answer on the next call.",
    },
    message: { type: "string" },
    url: { type: "string", description: "External authorization URL the developer must open." },
    userCode: { type: "string" },
  },
  required: ["status", "address"],
} as const;

type ProductionRegistryAddResult =
  | {
      readonly address: string;
      readonly status: "completed";
      readonly completedItems: readonly string[];
      readonly changedPaths: readonly string[];
      readonly deploymentRequired: boolean;
    }
  | {
      readonly address: string;
      readonly status: "input-required";
      readonly installed: boolean;
      readonly question: unknown;
    }
  | {
      readonly address: string;
      readonly status: "external-action-required";
      readonly installed: boolean;
      readonly message: string;
      readonly url: string;
      readonly userCode?: string;
    }
  | { readonly address: string; readonly status: "failed" | "cancelled"; readonly message: string };

async function addProductionRegistryItem(
  address: string,
  context: ToolContext,
  deployed: ResolvedDeployedSelfModificationConfig,
  continuation: {
    readonly answers?: Readonly<Record<string, unknown>>;
    readonly installed?: boolean;
  },
): Promise<ProductionRegistryAddResult> {
  assertOfficialRegistryAddress(address);
  const entries = await loadRegistryIndex({
    nowMs: Date.now(),
    signal: context.abortSignal,
    url: officialRegistryIndexUrl(),
  });
  const entry = entries.find((candidate) => candidate.address === address);
  if (entry === undefined) {
    throw new Error(`No official eve registry item is published at "${address}".`);
  }
  const classification = classifyCatalogEntry(entry);
  if (classification.kind === "self-modification-mount") {
    throw new Error(classification.reason);
  }
  const sandbox = await context.getSandbox();
  const result = await withSelfModificationWorkspaceLock(
    `sandbox:${context.session.id}`,
    async () => {
      const workspace = await readPreparedSelfModificationWorkspace({ ...deployed, sandbox });
      return await installProductionRegistryItem({
        address,
        answers: continuation.answers,
        installed: continuation.installed,
        sandbox,
        signal: context.abortSignal,
        workspace,
      });
    },
  );
  if (result.kind === "completed") return { address, ...result, status: "completed" };
  if (result.kind === "input-required") return { address, ...result, status: "input-required" };
  if (result.kind === "external-action-required")
    return { address, ...result, status: "external-action-required" };
  return { address, ...result, status: result.kind };
}

export function productionRegistryAddTool(deployed: ResolvedDeployedSelfModificationConfig) {
  return defineTool({
    description:
      "Install an exact item from the official eve registry into the current production change proposal. If setup pauses, call this tool again with the non-secret answers and the installed state from its result. External authorization and secret binding must be completed by the developer.",
    inputSchema: productionInputSchema,
    outputSchema: productionOutputSchema,
    async execute(input, ctx) {
      const { address } = input;
      if (typeof address !== "string" || address.length === 0) {
        throw new Error("address must be an exact item address from the official eve registry.");
      }
      const answers =
        "answers" in input &&
        typeof input.answers === "object" &&
        input.answers !== null &&
        !Array.isArray(input.answers)
          ? (input.answers as Record<string, unknown>)
          : undefined;
      const installed = "installed" in input && input.installed === true;
      return await addProductionRegistryItem(address, ctx, deployed, { answers, installed });
    },
  });
}

export default defineDynamic({
  events: {
    "session.started": () =>
      isDeployedRuntime()
        ? productionRegistryAddTool(resolveDeployedSelfModificationConfig(selfModification.config))
        : null,
  },
});
