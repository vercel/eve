import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createNitroBundleReportComparison } from "./nitro-bundle-report-compare.mjs";
import { collectPublishedPackageReport } from "./package-publish-report.mjs";

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function comparePaths(left, right) {
  return left.localeCompare(right, "en");
}

function compareRoutes(left, right) {
  if (left === "/" && right !== "/") {
    return -1;
  }

  if (left !== "/" && right === "/") {
    return 1;
  }

  return comparePaths(left, right);
}

function formatBytes(bytes) {
  if (bytes < 1_000) {
    return `${bytes} B`;
  }

  if (bytes < 1_000_000) {
    return `${(bytes / 1_000).toFixed(1)} kB`;
  }

  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function formatSignedCount(value) {
  return value > 0 ? `+${value}` : `${value}`;
}

function formatSignedBytes(bytes) {
  if (bytes === 0) {
    return "0 B";
  }

  return `${bytes > 0 ? "+" : "-"}${formatBytes(Math.abs(bytes))}`;
}

function formatSizeDeltaEmoji(bytes) {
  if (bytes > 0) {
    return "⚠️";
  }

  if (bytes < 0) {
    return "✅";
  }

  return "➖";
}

function formatSizeDelta(bytes) {
  return `${formatSignedBytes(bytes)} ${formatSizeDeltaEmoji(bytes)}`;
}

function formatDate(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString();
}

function formatPercent(part, whole) {
  if (whole <= 0) {
    return "0.0%";
  }

  return `${((part / whole) * 100).toFixed(1)}%`;
}

function formatRatioPercent(ratio) {
  if (!Number.isFinite(ratio)) {
    return "new";
  }

  return `${(ratio * 100).toFixed(1)}%`;
}

function formatRouteCount(publicCount, internalCount) {
  const parts = [`${publicCount} public route${publicCount === 1 ? "" : "s"}`];

  if (internalCount > 0) {
    parts.push(`${internalCount} internal alias${internalCount === 1 ? "" : "es"}`);
  }

  return parts.join(", ");
}

function shortenLabel(label, maxLength) {
  if (label.length <= maxLength) {
    return label;
  }

  return `${label.slice(0, Math.max(0, maxLength - 3))}...`;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatCodeLines(values) {
  if (values.length === 0) {
    return "none";
  }

  return values.map((value) => `<code>${escapeHtml(value)}</code>`).join("<br>");
}

const SEVERITY_LEVELS = [
  {
    bytes: 5_000_000,
    icon: "🔴",
    label: "dominant",
    share: 0.4,
  },
  {
    bytes: 1_000_000,
    icon: "🟠",
    label: "notable",
    share: 0.15,
  },
  {
    bytes: 250_000,
    icon: "🟡",
    label: "watch",
    share: 0.05,
  },
];

const INSTALLED_PACKAGE_BREAKDOWN_MAX_ENTRIES = 6;
const INSTALLED_PACKAGE_BREAKDOWN_MIN_BYTES = 5_000_000;

function describeSeverityLegend() {
  return "🔴 dominant/large, 🟠 notable, 🟡 watch, ⚪ small";
}

function getEntrySeverity(bytes, totalBytes) {
  const share = totalBytes > 0 ? bytes / totalBytes : 0;

  for (const severity of SEVERITY_LEVELS) {
    if (bytes >= severity.bytes || share >= severity.share) {
      return severity;
    }
  }

  return {
    bytes: 0,
    icon: "⚪",
    label: "small",
    share: 0,
  };
}

function getSeverityRank(severity) {
  switch (severity.icon) {
    case "🔴":
      return 3;
    case "🟠":
      return 2;
    case "🟡":
      return 1;
    default:
      return 0;
  }
}

function formatSignal(kind, label, bytes, totalBytes) {
  const severity = getEntrySeverity(bytes, totalBytes);

  return `${severity.icon} ${kind} \`${label}\` is ${formatBytes(bytes)} (${formatPercent(bytes, totalBytes)})`;
}

function selectPrimarySignal(functionEntry) {
  /** @type {{ bytes: number; kind: string; label: string; severity: { bytes: number; icon: string; label: string; share: number }; totalBytes: number }[]} */
  const candidates = [];

  if (functionEntry.topTracedPackages[0] !== undefined) {
    candidates.push({
      bytes: functionEntry.topTracedPackages[0].bytes,
      kind: "Traced package",
      label: functionEntry.topTracedPackages[0].name,
      severity: getEntrySeverity(
        functionEntry.topTracedPackages[0].bytes,
        functionEntry.tracedDependencyBytes,
      ),
      totalBytes: functionEntry.tracedDependencyBytes,
    });
  }

  if (functionEntry.topBundledFiles[0] !== undefined) {
    candidates.push({
      bytes: functionEntry.topBundledFiles[0].bytes,
      kind: "Bundled file",
      label: functionEntry.topBundledFiles[0].path,
      severity: getEntrySeverity(
        functionEntry.topBundledFiles[0].bytes,
        functionEntry.functionFilesBytes,
      ),
      totalBytes: functionEntry.functionFilesBytes,
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const rankDifference = getSeverityRank(right.severity) - getSeverityRank(left.severity);

    if (rankDifference !== 0) {
      return rankDifference;
    }

    const leftShare = left.totalBytes > 0 ? left.bytes / left.totalBytes : 0;
    const rightShare = right.totalBytes > 0 ? right.bytes / right.totalBytes : 0;

    return (
      rightShare - leftShare || right.bytes - left.bytes || comparePaths(left.label, right.label)
    );
  });

  return candidates[0];
}

function summarizeFunctionSignal(functionEntry) {
  const selectedCandidate = selectPrimarySignal(functionEntry);

  if (selectedCandidate === null) {
    return null;
  }

  return formatSignal(
    selectedCandidate.kind,
    selectedCandidate.label,
    selectedCandidate.bytes,
    selectedCandidate.totalBytes,
  );
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  const source = await readFile(path, "utf8");

  return JSON.parse(source);
}

async function walkRegularFiles(root) {
  /** @type {{ bytes: number; relativePath: string }[]} */
  const files = [];

  async function visit(currentPath) {
    const entries = await readdir(currentPath, {
      withFileTypes: true,
    });
    entries.sort((left, right) => comparePaths(left.name, right.name));

    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name);
      const entryRelativePath = normalizePath(relative(root, entryPath));

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const entryStats = await stat(entryPath);
      files.push({
        bytes: entryStats.size,
        relativePath: entryRelativePath,
      });
    }
  }

  await visit(root);
  files.sort((left, right) => comparePaths(left.relativePath, right.relativePath));

  return files;
}

function deriveFunctionRoute(relativeFunctionPath) {
  const withoutSuffix = normalizePath(relativeFunctionPath).replace(/\.func$/, "");

  if (withoutSuffix === "index") {
    return "/";
  }

  const normalizedRoute = withoutSuffix.endsWith("/index")
    ? withoutSuffix.slice(0, -"/index".length)
    : withoutSuffix;

  return `/${normalizedRoute}`;
}

function isInternalRoute(route) {
  return route.startsWith("/__");
}

function readNodeModulesPackageName(relativePath) {
  const pathSegments = normalizePath(relativePath).split("/");
  const nodeModulesIndex = pathSegments.indexOf("node_modules");

  if (nodeModulesIndex < 0) {
    return null;
  }

  const packageStart = pathSegments[nodeModulesIndex + 1];

  if (!packageStart) {
    return null;
  }

  if (packageStart.startsWith("@")) {
    const scopedName = pathSegments[nodeModulesIndex + 2];

    return scopedName ? `${packageStart}/${scopedName}` : null;
  }

  return packageStart;
}

async function discoverFunctionEntries(functionsRoot) {
  /** @type {{ isInternalRoute: boolean; realDirectoryPath: string; relativeEntryPath: string; route: string }[]} */
  const entries = [];

  async function visit(currentPath) {
    const directoryEntries = await readdir(currentPath, {
      withFileTypes: true,
    });
    directoryEntries.sort((left, right) => comparePaths(left.name, right.name));

    for (const entry of directoryEntries) {
      const entryPath = join(currentPath, entry.name);
      const entryRelativePath = normalizePath(relative(functionsRoot, entryPath));

      if (entry.name.endsWith(".func")) {
        entries.push({
          isInternalRoute: isInternalRoute(deriveFunctionRoute(entryRelativePath)),
          realDirectoryPath: await realpath(entryPath),
          relativeEntryPath: entryRelativePath,
          route: deriveFunctionRoute(entryRelativePath),
        });
        continue;
      }

      if (entry.isDirectory()) {
        await visit(entryPath);
      }
    }
  }

  await visit(functionsRoot);
  entries.sort((left, right) => compareRoutes(left.route, right.route));

  return entries;
}

function summarizeTopFiles(files, count) {
  return [...files]
    .sort(
      (left, right) =>
        right.bytes - left.bytes || comparePaths(left.relativePath, right.relativePath),
    )
    .slice(0, count)
    .map((entry) => ({
      bytes: entry.bytes,
      path: entry.relativePath,
    }));
}

function summarizeTopPackages(files, count) {
  /** @type {Map<string, number>} */
  const packageSizes = new Map();

  for (const file of files) {
    const packageName = readNodeModulesPackageName(file.relativePath);

    if (!packageName) {
      continue;
    }

    packageSizes.set(packageName, (packageSizes.get(packageName) ?? 0) + file.bytes);
  }

  return [...packageSizes.entries()]
    .sort((left, right) => right[1] - left[1] || comparePaths(left[0], right[0]))
    .slice(0, count)
    .map(([name, bytes]) => ({
      bytes,
      name,
    }));
}

function limitChartEntries(entries, maxEntries) {
  if (entries.length <= maxEntries) {
    return entries;
  }

  let otherBytes = 0;
  const limitedEntries = entries.slice(0, maxEntries - 1);

  for (const entry of entries.slice(maxEntries - 1)) {
    otherBytes += entry.bytes;
  }

  return [
    ...limitedEntries,
    {
      bytes: otherBytes,
      label: "Other",
    },
  ];
}

function buildTopEntryChart(entries, totalBytes, options) {
  const positiveEntries = entries.filter((entry) => entry.bytes > 0);

  if (positiveEntries.length === 0 || totalBytes <= 0) {
    return [];
  }

  let retainedCount = options.maxEntries;

  if (options.minBytes !== undefined) {
    while (
      retainedCount < positiveEntries.length &&
      positiveEntries[retainedCount] &&
      positiveEntries[retainedCount].bytes > options.minBytes
    ) {
      retainedCount += 1;
    }
  }

  const limitedEntries = positiveEntries.slice(0, retainedCount);
  const topEntryBytes = limitedEntries.reduce((sum, entry) => sum + entry.bytes, 0);
  const otherBytes = Math.max(0, totalBytes - topEntryBytes);

  if (otherBytes <= 0) {
    return limitedEntries;
  }

  return [
    ...limitedEntries,
    {
      bytes: otherBytes,
      label: options.otherLabel,
    },
  ];
}

function createAsciiBar(bytes, maxBytes, width) {
  if (maxBytes <= 0 || bytes <= 0) {
    return ".".repeat(width);
  }

  const filledWidth = Math.max(1, Math.round((bytes / maxBytes) * width));

  return `${"#".repeat(filledWidth)}${".".repeat(Math.max(0, width - filledWidth))}`;
}

function renderAsciiBarChart(title, entries, totalBytes) {
  if (entries.length === 0) {
    return [];
  }

  const chartWidth = 24;
  const shortenedLabels = entries.map((entry) => shortenLabel(entry.label, 48));
  const labelWidth = shortenedLabels.reduce(
    (maxWidth, label) => Math.max(maxWidth, label.length),
    title.length,
  );
  const maxBytes = entries.reduce((largest, entry) => Math.max(largest, entry.bytes), 0);
  const lines = ["```text", title];

  for (const [index, entry] of entries.entries()) {
    const severity = getEntrySeverity(entry.bytes, totalBytes);
    lines.push(
      `${severity.icon} ${shortenedLabels[index].padEnd(labelWidth)} [${createAsciiBar(entry.bytes, maxBytes, chartWidth)}] ${formatBytes(entry.bytes)} ${formatPercent(entry.bytes, totalBytes)}`,
    );
  }

  lines.push("```", "");

  return lines;
}

function renderDependencyTable(title, dependencies) {
  const lines = ["<details>", `<summary>${title} (${dependencies.length})</summary>`, ""];

  if (dependencies.length === 0) {
    lines.push("None.", "", "</details>", "");
    return lines;
  }

  lines.push("| Package | Range | Notes |");
  lines.push("| --- | --- | --- |");

  for (const dependency of dependencies) {
    lines.push(
      `| \`${dependency.name}\` | \`${dependency.range}\` | ${dependency.optional ? "optional peer" : ""} |`,
    );
  }

  lines.push("", "</details>", "");
  return lines;
}

function formatTopPackageSummary(packages, totalBytes, count) {
  return packages
    .slice(0, count)
    .map(
      (pkg) =>
        `\`${pkg.name}\` ${formatBytes(pkg.bytes)} (${formatPercent(pkg.bytes, totalBytes)})`,
    )
    .join(", ");
}

function renderHeavyDependencyList(packages, totalBytes, count) {
  if (packages.length === 0 || totalBytes <= 0) {
    return [];
  }

  const lines = ["**Heavy installed dependencies**", ""];

  for (const pkg of packages.slice(0, count)) {
    lines.push(
      `- \`${pkg.name}\`: ${formatBytes(pkg.bytes)} (${formatPercent(pkg.bytes, totalBytes)})`,
    );
  }

  lines.push("");
  return lines;
}

function summarizePackageTakeaways(publishedPackage) {
  const topDependencySummary =
    publishedPackage.topInstalledPackages.length > 0
      ? `; top deps ${formatTopPackageSummary(
          publishedPackage.topInstalledPackages,
          publishedPackage.installedSizeBytes,
          2,
        )}`
      : "";

  return [
    `- Package: tarball ${formatBytes(publishedPackage.packedSizeBytes)}, install footprint ${formatBytes(publishedPackage.installedSizeBytes)} (${formatBytes(publishedPackage.installedDependencyBytes)} deps)${topDependencySummary}.`,
  ];
}

function summarizeFunctionTakeaways(report) {
  if (report.functions.length === 0) {
    return [];
  }

  const largestFunction = report.functions[0];
  return [
    `- Runtime: ${report.uniqueFunctionCount} payload${report.uniqueFunctionCount === 1 ? "" : "s"} totaling ${formatBytes(report.uniqueFunctionBytes)}; largest \`${largestFunction.relativePath}\` is ${formatBytes(largestFunction.totalBytes)}.`,
  ];
}

function formatByteMetricTransition(metric) {
  return `${formatBytes(metric.baseline)} -> ${formatBytes(metric.current)} (${formatSizeDelta(metric.delta)})`;
}

function formatCountMetricTransition(metric) {
  return `${metric.baseline} -> ${metric.current} (${formatSignedCount(metric.delta)})`;
}

function isNotableByteDelta(metric) {
  if (metric.delta === 0) {
    return false;
  }

  const referenceBytes = Math.max(metric.baseline, metric.current);
  return getSeverityRank(getEntrySeverity(Math.abs(metric.delta), referenceBytes)) >= 1;
}

function hasFunctionRouteDelta(functionComparison) {
  return (
    functionComparison.publicRoutesAdded.length > 0 ||
    functionComparison.publicRoutesRemoved.length > 0 ||
    functionComparison.internalRoutesAdded.length > 0 ||
    functionComparison.internalRoutesRemoved.length > 0
  );
}

function isNotableFunctionDelta(functionComparison) {
  if (functionComparison.status !== "changed") {
    return true;
  }

  return (
    hasFunctionRouteDelta(functionComparison) || isNotableByteDelta(functionComparison.totalBytes)
  );
}

function summarizeDependencyManifestTakeaway(packageComparison) {
  if (packageComparison === null) {
    return null;
  }

  const parts = [];

  if (packageComparison.runtimeDependenciesAdded.length > 0) {
    parts.push(
      `${packageComparison.runtimeDependenciesAdded.length} runtime dep${packageComparison.runtimeDependenciesAdded.length === 1 ? "" : "s"} added`,
    );
  }

  if (packageComparison.runtimeDependenciesRemoved.length > 0) {
    parts.push(
      `${packageComparison.runtimeDependenciesRemoved.length} runtime dep${packageComparison.runtimeDependenciesRemoved.length === 1 ? "" : "s"} removed`,
    );
  }

  if (packageComparison.runtimeDependenciesChanged.length > 0) {
    parts.push(
      `${packageComparison.runtimeDependenciesChanged.length} runtime dep${packageComparison.runtimeDependenciesChanged.length === 1 ? "" : "s"} changed`,
    );
  }

  if (packageComparison.peerDependenciesAdded.length > 0) {
    parts.push(
      `${packageComparison.peerDependenciesAdded.length} peer dep${packageComparison.peerDependenciesAdded.length === 1 ? "" : "s"} added`,
    );
  }

  if (packageComparison.peerDependenciesRemoved.length > 0) {
    parts.push(
      `${packageComparison.peerDependenciesRemoved.length} peer dep${packageComparison.peerDependenciesRemoved.length === 1 ? "" : "s"} removed`,
    );
  }

  if (packageComparison.peerDependenciesChanged.length > 0) {
    parts.push(
      `${packageComparison.peerDependenciesChanged.length} peer dep${packageComparison.peerDependenciesChanged.length === 1 ? "" : "s"} changed`,
    );
  }

  return parts.length === 0 ? null : parts.join("; ");
}

function formatRouteDeltaEntry(prefix, routes) {
  return routes.map((route) => `${prefix}<code>${escapeHtml(route)}</code>`).join(", ");
}

function summarizeFunctionRouteDelta(functionComparison) {
  const parts = [];

  if (functionComparison.publicRoutesAdded.length > 0) {
    parts.push(`public ${formatRouteDeltaEntry("+", functionComparison.publicRoutesAdded)}`);
  }

  if (functionComparison.publicRoutesRemoved.length > 0) {
    parts.push(`public ${formatRouteDeltaEntry("-", functionComparison.publicRoutesRemoved)}`);
  }

  if (functionComparison.internalRoutesAdded.length > 0) {
    parts.push(`internal ${formatRouteDeltaEntry("+", functionComparison.internalRoutesAdded)}`);
  }

  if (functionComparison.internalRoutesRemoved.length > 0) {
    parts.push(`internal ${formatRouteDeltaEntry("-", functionComparison.internalRoutesRemoved)}`);
  }

  return parts.length === 0 ? "none" : parts.join("<br>");
}

function summarizeBundleWarningCheck(check) {
  if (check.kind === "runtime-dependency") {
    return check.summary;
  }

  return `${check.summary} grew ${formatRatioPercent(check.increaseRatio)}`;
}

function summarizeComparisonTakeaways(comparison) {
  const notableChangedFunctions = comparison.app.functions
    .filter((functionEntry) => functionEntry.changed)
    .filter((functionEntry) => isNotableFunctionDelta(functionEntry));
  const lines = [];
  const failedSizeBudgetChecks =
    comparison.sizeBudget?.checks.filter((check) => check.failed) ?? [];

  if (failedSizeBudgetChecks.length > 0) {
    lines.push(
      `- Bundle warning: ${failedSizeBudgetChecks.map((check) => summarizeBundleWarningCheck(check)).join("; ")}.`,
    );
  }

  if (comparison.package !== null) {
    const packageParts = [];

    if (comparison.package.status === "added") {
      packageParts.push("package added");
    } else if (comparison.package.status === "removed") {
      packageParts.push("package removed");
    }

    if (isNotableByteDelta(comparison.package.packedSizeBytes)) {
      packageParts.push(
        `tarball ${formatByteMetricTransition(comparison.package.packedSizeBytes)}`,
      );
    }

    if (isNotableByteDelta(comparison.package.installedSizeBytes)) {
      packageParts.push(
        `install footprint ${formatByteMetricTransition(comparison.package.installedSizeBytes)}`,
      );
    }

    if (packageParts.length > 0) {
      lines.push(`- Package delta: ${packageParts.join("; ")}.`);
    }
  }

  const runtimeParts = [];

  if (isNotableByteDelta(comparison.app.uniqueFunctionBytes)) {
    runtimeParts.push(
      `function payloads ${formatByteMetricTransition(comparison.app.uniqueFunctionBytes)}`,
    );
  }

  if (comparison.app.publicRouteCount.delta !== 0) {
    runtimeParts.push(
      `public routes ${formatCountMetricTransition(comparison.app.publicRouteCount)}`,
    );
  }

  if (notableChangedFunctions.length > 0) {
    runtimeParts.push(
      `${notableChangedFunctions.length} changed payload${notableChangedFunctions.length === 1 ? "" : "s"}`,
    );
  }

  if (runtimeParts.length > 0) {
    lines.push(`- Runtime delta: ${runtimeParts.join("; ")}.`);
  }

  const dependencyManifestTakeaway = summarizeDependencyManifestTakeaway(comparison.package);

  if (dependencyManifestTakeaway !== null) {
    lines.push(`- Dependency delta: ${dependencyManifestTakeaway}.`);
  }

  if (lines.length === 0) {
    return [`- No notable deltas vs \`${comparison.baselineLabel}\`.`];
  }

  return lines;
}

function renderSummaryTable(report) {
  const lines = ["| Area | Metric | Value |", "| --- | --- | --- |"];

  if (report.publishedPackage) {
    lines.push(
      `| Package | Packed tarball | ${formatBytes(report.publishedPackage.packedSizeBytes)} |`,
    );
    lines.push(
      `| Package | Unpacked publish size | ${formatBytes(report.publishedPackage.unpackedSizeBytes)} |`,
    );
    lines.push(
      `| Package | Installed footprint | ${formatBytes(report.publishedPackage.installedSizeBytes)} |`,
    );
  }

  lines.push(`| Runtime | Unique function payloads | ${report.uniqueFunctionCount} |`);
  lines.push(`| Runtime | Total function bytes | ${formatBytes(report.uniqueFunctionBytes)} |`);
  lines.push("");

  return lines;
}

function renderDependencyManifestDelta(packageComparison, baselineLabel) {
  if (packageComparison === null) {
    return [];
  }

  const runtimeChangeCount =
    packageComparison.runtimeDependenciesAdded.length +
    packageComparison.runtimeDependenciesChanged.length +
    packageComparison.runtimeDependenciesRemoved.length;
  const peerChangeCount =
    packageComparison.peerDependenciesAdded.length +
    packageComparison.peerDependenciesChanged.length +
    packageComparison.peerDependenciesRemoved.length;

  if (runtimeChangeCount === 0 && peerChangeCount === 0) {
    return [];
  }

  const lines = [
    "<details>",
    `<summary>Dependency manifest changes vs <code>${escapeHtml(baselineLabel)}</code></summary>`,
    "",
  ];

  if (runtimeChangeCount > 0) {
    lines.push("**Runtime dependencies**", "");

    if (packageComparison.runtimeDependenciesAdded.length > 0) {
      lines.push(
        `- Added: ${packageComparison.runtimeDependenciesAdded.map((dependency) => `\`${dependency}\``).join(", ")}`,
      );
    }

    if (packageComparison.runtimeDependenciesRemoved.length > 0) {
      lines.push(
        `- Removed: ${packageComparison.runtimeDependenciesRemoved.map((dependency) => `\`${dependency}\``).join(", ")}`,
      );
    }

    if (packageComparison.runtimeDependenciesChanged.length > 0) {
      lines.push(
        `- Changed: ${packageComparison.runtimeDependenciesChanged.map((dependency) => `\`${dependency.baseline}\` -> \`${dependency.current}\``).join(", ")}`,
      );
    }

    lines.push("");
  }

  if (peerChangeCount > 0) {
    lines.push("**Peer dependencies**", "");

    if (packageComparison.peerDependenciesAdded.length > 0) {
      lines.push(
        `- Added: ${packageComparison.peerDependenciesAdded.map((dependency) => `\`${dependency}\``).join(", ")}`,
      );
    }

    if (packageComparison.peerDependenciesRemoved.length > 0) {
      lines.push(
        `- Removed: ${packageComparison.peerDependenciesRemoved.map((dependency) => `\`${dependency}\``).join(", ")}`,
      );
    }

    if (packageComparison.peerDependenciesChanged.length > 0) {
      lines.push(
        `- Changed: ${packageComparison.peerDependenciesChanged.map((dependency) => `\`${dependency.baseline}\` -> \`${dependency.current}\``).join(", ")}`,
      );
    }

    lines.push("");
  }

  lines.push("</details>", "");
  return lines;
}

function renderFunctionDeltaSection(comparison) {
  const changedFunctions = comparison.app.functions.filter(
    (functionEntry) => functionEntry.changed,
  );

  if (changedFunctions.length === 0) {
    return [];
  }

  const lines = [
    "<details>",
    `<summary>Changed function payloads vs <code>${escapeHtml(comparison.baselineLabel)}</code> (${changedFunctions.length})</summary>`,
    "",
    "| Function | Status | Baseline | Current | Delta | Route changes |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const functionComparison of changedFunctions) {
    lines.push(
      `| \`${functionComparison.relativePath}\` | ${functionComparison.status} | ${formatBytes(functionComparison.totalBytes.baseline)} | ${formatBytes(functionComparison.totalBytes.current)} | ${formatSizeDelta(functionComparison.totalBytes.delta)} | ${summarizeFunctionRouteDelta(functionComparison)} |`,
    );
  }

  lines.push("", "</details>", "");
  return lines;
}

