import { isAbsolute, posix } from "node:path";

import {
  getSupportedModuleBaseName,
  normalizeLogicalPath,
  stripLogicalPathExtension,
} from "#discover/filesystem.js";

export function validateProgrammaticLogicalPath(input: string): string {
  return validateProgrammaticLogicalPathInternal(input, false);
}

export function validateProgrammaticLogicalPathInternal(
  input: string,
  allowExtensionMount: boolean,
): string {
  if (input.length === 0 || isAbsolute(input) || input.includes("\\")) {
    throw new Error(`Programmatic module logical path "${input}" must be a relative POSIX path.`);
  }
  const logicalPath = normalizeLogicalPath(input);
  if (
    logicalPath === "." ||
    logicalPath.startsWith("../") ||
    logicalPath.includes("/../") ||
    posix.normalize(logicalPath) !== logicalPath
  ) {
    throw new Error(`Programmatic module logical path "${input}" may not traverse directories.`);
  }
  const segments = logicalPath.split("/");
  const fileName = segments.at(-1)!;
  if (getSupportedModuleBaseName(fileName) === null) {
    throw new Error(
      `Programmatic module logical path "${input}" must use a supported JavaScript or TypeScript extension.`,
    );
  }
  const root = segments[0];
  const extensionless = stripLogicalPathExtension(logicalPath);
  const supported =
    (segments.length === 1 &&
      ["agent", "memory", "sandbox", "instrumentation"].includes(extensionless)) ||
    (root === "sandbox" &&
      segments.length === 2 &&
      getSupportedModuleBaseName(fileName) === "sandbox") ||
    ([
      "channels",
      "connections",
      "hooks",
      "instructions",
      "memory",
      "schedules",
      "skills",
      "tools",
    ].includes(root!) &&
      segments.length >= 2) ||
    (allowExtensionMount && root === "extensions" && segments.length === 2);
  if (!supported) {
    throw new Error(
      `Programmatic module logical path "${input}" does not select an eve module slot.`,
    );
  }
  return logicalPath;
}
