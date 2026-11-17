import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  CompiledAgentManifest,
  CompiledChannelDefinition,
  CompiledConnectionDefinition,
  CompiledInstructionsDefinition,
  CompiledScheduleDefinition,
  CompiledSkillDefinition,
  CompiledSubagentNode,
  CompiledToolDefinition,
} from "#compiler/manifest.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  type VercelEveAgentSummary,
  type VercelEveChannelEntry,
  type VercelEveConnectionEntry,
  type VercelEveInstructionsEntry,
  type VercelEveScheduleEntry,
  type VercelEveSkillEntry,
  type VercelEveSubagentEntry,
  type VercelEveToolEntry,
  VERCEL_EVE_AGENT_SUMMARY_KIND,
  VERCEL_EVE_AGENT_SUMMARY_VERSION,
  normalizeChannelKindForDisplay,
} from "#internal/vercel-agent-summary.js";

export function buildVercelAgentSummary(input: {
  manifest: CompiledAgentManifest;
  generatorVersion?: string;
}): VercelEveAgentSummary {
  const { manifest } = input;

  return {
    kind: VERCEL_EVE_AGENT_SUMMARY_KIND,
    schemaVersion: VERCEL_EVE_AGENT_SUMMARY_VERSION,
    generatorVersion: input.generatorVersion ?? resolveInstalledPackageInfo().version,
    agent:
      manifest.config.dynamicModel === undefined
        ? {
            name: manifest.config.name,
            description: manifest.config.description,
            modelId: manifest.config.model.id,
          }
        : {
            name: manifest.config.name,
            description: manifest.config.description,
            modelRouting: { kind: "dynamic" },
          },
    instructions: manifest.instructions.map(toInstructionsEntry),
    schedules: manifest.schedules.map(toScheduleEntry),
    tools: manifest.tools.map(toToolEntry),
    skills: manifest.skills.map(toSkillEntry),
    connections: manifest.connections.map(toConnectionEntry),
    channels: manifest.channelRoutes.effective.map(toChannelEntry),
    sandbox:
      manifest.sandbox === null
        ? null
        : {
            logicalPath: manifest.sandbox.logicalPath,
          },
    subagents: manifest.subagents.map(toSubagentEntry),
    diagnostics: {
      errors: manifest.diagnosticsSummary.errors,
      warnings: manifest.diagnosticsSummary.warnings,
    },
  };
}

export async function emitVercelAgentSummary(input: {
  manifest: CompiledAgentManifest;
  generatorVersion?: string;
  outputPath: string;
}): Promise<string> {
  const summary = buildVercelAgentSummary({
    generatorVersion: input.generatorVersion,
    manifest: input.manifest,
  });
  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, `${JSON.stringify(summary, null, 2)}\n`);

  return input.outputPath;
}

function toInstructionsEntry(
  instructions: CompiledInstructionsDefinition,
): VercelEveInstructionsEntry {
  return {
    content: instructions.content,
    logicalPath: instructions.logicalPath,
    role: instructions.role,
    sourceKind: instructions.sourceKind,
  };
}

function toScheduleEntry(schedule: CompiledScheduleDefinition): VercelEveScheduleEntry {
  return {
    name: schedule.name,
    cron: schedule.cron,
    logicalPath: schedule.logicalPath,
  };
}

function toToolEntry(tool: CompiledToolDefinition): VercelEveToolEntry {
  return {
    name: tool.name,
    description: tool.description,
    logicalPath: tool.logicalPath,
  };
}

function toSkillEntry(skill: CompiledSkillDefinition): VercelEveSkillEntry {
  return {
    name: skill.name,
    description: skill.description,
    logicalPath: skill.logicalPath,
    sourceKind: skill.sourceKind,
  };
}

function toConnectionEntry(connection: CompiledConnectionDefinition): VercelEveConnectionEntry {
  const entry: VercelEveConnectionEntry = {
    name: connection.connectionName,
    description: connection.description,
    url: connection.url,
    logicalPath: connection.logicalPath,
    type: connection.protocol,
  };

  if (connection.vercelConnect !== undefined) {
    return {
      ...entry,
      vercelConnect: { connector: connection.vercelConnect.connector },
    };
  }

  return entry;
}

function toChannelEntry(channel: CompiledChannelDefinition): VercelEveChannelEntry {
  const entry: VercelEveChannelEntry = {
    name: channel.name,
    method: channel.method,
    urlPath: channel.urlPath,
    type: normalizeChannelKindForDisplay(channel.adapterKind),
    logicalPath: channel.logicalPath,
  };

  if (channel.adapterKind !== undefined) {
    return { ...entry, adapterKind: channel.adapterKind };
  }

  return entry;
}

function toSubagentEntry(subagent: CompiledSubagentNode): VercelEveSubagentEntry {
  return {
    name: subagent.name,
    description: subagent.description,
    logicalPath: subagent.logicalPath,
  };
}
