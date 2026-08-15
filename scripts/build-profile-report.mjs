import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_PROFILE_KIND = "eve-build-profile";
const BUILD_PROFILE_SCHEMA_VERSION = 1;
const BUILD_PROFILE_REPORT_KIND = "eve-build-profile-report";
const BUILD_PROFILE_REPORT_SCHEMA_VERSION = 1;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readDuration(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }

  return value;
}

function readBuildProfile(value, sourceLabel) {
  if (!isRecord(value)) {
    throw new Error(`${sourceLabel} must be a JSON object.`);
  }

  if (value.kind !== BUILD_PROFILE_KIND) {
    throw new Error(`${sourceLabel} must have kind "${BUILD_PROFILE_KIND}".`);
  }

  if (value.schemaVersion !== BUILD_PROFILE_SCHEMA_VERSION) {
    throw new Error(
      `${sourceLabel} must use schema version ${BUILD_PROFILE_SCHEMA_VERSION}, received ${String(value.schemaVersion)}.`,
    );
  }

  if (value.target !== "local" && value.target !== "vercel") {
    throw new Error(`${sourceLabel} must have target "local" or "vercel".`);
  }

  if (!Array.isArray(value.phases)) {
    throw new Error(`${sourceLabel}.phases must be an array.`);
  }

  const phaseNames = new Set();
  const phases = value.phases.map((phase, index) => {
    if (!isRecord(phase) || typeof phase.name !== "string" || phase.name.length === 0) {
      throw new Error(`${sourceLabel}.phases[${index}].name must be a non-empty string.`);
    }

    if (phaseNames.has(phase.name)) {
      throw new Error(`${sourceLabel}.phases must not contain duplicate phase names.`);
    }
    phaseNames.add(phase.name);

    return {
      durationMs: readDuration(phase.durationMs, `${sourceLabel}.phases[${index}].durationMs`),
      name: phase.name,
    };
  });

  return {
    durationMs: readDuration(value.durationMs, `${sourceLabel}.durationMs`),
    phases,
    target: value.target,
  };
}

function formatDuration(durationMs) {
  if (durationMs < 1_000) {
    return `${durationMs.toFixed(1)} ms`;
  }

  return `${(durationMs / 1_000).toFixed(2)} s`;
}

function formatSignedDuration(durationMs) {
  if (durationMs === 0) {
    return "0.0 ms";
  }

  return `${durationMs > 0 ? "+" : "-"}${formatDuration(Math.abs(durationMs))}`;
}

function formatMarkdownCode(value) {
  return String(value).replaceAll("`", "\\`");
}

function createPhaseComparison(currentProfile, baselineProfile) {
  const currentPhases = new Map(currentProfile.phases.map((phase) => [phase.name, phase]));
  const baselinePhases = new Map(baselineProfile.phases.map((phase) => [phase.name, phase]));
  const phaseNames = [
    ...currentProfile.phases.map((phase) => phase.name),
    ...baselineProfile.phases
      .map((phase) => phase.name)
      .filter((phaseName) => !currentPhases.has(phaseName)),
  ];

  return phaseNames.map((name) => {
    const current = currentPhases.get(name) ?? null;
    const baseline = baselinePhases.get(name) ?? null;

    return {
      baselineDurationMs: baseline?.durationMs ?? null,
      currentDurationMs: current?.durationMs ?? null,
      deltaMs:
        current === null || baseline === null ? null : current.durationMs - baseline.durationMs,
      name,
    };
  });
}

/**
 * Creates a stable, CI-oriented view of one or two `eve build --profile` files.
 */