function renderSizeBudgetSection(report) {
  const sizeBudget = report.comparison?.sizeBudget;

  if (!sizeBudget?.failed) {
    return [];
  }

  const failedChecks = sizeBudget.checks.filter((check) => check.failed);
  const acknowledged = report.sizeBudgetAcknowledged === true;
  const lines = [
    `### ${acknowledged ? "⚠️ Bundle Warning Acknowledged" : "❌ Bundle Warning: Action Will Fail"}`,
    "",
    acknowledged
      ? "The bundle warning policy was exceeded, but the `acknowledge-bundle-warning` label is present so the check is allowed to pass."
      : "This action will fail because the bundle warning policy was exceeded. Add the `acknowledge-bundle-warning` label to acknowledge the regression and allow the check to pass without regenerating this report.",
    "",
    "| Area | Warning | Details |",
    "| --- | --- | --- |",
  ];

  for (const check of failedChecks) {
    if (check.kind === "runtime-dependency") {
      lines.push(
        `| ${check.area} | ${check.metric} | New runtime dependency \`${check.dependency}\` was added. Runtime dependencies increase install footprint; prefer a vendored devDependency when possible. |`,
      );
      continue;
    }

    lines.push(
      `| ${check.area} | ${check.metric} | ${formatBytes(check.baseline)} -> ${formatBytes(check.current)}; ${formatSizeDelta(check.delta)} (${formatRatioPercent(check.increaseRatio)}) over limit ${formatRatioPercent(check.thresholdRatio)} |`,
    );
  }

  lines.push("");
  return lines;
}

