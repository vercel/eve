import { isAbsolute, relative, resolve, sep } from "node:path";

function escapeRegex(input: string): string {
  return input.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&");
}

function workspacePatternToRegex(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else {
      source += escapeRegex(char ?? "");
    }
  }
  source += "$";
  return new RegExp(source, "u");
}

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
  return workspacePatternToRegex(normalized).test(relativePath);
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