export function createBuildProfileReport(input) {
  const current = readBuildProfile(input.currentProfile, "Current build profile");
  const baseline =
    input.baselineProfile === undefined || input.baselineProfile === null
      ? null
      : readBuildProfile(input.baselineProfile, "Baseline build profile");

  if (baseline !== null && baseline.target !== current.target) {
    throw new Error(
      `Build profile targets must match: baseline is "${baseline.target}" and current is "${current.target}".`,
    );
  }

  const requiredCurrentPhases = input.requiredCurrentPhases ?? [];
  const currentPhaseNames = new Set(current.phases.map((phase) => phase.name));
  for (const phaseName of requiredCurrentPhases) {
    if (!currentPhaseNames.has(phaseName)) {
      throw new Error(`Current build profile is missing required phase "${phaseName}".`);
    }
  }

  const sandboxPrewarm = input.sandboxPrewarm ?? "included";
  if (sandboxPrewarm !== "included" && sandboxPrewarm !== "skipped") {
    throw new Error('sandboxPrewarm must be "included" or "skipped".');
  }

  return {
    appLabel: input.appLabel,
    baseline:
      baseline === null
        ? null
        : {
            label: input.baselineLabel ?? "baseline",
            profile: baseline,
          },
    comparison:
      baseline === null
        ? null
        : {
            durationMs: {
              baseline: baseline.durationMs,
              current: current.durationMs,
              delta: current.durationMs - baseline.durationMs,
            },
            phases: createPhaseComparison(current, baseline),
          },
    current: {
      label: input.currentLabel ?? "current",
      profile: current,
    },
    kind: BUILD_PROFILE_REPORT_KIND,
    sandboxPrewarm,
    schemaVersion: BUILD_PROFILE_REPORT_SCHEMA_VERSION,
  };
}

function renderCurrentPhaseTable(profile) {
  return [
    "| Phase | Duration |",
    "| --- | ---: |",
    ...profile.phases.map(
      (phase) => `| \`${formatMarkdownCode(phase.name)}\` | ${formatDuration(phase.durationMs)} |`,
    ),
  ];
}

function renderComparisonPhaseTable(comparison) {
  return [
    "| Phase | Baseline | Current | Delta |",
    "| --- | ---: | ---: | ---: |",
    ...comparison.phases.map((phase) => {
      const baseline =
        phase.baselineDurationMs === null ? "—" : formatDuration(phase.baselineDurationMs);
      const current =
        phase.currentDurationMs === null ? "—" : formatDuration(phase.currentDurationMs);
      const delta = phase.deltaMs === null ? "—" : formatSignedDuration(phase.deltaMs);

      return `| \`${formatMarkdownCode(phase.name)}\` | ${baseline} | ${current} | ${delta} |`;
    }),
  ];
}

/** Renders one compact timing report for a GitHub job summary or pull request comment. */
export function renderBuildProfileReportMarkdown(report) {
  const current = report.current.profile;
  const lines = [
    `## Build Timing: \`${formatMarkdownCode(report.appLabel)}\``,
    "",
    "This is an informational timing measurement inside `eve build`, from preflight through publication. Output-size measurement and profile writing are excluded.",
    "",
    report.sandboxPrewarm === "skipped"
      ? "**Benchmark mode:** Vercel bundling with sandbox template prewarm skipped. It is intentionally reproducible for Bundle Analysis, but not the full wall-clock time of a deployable Vercel build."
      : "**Build mode:** deployable Vercel build with sandbox template prewarm included.",
    "",
  ];

  if (report.comparison === null || report.baseline === null) {
    lines.push(
      `- Current build pipeline: **${formatDuration(current.durationMs)}** (target: \`${current.target}\`).`,
      "- No baseline build profile was supplied, so this report shows the current phases only.",
      "",
      "<details>",
      "<summary>Detailed phase timings</summary>",
      "",
      ...renderCurrentPhaseTable(current),
      "",
      "</details>",
    );

    return lines.join("\n");
  }

  const comparison = report.comparison;
  lines.push(
    `- Build pipeline: ${formatDuration(comparison.durationMs.baseline)} -> **${formatDuration(comparison.durationMs.current)}** (${formatSignedDuration(comparison.durationMs.delta)}) vs \`${formatMarkdownCode(report.baseline.label)}\`.`,
    "- Timing is informational: shared GitHub runners are too variable for a hard timing budget.",
    "",
    "<details>",
    `<summary>Detailed phase timings vs \`${formatMarkdownCode(report.baseline.label)}\`</summary>`,
    "",
    ...renderComparisonPhaseTable(comparison),
    "",
    "</details>",
  );

  return lines.join("\n");
}