function renderComparisonSection(comparison) {
  const lines = [`### Delta vs \`${comparison.baselineLabel}\``, ""];

  lines.push("| Area | Metric | Baseline | Current | Delta |");
  lines.push("| --- | --- | --- | --- | --- |");

  if (comparison.package !== null) {
    lines.push(
      `| Package | Packed tarball | ${formatBytes(comparison.package.packedSizeBytes.baseline)} | ${formatBytes(comparison.package.packedSizeBytes.current)} | ${formatSizeDelta(comparison.package.packedSizeBytes.delta)} |`,
    );
    lines.push(
      `| Package | Unpacked publish size | ${formatBytes(comparison.package.unpackedSizeBytes.baseline)} | ${formatBytes(comparison.package.unpackedSizeBytes.current)} | ${formatSizeDelta(comparison.package.unpackedSizeBytes.delta)} |`,
    );
    lines.push(
      `| Package | Installed footprint | ${formatBytes(comparison.package.installedSizeBytes.baseline)} | ${formatBytes(comparison.package.installedSizeBytes.current)} | ${formatSizeDelta(comparison.package.installedSizeBytes.delta)} |`,
    );
    lines.push(
      `| Package | Published files | ${comparison.package.publishedFileCount.baseline} | ${comparison.package.publishedFileCount.current} | ${formatSignedCount(comparison.package.publishedFileCount.delta)} |`,
    );
    lines.push(
      `| Package | Installed files | ${comparison.package.installedFileCount.baseline} | ${comparison.package.installedFileCount.current} | ${formatSignedCount(comparison.package.installedFileCount.delta)} |`,
    );
  }

  lines.push(
    `| Runtime | Unique function payloads | ${comparison.app.uniqueFunctionCount.baseline} | ${comparison.app.uniqueFunctionCount.current} | ${formatSignedCount(comparison.app.uniqueFunctionCount.delta)} |`,
  );
  lines.push(
    `| Runtime | Total function bytes | ${formatBytes(comparison.app.uniqueFunctionBytes.baseline)} | ${formatBytes(comparison.app.uniqueFunctionBytes.current)} | ${formatSizeDelta(comparison.app.uniqueFunctionBytes.delta)} |`,
  );
  lines.push(
    `| Runtime | Public routes | ${comparison.app.publicRouteCount.baseline} | ${comparison.app.publicRouteCount.current} | ${formatSignedCount(comparison.app.publicRouteCount.delta)} |`,
  );
  lines.push("");

  lines.push(...renderDependencyManifestDelta(comparison.package, comparison.baselineLabel));
  lines.push(...renderFunctionDeltaSection(comparison));

  return lines;
}

