export const BUILT_IN_WORKFLOW_WORLD_TARGETS = ["local", "vercel"] as const;

export type BuiltInWorkflowWorldTarget = (typeof BUILT_IN_WORKFLOW_WORLD_TARGETS)[number];

const BUILT_IN_WORKFLOW_WORLD_PACKAGES: Readonly<Record<BuiltInWorkflowWorldTarget, string>> = {
  local: "@workflow/world-local",
  vercel: "@workflow/world-vercel",
};

/** Closed native inventory for the Workflow worlds shipped with eve. */
export function resolveBuiltInWorkflowWorldPackage(target: BuiltInWorkflowWorldTarget): string {
  return BUILT_IN_WORKFLOW_WORLD_PACKAGES[target];
}

/**
 * Classifies an authored target without resolving packages or evaluating code.
 * The full first-party package names are aliases for the same native entries so
 * they cannot accidentally enter the custom host-module path.
 */
export function classifyBuiltInWorkflowWorldTarget(
  target: string,
): BuiltInWorkflowWorldTarget | undefined {
  for (const builtInTarget of BUILT_IN_WORKFLOW_WORLD_TARGETS) {
    if (target === builtInTarget || target === BUILT_IN_WORKFLOW_WORLD_PACKAGES[builtInTarget]) {
      return builtInTarget;
    }
  }
  return undefined;
}

/** Whether a custom target is a bare npm package name rather than a path/URL. */
export function isWorkflowWorldPackageName(target: string): boolean {
  if (target.length === 0 || target !== target.trim()) return false;
  if (
    target.startsWith(".") ||
    target.startsWith("/") ||
    target.startsWith("\\") ||
    target.includes(":") ||
    target.includes("\\")
  ) {
    return false;
  }

  const segments = target.split("/");
  if (target.startsWith("@")) {
    if (segments.length !== 2 || segments[0]?.length === 1) return false;
  } else if (segments.length !== 1) {
    return false;
  }

  return segments.every((segment) => /^@?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment));
}
