import { type ApplicationInspection, inspectApplication } from "#services/inspect-application.js";
import type {
  CompiledInstructionsDefinition,
  CompiledSubagentNode,
  CompiledToolDefinition,
} from "#compiler/manifest.js";
import { formatDiagnosticSources } from "#compiler/diagnostics.js";
import type { JsonObject } from "#shared/json.js";
import { type CliRow, createCliTheme, renderCliSection } from "#cli/ui/output.js";

interface CliInfoLogger {
  log(message: string): void;
}

export interface PrintApplicationInfoOptions {
  json?: boolean;
}

export interface ApplicationInfoJson {
  appRoot: string;
  agentRoot: string | null;
  layout: string | null;
  status: string;
  diagnostics: {
    errors: number;
    warnings: number;
    items: ApplicationInfoDiagnostic[];
  } | null;
  model: string | null;
  instructions: string | null;
  skills: string[];
  tools: string[];
  toolInputSchemas: {
    root: Record<string, JsonObject>;
    subagents: Record<string, Record<string, JsonObject>>;
  };
  subagents: string[];
  schedules: string[];
  channels: { name: string; kind: string | null; method: string | null; urlPath: string | null }[];
  messaging: { create: string; messages: string; stream: string };
  artifacts: {
    compiledManifest: string;
    discoveryManifest: string;
    diagnostics: string;
    moduleMap: string;
    metadata: string;
  } | null;
}

export interface ApplicationInfoDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  source: string | null;
}

const COMPILE_FAILED_CODE = "compile/failed";

function listDiagnostics(inspection: ApplicationInspection): ApplicationInfoDiagnostic[] {
  if (inspection.compileError !== undefined) {
    return [
      {
        code: COMPILE_FAILED_CODE,
        message: inspection.compileError,
        severity: "error",
        source: null,
      },
    ];
  }
  return (inspection.compiledState?.diagnostics ?? []).map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    source: formatDiagnosticSources(diagnostic) || null,
  }));
}

function resolveStatus(inspection: ApplicationInspection): string {
  if (inspection.compileError !== undefined) return "failed";
  return inspection.compiledState?.metadata.status ?? "unavailable";
}

export function isApplicationInfoHealthy(inspection: ApplicationInspection): boolean {
  return resolveStatus(inspection) !== "failed";
}

function formatInstructions(instructions: readonly CompiledInstructionsDefinition[]): string {
  return instructions
    .map((instructions) => `${instructions.logicalPath} (${instructions.role})`)
    .join(", ");
}

export function buildApplicationInfoJson(inspection: ApplicationInspection): ApplicationInfoJson {
  const { application: info, compiledState, messaging } = inspection;
  const items = listDiagnostics(inspection);
  return {
    appRoot: info.appRoot,
    agentRoot: compiledState?.project.agentRoot ?? null,
    layout: compiledState?.project.layout ?? null,
    status: resolveStatus(inspection),
    diagnostics:
      compiledState === null && inspection.compileError === undefined
        ? null
        : {
            errors: items.filter((item) => item.severity === "error").length,
            warnings: items.filter((item) => item.severity === "warning").length,
            items,
          },
    model: compiledState?.manifest.config.model?.id ?? null,
    instructions:
      compiledState === null || compiledState.manifest.instructions.length === 0
        ? null
        : formatInstructions(compiledState.manifest.instructions),
    skills: (compiledState?.manifest.skills ?? []).map((skill) => skill.name),
    tools: (compiledState?.manifest.tools ?? []).map((tool) => tool.name),
    toolInputSchemas: {
      root: modelInputSchemas(compiledState?.manifest.tools ?? []),
      subagents: subagentModelInputSchemas(compiledState?.manifest.subagents ?? []),
    },
    subagents: (compiledState?.manifest.subagents ?? []).map((subagent) => subagent.name),
    schedules: (compiledState?.manifest.schedules ?? []).map((schedule) => schedule.name),
    channels: (compiledState?.manifest.channelRoutes.effective ?? []).map((channel) => ({
      name: channel.name,
      kind: channel.adapterKind ?? null,
      method: channel.method,
      urlPath: channel.urlPath,
    })),
    messaging: {
      create: messaging.createSessionRoutePath,
      messages: messaging.sessionMessagesRoutePattern,
      stream: messaging.streamRoutePattern,
    },
    artifacts: compiledState
      ? {
          compiledManifest: compiledState.paths.compiledManifestPath,
          discoveryManifest: compiledState.paths.discoveryManifestPath,
          diagnostics: compiledState.paths.diagnosticsPath,
          moduleMap: compiledState.paths.moduleMapPath,
          metadata: compiledState.paths.compileMetadataPath,
        }
      : null,
  };
}

function modelInputSchemas(tools: readonly CompiledToolDefinition[]): Record<string, JsonObject> {
  return Object.fromEntries(
    tools.flatMap((tool) =>
      tool.modelInputSchema === undefined ? [] : [[tool.name, tool.modelInputSchema]],
    ),
  );
}