function renderMetadataSection(report) {
  const lines = ["<details>", "<summary>Build Metadata</summary>", ""];
  lines.push(`- Preset: \`${report.nitroMetadata?.preset ?? "unknown"}\``);
  lines.push(
    `- Nitro: \`${report.nitroMetadata?.frameworkName ?? "nitro"}@${report.nitroMetadata?.frameworkVersion ?? "unknown"}\``,
  );
  lines.push(
    `- Output directory: \`${normalizePath(relative(process.cwd(), report.outputDirectory))}\``,
  );
  lines.push(
    `- Build metadata timestamp: ${formatDate(report.nitroMetadata?.date ?? report.generatedAt)}`,
  );
  lines.push(
    `- Route aliases: ${report.publicRouteCount} public, ${report.internalRouteCount} internal (${report.functionAliasCount} total aliases)`,
  );
  lines.push(`- Vercel routes in config: ${report.configRouteCount}`);
  lines.push(`- Severity legend: ${describeSeverityLegend()}`);
  lines.push("", "</details>", "");

  return lines;
}

function renderPublishedPackageSection(publishedPackage) {
  const lines = ["<details>", "<summary>Package Drill-Down</summary>", ""];
  lines.push(`### Package Details`, "");
  lines.push(`- Package: \`${publishedPackage.packageName}@${publishedPackage.version}\``);
  lines.push(
    `- Package directory: \`${normalizePath(relative(process.cwd(), publishedPackage.packageRoot))}\``,
  );
  lines.push(
    `- Tarball: ${formatBytes(publishedPackage.packedSizeBytes)}${publishedPackage.tarballFilename ? ` (\`${publishedPackage.tarballFilename}\`)` : ""}`,
  );
  lines.push(
    `- Unpacked payload: ${formatBytes(publishedPackage.unpackedSizeBytes)} across ${publishedPackage.publishedFileCount} published file${publishedPackage.publishedFileCount === 1 ? "" : "s"}`,
  );
  lines.push(
    `- Installed footprint: ${formatBytes(publishedPackage.installedSizeBytes)} across ${publishedPackage.installedFileCount} installed file${publishedPackage.installedFileCount === 1 ? "" : "s"}`,
  );
  lines.push(`- Installed root package: ${formatBytes(publishedPackage.installedPackageBytes)}`);
  lines.push(`- Installed dependencies: ${formatBytes(publishedPackage.installedDependencyBytes)}`);
  lines.push(`- Runtime dependencies: ${publishedPackage.runtimeDependencies.length}`);
  lines.push(
    `- Peer dependencies: ${publishedPackage.peerDependencies.length}${publishedPackage.peerDependencies.some((dependency) => dependency.optional) ? ` (${publishedPackage.peerDependencies.filter((dependency) => dependency.optional).length} optional)` : ""}`,
  );
  lines.push(
    "",
    "_Installed footprint is measured from an isolated temporary `npm install` of the packed tarball._",
    "",
  );

  lines.push(
    ...renderHeavyDependencyList(
      publishedPackage.topInstalledPackages,
      publishedPackage.installedSizeBytes,
      5,
    ),
  );

  const publishedFileEntries = buildTopEntryChart(
    publishedPackage.topPublishedFiles.map((file) => ({
      bytes: file.bytes,
      label: file.path,
    })),
    publishedPackage.unpackedSizeBytes,
    {
      maxEntries: 6,
      otherLabel: "Other published files",
    },
  );

  if (publishedFileEntries.length > 0) {
    lines.push("<details>");
    lines.push("<summary>Publish payload breakdown</summary>");
    lines.push("");
    lines.push(
      ...renderAsciiBarChart(
        "Published file size",
        publishedFileEntries,
        publishedPackage.unpackedSizeBytes,
      ),
    );
    lines.push("</details>", "");
  }

  const installedPackageEntries = buildTopEntryChart(
    publishedPackage.topInstalledPackages.map((pkg) => ({
      bytes: pkg.bytes,
      label: pkg.name,
    })),
    publishedPackage.installedSizeBytes,
    {
      maxEntries: INSTALLED_PACKAGE_BREAKDOWN_MAX_ENTRIES,
      minBytes: INSTALLED_PACKAGE_BREAKDOWN_MIN_BYTES,
      otherLabel: "Other installed packages",
    },
  );

  if (installedPackageEntries.length > 0) {
    lines.push("<details>");
    lines.push("<summary>Installed footprint breakdown</summary>");
    lines.push("");
    lines.push(
      ...renderAsciiBarChart(
        "Installed package size",
        installedPackageEntries,
        publishedPackage.installedSizeBytes,
      ),
    );
    lines.push("</details>", "");
  }

  lines.push(
    ...renderDependencyTable("Runtime dependencies", publishedPackage.runtimeDependencies),
  );
  lines.push(...renderDependencyTable("Peer dependencies", publishedPackage.peerDependencies));
  lines.push("</details>", "");

  return lines;
}

function renderBundleVisualizationSection(report) {
  const lines = ["### Payload Size Graph", ""];
  lines.push(
    ...renderAsciiBarChart(
      "Unique function payload size and share of total",
      limitChartEntries(
        report.functions.map((functionEntry) => ({
          bytes: functionEntry.totalBytes,
          label: functionEntry.relativePath,
        })),
        8,
      ),
      report.uniqueFunctionBytes,
    ),
  );

  return lines;
}

function renderFunctionSection(functionEntry) {
  const primarySignal = selectPrimarySignal(functionEntry);
  const functionSignal = summarizeFunctionSignal(functionEntry);
  const functionSeverity =
    primarySignal === null
      ? getEntrySeverity(functionEntry.totalBytes, functionEntry.totalBytes)
      : primarySignal.severity;
  const lines = ["<details>"];
  const tracedDependencyEntries = buildTopEntryChart(
    functionEntry.topTracedPackages.map((dependency) => ({
      bytes: dependency.bytes,
      label: dependency.name,
    })),
    functionEntry.tracedDependencyBytes,
    {
      maxEntries: 6,
      otherLabel: "Other traced dependencies",
    },
  );
  const bundledFileEntries = buildTopEntryChart(
    functionEntry.topBundledFiles.map((file) => ({
      bytes: file.bytes,
      label: file.path,
    })),
    functionEntry.functionFilesBytes,
    {
      maxEntries: 6,
      otherLabel: "Other bundled files",
    },
  );

  lines.push(
    `<summary>${functionSeverity.icon} <code>${functionEntry.relativePath}</code> • ${formatRouteCount(functionEntry.publicRoutes.length, functionEntry.internalRoutes.length)} • ${formatBytes(functionEntry.totalBytes)}</summary>`,
  );
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Public routes | ${formatCodeLines(functionEntry.publicRoutes)} |`);

  if (functionEntry.internalRoutes.length > 0) {
    lines.push(`| Internal aliases | ${formatCodeLines(functionEntry.internalRoutes)} |`);
  }

  lines.push(`| Runtime | \`${functionEntry.runtime ?? "unknown"}\` |`);
  lines.push(`| Handler | \`${functionEntry.handler ?? "unknown"}\` |`);
  lines.push(`| Payload | ${formatBytes(functionEntry.totalBytes)} |`);
  lines.push(
    `| Function files | ${formatBytes(functionEntry.functionFilesBytes)} across ${functionEntry.fileCount} file${functionEntry.fileCount === 1 ? "" : "s"} |`,
  );
  lines.push(`| Traced dependencies | ${formatBytes(functionEntry.tracedDependencyBytes)} |`);

  if (functionSignal !== null) {
    lines.push(`| Signal | ${functionSignal} |`);
  }

  if (tracedDependencyEntries.length > 0 || bundledFileEntries.length > 0) {
    lines.push("");
    lines.push(`**${functionSeverity.icon} 🔎 Dependency Analysis**`, "");

    if (tracedDependencyEntries.length > 0) {
      lines.push("🔎 Traced packages:", "");
      lines.push(
        ...renderAsciiBarChart(
          "Traced dependency size",
          tracedDependencyEntries,
          functionEntry.tracedDependencyBytes,
        ),
      );
      lines.push("");
    }

    if (bundledFileEntries.length > 0) {
      lines.push("📦 Bundled files:", "");
      lines.push(
        ...renderAsciiBarChart(
          "Bundled file size",
          bundledFileEntries,
          functionEntry.functionFilesBytes,
        ),
      );
      lines.push("");
    }
  }

  lines.push("");
  lines.push("**🧾 Vercel Config**", "");
  lines.push("```json");
  lines.push(JSON.stringify(functionEntry.vcConfig, null, 2));
  lines.push("```");
  lines.push("</details>");
  lines.push("");

  return lines;
}

