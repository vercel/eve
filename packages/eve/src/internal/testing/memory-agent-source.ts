import { posix } from "node:path";

import { createMemoryProjectSource, type ProjectSource } from "#discover/project-source.js";

/**
 * Declarative description of an in-memory eve project used by integration
 * tests that exercise the `discover/` and `compile/` pipelines.
 *
 * The shape mirrors the authored grammar — tests author paths relative to
 * `agent/` (eg. `"instructions.md"`, `"tools/get_weather.ts"`) and the helper
 * materializes them under a synthetic absolute root (`/memory/app/agent/…`).
 */
export interface MemoryAgentProjectInput {
  /**
   * Files authored relative to the agent root
   * (eg. `"instructions.md"`, `"tools/weather.ts"`).
   */
  readonly agentFiles?: Readonly<Record<string, string>>;
  /**
   * Empty directories relative to the agent root that should still appear
   * in parent listings. Parents of files in {@link agentFiles} are
   * inferred automatically — only explicitly empty folders need listing
   * here.
   */
  readonly agentDirectories?: readonly string[];
  /**
   * Files authored relative to the app root. Defaults to a
   * `package.json` with the supplied {@link packageName}.
   */
  readonly appFiles?: Readonly<Record<string, string>>;
  /**
   * Empty directories relative to the app root.
   */
  readonly appDirectories?: readonly string[];
  /**
   * Overrides the `name` field written into the auto-authored
   * `package.json`. Defaults to `"memory-agent"`.
   */
  readonly packageName?: string;
  /**
   * Overrides the app-root hint embedded in memory-source diagnostics.
   * Defaults to `"/memory/app"`.
   */
  readonly appRoot?: string;
  /**
   * When `true`, the app root **is** the agent root (flat layout). Useful
   * for tests that exercise `resolveDiscoveryProject`'s flat branch.
   * Defaults to `false` (nested layout with a dedicated `agent/` folder).
   */
  readonly flat?: boolean;
  /**
   * When `true`, no `package.json` is authored automatically. Use this
   * when the test asserts "no agent root can be found" or provides its
   * own package marker through {@link appFiles}.
   */
  readonly omitPackageJson?: boolean;
}

/**
 * Materialized in-memory project handed to tests.
 */
export interface MemoryAgentProject {
  /**
   * Absolute path of the synthetic app root. Use this as `appRoot` on any
   * `discover*({ agentRoot, appRoot, source })` call or as the start path
   * of `resolveDiscoveryProject(startPath, { source })`.
   */
  readonly appRoot: string;
  /**
   * Absolute path of the synthetic agent root. In nested layouts this is
   * `${appRoot}/agent`; in flat layouts it equals `appRoot`.
   */
  readonly agentRoot: string;
  /**
   * The project source wired to the in-memory tree. Pass this as the
   * `source` option on any discover or compile entry point.
   */
  readonly source: ProjectSource;
}

const DEFAULT_APP_ROOT = "/memory/app";
const DEFAULT_PACKAGE_NAME = "memory-agent";

/**
 * Builds a {@link MemoryAgentProject} from a declarative {@link MemoryAgentProjectInput}.
 */
export function buildMemoryAgentProject(input: MemoryAgentProjectInput = {}): MemoryAgentProject {
  const appRoot = input.appRoot ?? DEFAULT_APP_ROOT;
  const flat = input.flat === true;
  const agentRoot = flat ? appRoot : posix.join(appRoot, "agent");

  const files: Record<string, string> = {};

  if (input.omitPackageJson !== true) {
    files[posix.join(appRoot, "package.json")] = JSON.stringify({
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
