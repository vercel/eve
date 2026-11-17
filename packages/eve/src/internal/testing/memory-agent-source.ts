import { posix } from "node:path";

import { createMemoryProjectSource, type ProjectSource } from "#discover/project-source.js";

interface MemoryAgentProjectInput {
  readonly agentFiles?: Readonly<Record<string, string>>;
  readonly agentDirectories?: readonly string[];
  readonly appFiles?: Readonly<Record<string, string>>;
  readonly appDirectories?: readonly string[];
  readonly packageName?: string;
  readonly appRoot?: string;
  readonly flat?: boolean;
  readonly omitPackageJson?: boolean;
}

interface MemoryAgentProject {
  readonly appRoot: string;
  readonly agentRoot: string;
  readonly source: ProjectSource;
}

const DEFAULT_APP_ROOT = "/memory/app";
const DEFAULT_PACKAGE_NAME = "memory-agent";

export function buildMemoryAgentProject(input: MemoryAgentProjectInput = {}): MemoryAgentProject {
  const appRoot = input.appRoot ?? DEFAULT_APP_ROOT;
  const flat = input.flat === true;
  const agentRoot = flat ? appRoot : posix.join(appRoot, "agent");

  const files: Record<string, string> = {};

  if (input.omitPackageJson !== true) {
    files[posix.join(appRoot, "package.json")] = JSON.stringify({
      dependencies: { eve: "*" },
      name: input.packageName ?? DEFAULT_PACKAGE_NAME,
    });
  }

  for (const [relativePath, content] of Object.entries(input.appFiles ?? {})) {
    files[posix.join(appRoot, relativePath)] = content;
  }

  for (const [relativePath, content] of Object.entries(input.agentFiles ?? {})) {
    files[posix.join(agentRoot, relativePath)] = content;
  }

  const directories: string[] = [];

  for (const relativePath of input.appDirectories ?? []) {
    directories.push(posix.join(appRoot, relativePath));
  }

  for (const relativePath of input.agentDirectories ?? []) {
    directories.push(posix.join(agentRoot, relativePath));
  }

  return {
    agentRoot,
    appRoot,
    source: createMemoryProjectSource({
      directories,
      files,
      rootDir: appRoot,
    }),
  };
}