function renderFunctionDrillDown(report) {
  if (report.functions.length === 0) {
    return [];
  }

  const lines = ["<details>", "<summary>Function Drill-Down</summary>", ""];
  lines.push(...renderBundleVisualizationSection(report));
  lines.push("### Top Function Payloads", "");

  for (const [index, functionEntry] of report.functions.entries()) {
    lines.push(...renderFunctionSection(functionEntry));

    if (index < report.functions.length - 1) {
      lines.push("---", "");
    }
  }

  lines.push("</details>", "");
  return lines;
}

/**
 * Collects a bundle report from one Nitro Vercel build output tree.
 */
export async function collectNitroBundleReport(options) {
  const appRoot = resolve(options.appRoot);
  const requestedOutputDirectory = resolve(
    options.outputDirectory ?? join(appRoot, ".vercel", "output"),
  );
  const outputDirectory = await realpath(requestedOutputDirectory).catch(
    () => requestedOutputDirectory,
  );
  const functionsRoot = join(outputDirectory, "functions");
  const staticRoot = join(outputDirectory, "static");

  if (!(await pathExists(functionsRoot))) {
    throw new Error(
      `Missing functions output at "${functionsRoot}". Build the app in Vercel mode first.`,
    );
  }

  const [config, functionEntries, nitroMetadata, publishedPackage, staticFiles] = await Promise.all(
    [
      pathExists(join(outputDirectory, "config.json")).then((exists) =>
        exists ? readJson(join(outputDirectory, "config.json")) : null,
      ),
      discoverFunctionEntries(functionsRoot),
      pathExists(join(outputDirectory, "nitro.json")).then((exists) =>
        exists ? readJson(join(outputDirectory, "nitro.json")) : null,
      ),
      options.packageRoot
        ? collectPublishedPackageReport({
            packageLabel: options.packageLabel,
            packageRoot: options.packageRoot,
          })
        : Promise.resolve(null),
      pathExists(staticRoot).then((exists) => (exists ? walkRegularFiles(staticRoot) : [])),
    ],
  );

  /** @type {Map<string, { aliases: { isInternalRoute: boolean; relativeEntryPath: string; route: string }[]; realDirectoryPath: string }>} */
  const functionsByRealPath = new Map();

  for (const entry of functionEntries) {
    const existingFunction = functionsByRealPath.get(entry.realDirectoryPath);

    if (existingFunction) {
      existingFunction.aliases.push({
        isInternalRoute: entry.isInternalRoute,
        relativeEntryPath: entry.relativeEntryPath,
        route: entry.route,
      });
      continue;
    }

    functionsByRealPath.set(entry.realDirectoryPath, {
      aliases: [
        {
          isInternalRoute: entry.isInternalRoute,
          relativeEntryPath: entry.relativeEntryPath,
          route: entry.route,
        },
      ],
      realDirectoryPath: entry.realDirectoryPath,
    });
  }

  const functions = await Promise.all(
    [...functionsByRealPath.values()].map(async (functionEntry) => {
      const [functionConfig, functionFiles] = await Promise.all([
        readJson(join(functionEntry.realDirectoryPath, ".vc-config.json")),
        walkRegularFiles(functionEntry.realDirectoryPath),
      ]);

      const relativeFunctionPath = normalizePath(
        relative(outputDirectory, functionEntry.realDirectoryPath),
      );
      const topBundledFiles = summarizeTopFiles(
        functionFiles.filter((file) => !file.relativePath.startsWith("node_modules/")),
        5,
      );
      const topTracedPackages = summarizeTopPackages(functionFiles, 5);
      let totalBytes = 0;
      let tracedDependencyBytes = 0;

      for (const file of functionFiles) {
        totalBytes += file.bytes;

        if (file.relativePath.startsWith("node_modules/")) {
          tracedDependencyBytes += file.bytes;
        }
      }

      const publicRoutes = functionEntry.aliases
        .filter((alias) => !alias.isInternalRoute)
        .map((alias) => alias.route)
        .sort(compareRoutes);
      const internalRoutes = functionEntry.aliases
        .filter((alias) => alias.isInternalRoute)
        .map((alias) => alias.route)
        .sort(compareRoutes);

      return {
        aliases: functionEntry.aliases
          .map((alias) => ({
            path: alias.relativeEntryPath,
            route: alias.route,
          }))
          .sort((left, right) => compareRoutes(left.route, right.route)),
        fileCount: functionFiles.length,
        functionFilesBytes: totalBytes - tracedDependencyBytes,
        handler: functionConfig.handler ?? null,
        internalRoutes,
        publicRoutes,
        relativePath: relativeFunctionPath,
        runtime: functionConfig.runtime ?? null,
        topBundledFiles,
        topTracedPackages,
        totalBytes,
        tracedDependencyBytes,
        vcConfig: functionConfig,
      };
    }),
  );

  functions.sort(
    (left, right) =>
      right.totalBytes - left.totalBytes || comparePaths(left.relativePath, right.relativePath),
  );

  const uniqueFunctionBytes = functions.reduce(
    (total, functionEntry) => total + functionEntry.totalBytes,
    0,
  );
  const staticBytes = staticFiles.reduce((total, file) => total + file.bytes, 0);

  return {
    appLabel: options.appLabel ?? basename(appRoot),
    appRoot,
    configRouteCount: Array.isArray(config?.routes) ? config.routes.length : 0,
    functionAliasCount: functionEntries.length,
    functions,
    generatedAt: new Date().toISOString(),
    internalRouteCount: functions.reduce(
      (total, functionEntry) => total + functionEntry.internalRoutes.length,
      0,
    ),
    nitroMetadata:
      nitroMetadata === null
        ? null
        : {
            date: typeof nitroMetadata.date === "string" ? nitroMetadata.date : null,
            frameworkName:
              typeof nitroMetadata.framework?.name === "string"
                ? nitroMetadata.framework.name
                : null,
            frameworkVersion:
              typeof nitroMetadata.framework?.version === "string"
                ? nitroMetadata.framework.version
                : null,
            preset:
              typeof nitroMetadata.preset === "string"
                ? nitroMetadata.preset
                : typeof nitroMetadata.config?.vercel === "object"
                  ? "vercel"
                  : null,
            serverEntry:
              typeof nitroMetadata.serverEntry === "string" ? nitroMetadata.serverEntry : null,
          },
    outputDirectory: requestedOutputDirectory,
    publishedPackage,
    publicRouteCount: functions.reduce(
      (total, functionEntry) => total + functionEntry.publicRoutes.length,
      0,
    ),
    staticAssetBytes: staticBytes,
    staticAssetCount: staticFiles.length,
    uniqueFunctionBytes,
    uniqueFunctionCount: functions.length,
  };
}

