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

function compareNumericMetric(currentValue, baselineValue) {
  return {
    baseline: baselineValue,
    current: currentValue,
    delta: currentValue - baselineValue,
  };
}

const SIZE_BUDGET_THRESHOLD = 0.1;

function calculateIncreaseRatio(metric) {
  if (metric.delta <= 0) {
    return 0;
  }

  if (metric.baseline <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return metric.delta / metric.baseline;
}

function createSizeBudgetCheck(metric, options) {
  const increaseRatio = calculateIncreaseRatio(metric);

  return {
    ...options,
    baseline: metric.baseline,
    current: metric.current,
    delta: metric.delta,
    failed: increaseRatio > SIZE_BUDGET_THRESHOLD,
    increaseRatio,
    kind: "size",
    thresholdRatio: SIZE_BUDGET_THRESHOLD,
  };
}

function createRuntimeDependencyChecks(packageComparison) {
  if (packageComparison === null) {
    return [];
  }

  return packageComparison.runtimeDependenciesAdded.map((dependency) => ({
    area: "Package",
    dependency,
    failed: true,
    kind: "runtime-dependency",
    metric: "Runtime dependency added",
    summary: `runtime dependency ${dependency} added`,
  }));
}

function createInitInstallSizeBudgetChecks(initInstallComparison) {
  if (initInstallComparison === null || initInstallComparison.status !== "present") {
    return [];
  }

  return [
    createSizeBudgetCheck(initInstallComparison.installedSizeBytes, {
      area: "Init",
      metric: "Installed footprint",
      summary: "`eve init` install footprint",
    }),
  ];
}

function createSizeBudget(appComparison, packageComparison, initInstallComparison) {
  const checks = [
    createSizeBudgetCheck(appComparison.uniqueFunctionBytes, {
      area: "Runtime",
      metric: "Total function bytes",
      summary: "function payloads",
    }),
  ];

  if (packageComparison !== null) {
    checks.unshift(
      createSizeBudgetCheck(packageComparison.installedSizeBytes, {
        area: "Package",
        metric: "Installed footprint",
        summary: "install footprint",
      }),
    );
  }

  checks.push(...createInitInstallSizeBudgetChecks(initInstallComparison));
  checks.push(...createRuntimeDependencyChecks(packageComparison));

  return {
    checks,
    failed: checks.some((check) => check.failed),
    thresholdRatio: SIZE_BUDGET_THRESHOLD,
  };
}

function readMetricValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readSortedRoutes(routes) {
  return Array.isArray(routes)
    ? routes.filter((route) => typeof route === "string").sort(compareRoutes)
    : [];
}

function formatDependencyKey(dependency) {
  const optionalSuffix = dependency.optional === true ? " (optional)" : "";
  const rangeSuffix =
    typeof dependency.range === "string" && dependency.range.length > 0
      ? `@${dependency.range}`
      : "";

  return `${dependency.name}${rangeSuffix}${optionalSuffix}`;
}

function readDependencyEntries(dependencies) {
  return Array.isArray(dependencies)
    ? dependencies
        .filter(
          (dependency) =>
            dependency && typeof dependency === "object" && typeof dependency.name === "string",
        )
        .map((dependency) => ({
          key: formatDependencyKey(dependency),
          name: dependency.name,
        }))
        .sort((left, right) => comparePaths(left.key, right.key))
    : [];
}

function compareDependencyEntries(currentEntries, baselineEntries) {
  const currentByName = new Map(currentEntries.map((dependency) => [dependency.name, dependency]));
  const baselineByName = new Map(
    baselineEntries.map((dependency) => [dependency.name, dependency]),
  );

  return {
    added: currentEntries
      .filter((dependency) => !baselineByName.has(dependency.name))
      .map((dependency) => dependency.key)
      .sort(comparePaths),
    changed: currentEntries
      .map((dependency) => {
        const baselineDependency = baselineByName.get(dependency.name);

        return baselineDependency !== undefined && baselineDependency.key !== dependency.key
          ? {
              baseline: baselineDependency.key,
              current: dependency.key,
              name: dependency.name,
            }
          : null;
      })
      .filter(Boolean)
      .sort((left, right) => comparePaths(left.name, right.name)),
    removed: baselineEntries
      .filter((dependency) => !currentByName.has(dependency.name))
      .map((dependency) => dependency.key)
      .sort(comparePaths),
  };
}

function compareStringLists(currentValues, baselineValues) {
  const currentSet = new Set(currentValues);
  const baselineSet = new Set(baselineValues);
  const added = currentValues.filter((value) => !baselineSet.has(value)).sort(comparePaths);
  const removed = baselineValues.filter((value) => !currentSet.has(value)).sort(comparePaths);

  return {
    added,
    removed,
  };
}

function getFunctionStatus(currentFunction, baselineFunction) {
  if (baselineFunction === null) {
    return "added";
  }

  if (currentFunction === null) {
    return "removed";
  }

  return "changed";
}

function compareFunctions(currentFunctions, baselineFunctions) {
  const functionsByPath = new Map();

  for (const functionEntry of baselineFunctions) {
    if (typeof functionEntry?.relativePath === "string") {
      functionsByPath.set(functionEntry.relativePath, {
        baseline: functionEntry,
        current: null,
      });
    }
  }

  for (const functionEntry of currentFunctions) {
    if (typeof functionEntry?.relativePath !== "string") {
      continue;
    }

    const existingFunction = functionsByPath.get(functionEntry.relativePath);

    if (existingFunction) {
      existingFunction.current = functionEntry;
      continue;
    }

    functionsByPath.set(functionEntry.relativePath, {
      baseline: null,
      current: functionEntry,
    });
  }

  return [...functionsByPath.entries()]
    .map(([relativePath, entries]) => {
      const baselineFunction = entries.baseline;
      const currentFunction = entries.current;
      const publicRouteDiff = compareStringLists(
        readSortedRoutes(currentFunction?.publicRoutes),
        readSortedRoutes(baselineFunction?.publicRoutes),
      );
      const internalRouteDiff = compareStringLists(
        readSortedRoutes(currentFunction?.internalRoutes),
        readSortedRoutes(baselineFunction?.internalRoutes),
      );
      const totalBytes = compareNumericMetric(
        readMetricValue(currentFunction?.totalBytes),
        readMetricValue(baselineFunction?.totalBytes),
      );
      const functionFilesBytes = compareNumericMetric(
        readMetricValue(currentFunction?.functionFilesBytes),
        readMetricValue(baselineFunction?.functionFilesBytes),
      );
      const tracedDependencyBytes = compareNumericMetric(
        readMetricValue(currentFunction?.tracedDependencyBytes),
        readMetricValue(baselineFunction?.tracedDependencyBytes),
      );
      const fileCount = compareNumericMetric(
        readMetricValue(currentFunction?.fileCount),
        readMetricValue(baselineFunction?.fileCount),
      );
      const changed =
        totalBytes.delta !== 0 ||
        functionFilesBytes.delta !== 0 ||
        tracedDependencyBytes.delta !== 0 ||
        fileCount.delta !== 0 ||
        publicRouteDiff.added.length > 0 ||
        publicRouteDiff.removed.length > 0 ||
        internalRouteDiff.added.length > 0 ||
        internalRouteDiff.removed.length > 0 ||
        currentFunction === null ||
        baselineFunction === null;

      return {
        changed,
        fileCount,
        functionFilesBytes,
        internalRoutesAdded: internalRouteDiff.added,
        internalRoutesRemoved: internalRouteDiff.removed,
        publicRoutesAdded: publicRouteDiff.added,
        publicRoutesRemoved: publicRouteDiff.removed,
        relativePath,
        status: changed ? getFunctionStatus(currentFunction, baselineFunction) : "unchanged",
        totalBytes,
        tracedDependencyBytes,
      };
    })
    .sort((left, right) => {
      const changeDifference = Number(right.changed) - Number(left.changed);

      if (changeDifference !== 0) {
        return changeDifference;
      }

      const deltaDifference = Math.abs(right.totalBytes.delta) - Math.abs(left.totalBytes.delta);

      return deltaDifference || comparePaths(left.relativePath, right.relativePath);
    });
}

function comparePublishedPackages(currentPackage, baselinePackage) {
  if (currentPackage === null && baselinePackage === null) {
    return null;
  }

  const runtimeDependencyDiff = compareDependencyEntries(
    readDependencyEntries(currentPackage?.runtimeDependencies),
    readDependencyEntries(baselinePackage?.runtimeDependencies),
  );
  const peerDependencyDiff = compareDependencyEntries(
    readDependencyEntries(currentPackage?.peerDependencies),
    readDependencyEntries(baselinePackage?.peerDependencies),
  );

  return {
    installedDependencyBytes: compareNumericMetric(
      readMetricValue(currentPackage?.installedDependencyBytes),
      readMetricValue(baselinePackage?.installedDependencyBytes),
    ),
    installedFileCount: compareNumericMetric(
      readMetricValue(currentPackage?.installedFileCount),
      readMetricValue(baselinePackage?.installedFileCount),
    ),
    installedPackageBytes: compareNumericMetric(
      readMetricValue(currentPackage?.installedPackageBytes),
      readMetricValue(baselinePackage?.installedPackageBytes),
    ),
    installedSizeBytes: compareNumericMetric(
      readMetricValue(currentPackage?.installedSizeBytes),
      readMetricValue(baselinePackage?.installedSizeBytes),
    ),
    packedSizeBytes: compareNumericMetric(
      readMetricValue(currentPackage?.packedSizeBytes),
      readMetricValue(baselinePackage?.packedSizeBytes),
    ),
    peerDependenciesAdded: peerDependencyDiff.added,
    peerDependenciesChanged: peerDependencyDiff.changed,
    peerDependenciesRemoved: peerDependencyDiff.removed,
    publishedFileCount: compareNumericMetric(
      readMetricValue(currentPackage?.publishedFileCount),
      readMetricValue(baselinePackage?.publishedFileCount),
    ),
    runtimeDependenciesAdded: runtimeDependencyDiff.added,
    runtimeDependenciesChanged: runtimeDependencyDiff.changed,
    runtimeDependenciesRemoved: runtimeDependencyDiff.removed,
    status: baselinePackage === null ? "added" : currentPackage === null ? "removed" : "present",
    unpackedSizeBytes: compareNumericMetric(
      readMetricValue(currentPackage?.unpackedSizeBytes),
      readMetricValue(baselinePackage?.unpackedSizeBytes),
    ),
  };
}

function compareInitInstallReports(currentInitInstall, baselineInitInstall) {
  if (currentInitInstall === null && baselineInitInstall === null) {
    return null;
  }

  const dependencyDiff = compareDependencyEntries(
    readDependencyEntries(currentInitInstall?.dependencies),
    readDependencyEntries(baselineInitInstall?.dependencies),
  );
  const devDependencyDiff = compareDependencyEntries(
    readDependencyEntries(currentInitInstall?.devDependencies),
    readDependencyEntries(baselineInitInstall?.devDependencies),
  );

  return {
    dependenciesAdded: dependencyDiff.added,
    dependenciesChanged: dependencyDiff.changed,
    dependenciesRemoved: dependencyDiff.removed,
    dependencyCount: compareNumericMetric(
      readMetricValue(currentInitInstall?.dependencyCount),
      readMetricValue(baselineInitInstall?.dependencyCount),
    ),
    dependencyPackageBytes: compareNumericMetric(
      readMetricValue(currentInitInstall?.dependencyPackageBytes),
      readMetricValue(baselineInitInstall?.dependencyPackageBytes),
    ),
    devDependenciesAdded: devDependencyDiff.added,
    devDependenciesChanged: devDependencyDiff.changed,
    devDependenciesRemoved: devDependencyDiff.removed,
    devDependencyCount: compareNumericMetric(
      readMetricValue(currentInitInstall?.devDependencyCount),
      readMetricValue(baselineInitInstall?.devDependencyCount),
    ),
    devDependencyPackageBytes: compareNumericMetric(
      readMetricValue(currentInitInstall?.devDependencyPackageBytes),
      readMetricValue(baselineInitInstall?.devDependencyPackageBytes),
    ),
    installedFileCount: compareNumericMetric(
      readMetricValue(currentInitInstall?.installedFileCount),
      readMetricValue(baselineInitInstall?.installedFileCount),
    ),
    installedPackageCount: compareNumericMetric(
      readMetricValue(currentInitInstall?.installedPackageCount),
      readMetricValue(baselineInitInstall?.installedPackageCount),
    ),
    installedSizeBytes: compareNumericMetric(
      readMetricValue(currentInitInstall?.installedSizeBytes),
      readMetricValue(baselineInitInstall?.installedSizeBytes),
    ),
    status:
      baselineInitInstall === null ? "added" : currentInitInstall === null ? "removed" : "present",
    transitivePackageBytes: compareNumericMetric(
      readMetricValue(currentInitInstall?.transitivePackageBytes),
      readMetricValue(baselineInitInstall?.transitivePackageBytes),
    ),
    unclassifiedInstalledPackageCount: compareNumericMetric(
      readMetricValue(currentInitInstall?.unclassifiedInstalledPackageCount),
      readMetricValue(baselineInitInstall?.unclassifiedInstalledPackageCount),
    ),
  };
}

/**
 * Compares one Nitro bundle report to a baseline snapshot and returns the
 * byte/count deltas needed for regression tracking.
 */
export function createNitroBundleReportComparison(report, baselineReport, options = {}) {
  const currentFunctions = Array.isArray(report?.functions) ? report.functions : [];
  const baselineFunctions = Array.isArray(baselineReport?.functions)
    ? baselineReport.functions
    : [];
  const appComparison = {
    functionAliasCount: compareNumericMetric(
      readMetricValue(report?.functionAliasCount),
      readMetricValue(baselineReport?.functionAliasCount),
    ),
    functions: compareFunctions(currentFunctions, baselineFunctions),
    internalRouteCount: compareNumericMetric(
      readMetricValue(report?.internalRouteCount),
      readMetricValue(baselineReport?.internalRouteCount),
    ),
    publicRouteCount: compareNumericMetric(
      readMetricValue(report?.publicRouteCount),
      readMetricValue(baselineReport?.publicRouteCount),
    ),
    staticAssetBytes: compareNumericMetric(
      readMetricValue(report?.staticAssetBytes),
      readMetricValue(baselineReport?.staticAssetBytes),
    ),
    staticAssetCount: compareNumericMetric(
      readMetricValue(report?.staticAssetCount),
      readMetricValue(baselineReport?.staticAssetCount),
    ),
    uniqueFunctionBytes: compareNumericMetric(
      readMetricValue(report?.uniqueFunctionBytes),
      readMetricValue(baselineReport?.uniqueFunctionBytes),
    ),
    uniqueFunctionCount: compareNumericMetric(
      readMetricValue(report?.uniqueFunctionCount),
      readMetricValue(baselineReport?.uniqueFunctionCount),
    ),
  };
  const packageComparison = comparePublishedPackages(
    report?.publishedPackage ?? null,
    baselineReport?.publishedPackage ?? null,
  );
  const initInstallComparison = compareInitInstallReports(
    report?.initInstall ?? null,
    baselineReport?.initInstall ?? null,
  );

  return {
    app: appComparison,
    baselineGeneratedAt:
      typeof baselineReport?.generatedAt === "string" ? baselineReport.generatedAt : null,
    baselineLabel: typeof options.baselineLabel === "string" ? options.baselineLabel : "baseline",
    initInstall: initInstallComparison,
    package: packageComparison,
    sizeBudget: createSizeBudget(appComparison, packageComparison, initInstallComparison),
  };
}
