import { isAbsolute, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";

export function workspaceRelativePath(workspaceRoot: string, projectRoot: string): string {
  return relative(workspaceRoot, resolve(projectRoot)).split(sep).join("/");
}

export function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(childPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function workspacePatternForProject(workspaceRoot: string, projectRoot: string): string {
  const relativePath = workspaceRelativePath(workspaceRoot, projectRoot);
  if (relativePath.length === 0) return ".";
  const parts = relativePath.split("/");
  if (parts.length === 1) return relativePath;
  return `${parts.slice(0, -1).join("/")}/*`;
}

export function workspacePatternClaimsRelativePath(pattern: string, relativePath: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  if (normalized === "." || normalized === relativePath) return true;
  return picomatch.isMatch(relativePath, normalized, { dot: false });
}

export function workspacePatternsClaimProject(
  patterns: readonly string[],
  workspaceRoot: string,
  projectRoot: string,
): boolean {
  const relativePath = workspaceRelativePath(workspaceRoot, projectRoot);
  const positives = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negatives = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  const included = positives.some((pattern) =>
    workspacePatternClaimsRelativePath(pattern, relativePath),
  );
  if (!included) return false;
  return !negatives.some((pattern) => workspacePatternClaimsRelativePath(pattern, relativePath));
}