/**
 * Compares one Nitro bundle report against a baseline snapshot.
 */
export function compareNitroBundleReports(report, baselineReport, options) {
  return createNitroBundleReportComparison(report, baselineReport, options);
}

/**
 * Renders one Markdown report suitable for a GitHub PR comment or job summary.
 */
export function renderNitroBundleReportMarkdown(report) {
  const keyTakeaways = report.comparison
    ? summarizeComparisonTakeaways(report.comparison)
    : [
        ...(report.publishedPackage ? summarizePackageTakeaways(report.publishedPackage) : []),
        ...summarizeFunctionTakeaways(report),
      ];
  const lines = [
    `## Bundle + Package Summary: \`${report.appLabel}\``,
    "",
    "**Key takeaways**",
    "",
    ...keyTakeaways,
    "",
  ];

  if (report.comparison) {
    lines.push(...renderSizeBudgetSection(report));
    lines.push(...renderComparisonSection(report.comparison));
  }

  if (!report.comparison) {
    lines.push(...renderSummaryTable(report));
  }

  lines.push(...renderMetadataSection(report));

  if (report.publishedPackage) {
    lines.push(...renderPublishedPackageSection(report.publishedPackage));
  }

  if (report.functions.length === 0) {
    lines.push("No functions were found in the Vercel output.");

    return lines.join("\n");
  }

  lines.push(...renderFunctionDrillDown(report));

  return lines.join("\n").trimEnd();
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: node ./scripts/nitro-bundle-report.mjs --app <path> [options]",
      "",
      "Options:",
      "  --app <path>              Application root to inspect",
      "  --app-label <label>       Display label used in the report",
      "  --package <path>          Package root to inspect with pack/install publish analysis",
      "  --package-label <label>   Display label used for the package section",
      "  --baseline-json <path>    Compare the current report to a baseline JSON snapshot",
      "  --baseline-label <label>  Display label used for the baseline comparison",
      "  --size-budget-acknowledged  Mark size budget failures as acknowledged in Markdown",
      "  --output-dir <path>       Override the build output directory",
      "  --output-json <path>      Write the JSON report to this file",
      "  --output-markdown <path>  Write the Markdown report to this file",
      "  --help                    Show this help text",
      "",
    ].join("\n"),
  );
}

