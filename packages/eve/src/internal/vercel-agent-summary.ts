import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import type { AgentWorkspace } from "#internal/project-context.js";

export const VERCEL_EVE_AGENT_SUMMARY_KIND = "vercel-eve-agent-summary" as const;

export const VERCEL_EVE_AGENT_SUMMARY_VERSION = 5;

export const VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH = ".eve/agent-summary.json";

export const VERCEL_EVE_MULTI_AGENT_SUMMARY_KIND = "vercel-eve-multi-agent-summary" as const;

export const VERCEL_EVE_MULTI_AGENT_SUMMARY_VERSION = 1;

export type VercelEveChannelType = "slack" | "http" | "webhook" | "unknown";

interface VercelEveAgentEntryBase {
  readonly name: string;
  readonly description?: string;
}

export type VercelEveAgentEntry = VercelEveAgentEntryBase &
  (
    | { readonly modelId: string; readonly modelRouting?: never }
    | { readonly modelId?: never; readonly modelRouting: { readonly kind: "dynamic" } }
  );

export interface VercelEveInstructionsEntry {
  readonly logicalPath: string;
  readonly sourceKind: "markdown" | "module";
  readonly content: string;
  readonly role: "system" | "user";
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

export type VercelEveConnectionType = "mcp" | "openapi";

export interface VercelEveConnectionEntry {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly logicalPath: string;
  readonly type: VercelEveConnectionType;
  readonly vercelConnect?: {
    readonly connector: string;
  };
}

export interface VercelEveChannelEntry {
  readonly name: string;
  readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "WEBSOCKET";
  readonly urlPath: string;
  readonly type: VercelEveChannelType;
  readonly adapterKind?: string;
  readonly logicalPath: string;
}

export interface VercelEveSandboxEntry {
  readonly logicalPath: string;
}

export interface VercelEveSkillEntry {
  readonly name: string;
  readonly description: string;
  readonly logicalPath: string;
  readonly sourceKind: "markdown" | "module" | "skill-package";
}

export interface VercelEveSubagentEntry {
  readonly name: string;
  readonly description?: string;
  readonly logicalPath: string;
}

export interface VercelEveDiagnosticsSummary {
  readonly errors: number;
  readonly warnings: number;
}

export interface VercelEveMultiAgentSummaryEntry {
  readonly name: string;
  readonly routePrefix: string;
  readonly summaryPath: string;
}

export interface VercelEveMultiAgentSummary {
  readonly kind: typeof VERCEL_EVE_MULTI_AGENT_SUMMARY_KIND;
  readonly schemaVersion: typeof VERCEL_EVE_MULTI_AGENT_SUMMARY_VERSION;
  readonly generatorVersion: string;
  readonly agents: readonly VercelEveMultiAgentSummaryEntry[];
}

export interface VercelEveAgentSummary {
  readonly kind: typeof VERCEL_EVE_AGENT_SUMMARY_KIND;
  readonly schemaVersion: typeof VERCEL_EVE_AGENT_SUMMARY_VERSION;
  readonly generatorVersion: string;
  readonly agent: VercelEveAgentEntry;
  readonly instructions: readonly VercelEveInstructionsEntry[];
  readonly schedules: readonly VercelEveScheduleEntry[];
  readonly tools: readonly VercelEveToolEntry[];
  readonly skills: readonly VercelEveSkillEntry[];
  readonly connections: readonly VercelEveConnectionEntry[];
  readonly channels: readonly VercelEveChannelEntry[];
  readonly sandbox: VercelEveSandboxEntry | null;
  readonly subagents: readonly VercelEveSubagentEntry[];
  readonly diagnostics: VercelEveDiagnosticsSummary;
}

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

export async function writeMultiAgentSummary(workspace: AgentWorkspace): Promise<void> {
  const summary: VercelEveMultiAgentSummary = {
    agents: workspace.members.map((member) => ({
      name: member.name,
      routePrefix: `/eve/${member.name}`,
      summaryPath: relative(
        workspace.root,
        join(member.appRoot, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH),
      ).replaceAll("\\", "/"),
    })),
    generatorVersion: resolveInstalledPackageInfo().version,
    kind: VERCEL_EVE_MULTI_AGENT_SUMMARY_KIND,
    schemaVersion: VERCEL_EVE_MULTI_AGENT_SUMMARY_VERSION,
  };
  const outputPath = join(workspace.root, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
}