function subagentModelInputSchemas(
  subagents: readonly CompiledSubagentNode[],
): Record<string, Record<string, JsonObject>> {
  const subagentsByNodeId = new Map(subagents.map((subagent) => [subagent.nodeId, subagent]));
  const pathOf = (subagent: CompiledSubagentNode): string => {
    const parent = subagentsByNodeId.get(subagent.parentNodeId);
    return parent === undefined ? subagent.name : `${pathOf(parent)}/${subagent.name}`;
  };
  return Object.fromEntries(
    subagents.map((subagent) => [pathOf(subagent), modelInputSchemas(subagent.agent.tools)]),
  );
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatDiscoverySummary(errors: number, warnings: number): string {
  return `${pluralize(errors, "error")}, ${pluralize(warnings, "warning")}`;
}

function resolveCompileTone(status: string): "danger" | "success" | "warning" {
  switch (status) {
    case "ready":
      return "success";
    case "failed":
      return "danger";
    default:
      return "warning";
  }
}

export async function printApplicationInfo(
  logger: CliInfoLogger,
  appRoot: string,
  options: PrintApplicationInfoOptions = {},
): Promise<boolean> {
  const inspection = await inspectApplication(appRoot);

  logger.log(
    options.json
      ? JSON.stringify(buildApplicationInfoJson(inspection), null, 2)
      : renderApplicationInfo(inspection),
  );
  return isApplicationInfoHealthy(inspection);
}

export function renderApplicationInfo(inspection: ApplicationInspection): string {
  const compiledState = inspection.compiledState;
  const info = inspection.application;
  const theme = createCliTheme();
  const applicationRows: CliRow[] = [
    {
      label: "App Root",
      value: info.appRoot,
    },
  ];
  const artifactRows: CliRow[] = [
    {
      label: "Workflow Build",
      value: info.workflowBuildDir,
    },
    {
      label: "Output",
      value: info.outputDir,
    },
  ];
  const instructionsRows: CliRow[] = [];

  if (compiledState !== null) {
    applicationRows.push(
      {
        label: "Agent Root",
        value: compiledState.project.agentRoot,
      },
      {
        label: "Layout",
        value: compiledState.project.layout,
      },
      {
        label: "Compile",
        tone: resolveCompileTone(compiledState.metadata.status),
        value: compiledState.metadata.status,
      },
      {
        label: "Diagnostics",
        tone:
          compiledState.metadata.discovery.summary.errors > 0
            ? "danger"
            : compiledState.metadata.discovery.summary.warnings > 0
              ? "warning"
              : "success",
        value: formatDiscoverySummary(
          compiledState.metadata.discovery.summary.errors,
          compiledState.metadata.discovery.summary.warnings,
        ),
      },
      {
        label: "Instructions",
        value:
          compiledState.manifest.instructions.length === 0
            ? "none"
            : formatInstructions(compiledState.manifest.instructions),
      },
      {
        label: "Skills",
        value: pluralize(compiledState.manifest.skills.length, "skill"),
      },
      {
        label: "Tools",
        value: pluralize(compiledState.manifest.tools.length, "tool"),
      },
      {
        label: "Subagents",
        value: pluralize(compiledState.manifest.subagents.length, "subagent"),
      },
      {
        label: "Schedules",
        value: pluralize(compiledState.manifest.schedules.length, "schedule"),
      },
    );
    artifactRows.unshift(
      {
        label: "Compiled Manifest",
        value: compiledState.paths.compiledManifestPath,
      },
      {
        label: "Discovery Manifest",
        value: compiledState.paths.discoveryManifestPath,
      },
      {
        label: "Diagnostics",
        value: compiledState.paths.diagnosticsPath,
      },
      {
        label: "Module Map",
        value: compiledState.paths.moduleMapPath,
      },
      {
        label: "Metadata",
        value: compiledState.paths.compileMetadataPath,
      },
    );
    instructionsRows.push(
      compiledState.manifest.instructions.length === 0
        ? {
            label: "Instructions",
            value: "No instructions prompt discovered.",
          }
        : {
            label: "Instructions",
            value: formatInstructions(compiledState.manifest.instructions),
          },
    );
  } else {
    applicationRows.push({
      label: "Compile",
      tone: inspection.compileError === undefined ? "warning" : "danger",
      value: resolveStatus(inspection) === "failed" ? "failed" : "unavailable",
    });
  }
  const diagnosticRows: CliRow[] = listDiagnostics(inspection).map((diagnostic) => ({
    label: diagnostic.severity === "error" ? "Error" : "Warning",
    tone: diagnostic.severity === "error" ? "danger" : "warning",
    value: [
      diagnostic.message,
      `${diagnostic.code}${diagnostic.source === null ? "" : ` · ${diagnostic.source}`}`,
    ].join("\n"),
  }));

  return [
    renderCliSection(theme, {
      rows: applicationRows,
      title: "Application",
    }),
    ...(diagnosticRows.length === 0
      ? []
      : ["", renderCliSection(theme, { rows: diagnosticRows, title: "Diagnostics" })]),
    "",
    renderCliSection(theme, {
      rows: artifactRows,
      title: "Artifacts",
    }),
    ...(compiledState === null
      ? []
      : [
          "",
          renderCliSection(theme, {
            rows: instructionsRows,
            title: "Instructions",
          }),
        ]),
    "",
    renderCliSection(theme, {
      rows: [
        {
          label: "Workflow ID",
          value: info.workflowId,
        },
        {
          label: "Source Dir",
          value: info.workflowSourceDir,
        },
        {
          label: "Create",
          tone: "info",
          value: `POST ${inspection.messaging.createSessionRoutePath}`,
        },
        {
          label: "Messages",
          tone: "info",
          value: `POST ${inspection.messaging.sessionMessagesRoutePattern}`,
        },
        {
          label: "Stream",
          tone: "info",
          value: `GET ${inspection.messaging.streamRoutePattern}`,
        },
      ],
      title: "Messaging",
    }),
  ].join("\n");
}