function parseArguments(argv) {
  /** @type {{ appLabel?: string; appRoot?: string; baselineLabel?: string; baselineReportJsonPath?: string; outputDirectory?: string; outputJsonPath?: string; outputMarkdownPath?: string; packageLabel?: string; packageRoot?: string; sizeBudgetAcknowledged: boolean }} */
  const parsedArguments = {
    sizeBudgetAcknowledged: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help") {
      printUsage();
      process.exit(0);
    }

    if (argument === "--size-budget-acknowledged") {
      parsedArguments.sizeBudgetAcknowledged = true;
      continue;
    }

    const value = argv[index + 1];

    if (value === undefined) {
      throw new Error(`Missing value for "${argument}".`);
    }

    if (argument === "--app") {
      parsedArguments.appRoot = value;
      index += 1;
      continue;
    }

    if (argument === "--app-label") {
      parsedArguments.appLabel = value;
      index += 1;
      continue;
    }

    if (argument === "--baseline-json") {
      parsedArguments.baselineReportJsonPath = value;
      index += 1;
      continue;
    }

    if (argument === "--baseline-label") {
      parsedArguments.baselineLabel = value;
      index += 1;
      continue;
    }

    if (argument === "--output-dir") {
      parsedArguments.outputDirectory = value;
      index += 1;
      continue;
    }

    if (argument === "--package") {
      parsedArguments.packageRoot = value;
      index += 1;
      continue;
    }

    if (argument === "--package-label") {
      parsedArguments.packageLabel = value;
      index += 1;
      continue;
    }

    if (argument === "--output-json") {
      parsedArguments.outputJsonPath = value;
      index += 1;
      continue;
    }

    if (argument === "--output-markdown") {
      parsedArguments.outputMarkdownPath = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument "${argument}".`);
  }

  if (!parsedArguments.appRoot) {
    throw new Error('The "--app" option is required.');
  }

  return parsedArguments;
}

async function writeOutputFile(path, contents) {
  await mkdir(dirname(resolve(path)), {
    recursive: true,
  });
  await writeFile(path, contents, "utf8");
}

async function main() {
  const argumentsResult = parseArguments(process.argv.slice(2));
  const report = await collectNitroBundleReport({
    appLabel: argumentsResult.appLabel ?? normalizePath(argumentsResult.appRoot),
    appRoot: argumentsResult.appRoot,
    outputDirectory: argumentsResult.outputDirectory,
    packageLabel: argumentsResult.packageLabel,
    packageRoot: argumentsResult.packageRoot,
  });
  const baselineReport = argumentsResult.baselineReportJsonPath
    ? await readJson(resolve(argumentsResult.baselineReportJsonPath))
    : null;
  const outputReport =
    baselineReport === null
      ? report
      : {
          ...report,
          comparison: compareNitroBundleReports(report, baselineReport, {
            baselineLabel: argumentsResult.baselineLabel,
          }),
          sizeBudgetAcknowledged: argumentsResult.sizeBudgetAcknowledged,
        };
  const markdown = renderNitroBundleReportMarkdown(outputReport);

  if (argumentsResult.outputJsonPath) {
    await writeOutputFile(
      `${argumentsResult.outputJsonPath}`,
      `${JSON.stringify(outputReport, null, 2)}\n`,
    );
  }

  if (argumentsResult.outputMarkdownPath) {
    await writeOutputFile(argumentsResult.outputMarkdownPath, `${markdown}\n`);
  }

  if (!argumentsResult.outputMarkdownPath) {
    process.stdout.write(`${markdown}\n`);
  }
}

const executedScriptPath = process.argv[1] ? resolve(process.argv[1]) : null;
const moduleScriptPath = resolve(fileURLToPath(import.meta.url));

if (
  executedScriptPath !== null &&
  moduleScriptPath !== null &&
  executedScriptPath === moduleScriptPath
) {
  await main();
}