/** Renders one deployable-build duration for an E2E job log. */
export function renderBuildProfileTimingLog(report) {
  const current = report.current.profile;
  const buildMode =
    report.sandboxPrewarm === "skipped"
      ? "sandbox template prewarm skipped"
      : "sandbox template prewarm included";

  return `eve build (${report.appLabel}): ${formatDuration(current.durationMs)} (${buildMode}).`;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: node ./scripts/build-profile-report.mjs --profile <path> [options]",
      "",
      "Options:",
      "  --profile <path>           Current eve build profile JSON",
      "  --app-label <label>        Application label shown in the report",
      "  --baseline-profile <path>  Optional baseline eve build profile JSON",
      "  --baseline-label <label>   Display label for the baseline profile",
      "  --current-label <label>    Display label for the current profile",
      "  --sandbox-prewarm <mode>   Whether prewarm was included or skipped (default: included)",
      "  --output-format <format>   Render markdown or a one-line build-time log (default: markdown)",
      "  --require-phase <name>     Require a phase in the current profile; repeatable",
      "  --output-json <path>       Write the JSON report to this file",
      "  --output-markdown <path>   Write the Markdown report to this file",
      "  --help                     Show this help text",
      "",
    ].join("\n"),
  );
}

function parseArguments(argv) {
  const parsedArguments = {
    appLabel: "eve application",
    baselineLabel: "baseline",
    baselineProfilePath: null,
    currentLabel: "current",
    outputFormat: "markdown",
    outputJsonPath: null,
    outputMarkdownPath: null,
    profilePath: null,
    requiredCurrentPhases: [],
    sandboxPrewarm: "included",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help") {
      printUsage();
      process.exit(0);
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for "${argument}".`);
    }

    if (argument === "--profile") {
      parsedArguments.profilePath = value;
    } else if (argument === "--app-label") {
      parsedArguments.appLabel = value;
    } else if (argument === "--baseline-profile") {
      parsedArguments.baselineProfilePath = value;
    } else if (argument === "--baseline-label") {
      parsedArguments.baselineLabel = value;
    } else if (argument === "--current-label") {
      parsedArguments.currentLabel = value;
    } else if (argument === "--sandbox-prewarm") {
      if (value !== "included" && value !== "skipped") {
        throw new Error('The "--sandbox-prewarm" value must be "included" or "skipped".');
      }
      parsedArguments.sandboxPrewarm = value;
    } else if (argument === "--output-format") {
      if (value !== "build-time" && value !== "markdown") {
        throw new Error('The "--output-format" value must be "build-time" or "markdown".');
      }
      parsedArguments.outputFormat = value;
    } else if (argument === "--require-phase") {
      parsedArguments.requiredCurrentPhases.push(value);
    } else if (argument === "--output-json") {
      parsedArguments.outputJsonPath = value;
    } else if (argument === "--output-markdown") {
      parsedArguments.outputMarkdownPath = value;
    } else {
      throw new Error(`Unknown argument "${argument}".`);
    }

    index += 1;
  }

  if (parsedArguments.profilePath === null) {
    throw new Error('The "--profile" option is required.');
  }

  return parsedArguments;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

async function writeOutputFile(path, contents) {
  await mkdir(dirname(resolve(path)), {
    recursive: true,
  });
  await writeFile(path, contents, "utf8");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const currentProfile = await readJson(args.profilePath);
  const baselineProfile =
    args.baselineProfilePath === null ? null : await readJson(args.baselineProfilePath);
  const report = createBuildProfileReport({
    appLabel: args.appLabel,
    baselineLabel: args.baselineLabel,
    baselineProfile,
    currentLabel: args.currentLabel,
    currentProfile,
    requiredCurrentPhases: args.requiredCurrentPhases,
    sandboxPrewarm: args.sandboxPrewarm,
  });
  const output =
    args.outputFormat === "build-time"
      ? renderBuildProfileTimingLog(report)
      : renderBuildProfileReportMarkdown(report);

  if (args.outputJsonPath !== null) {
    await writeOutputFile(args.outputJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (args.outputMarkdownPath !== null) {
    await writeOutputFile(args.outputMarkdownPath, `${output}\n`);
  }

  if (args.outputMarkdownPath === null) {
    process.stdout.write(`${output}\n`);
  }
}

const executedScriptPath = process.argv[1] ? resolve(process.argv[1]) : null;
const moduleScriptPath = resolve(fileURLToPath(import.meta.url));

if (executedScriptPath !== null && executedScriptPath === moduleScriptPath) {
  await main();
}
