import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { PackageManagerKind } from "../../package-manager.js";
import { pinnedNodeEngineMajor, type NodeEngineOverride } from "../../node-engine.js";
import { pathExists, writeTextFile } from "../files.js";
import { resolveVersionToken } from "../version-tokens.js";
import {
  applyPackageManagerWorkspaceConfiguration,
  isPackageManagerWorkspaceMember,
  patchWorkspaceRootPackageJson,
  type WorkspaceRootMutation,
} from "../workspace-root.js";
import { getSupportedModuleBaseName, matchesSupportedModuleBaseName } from "./module-files.js";
import { patchPackageJson, type PackageJsonPatch } from "./package-json.js";
import {
  CURRENT_DIRECTORY_PROJECT_NAME,
  DEFAULT_EVE_PACKAGE_CONTRACT,
  resolveEvePackageContract,
  type EvePackageContract,
} from "../create/project.js";
import { WEB_APP_TEMPLATE_FILES, WEB_APP_TEMPLATE_PACKAGE_JSON } from "../create/web-template.js";

export const SLACK_CHANNEL_DEFAULT_ROUTE = "/eve/v1/slack";
export const DEFAULT_SLACK_CONNECTOR_SLUG = "my-agent";

const DEFAULT_CONNECT_PACKAGE_VERSION = "__VERCEL_CONNECT_VERSION__";
const DEFAULT_AI_PACKAGE_VERSION = "__AI_SDK_VERSION__";
const DEFAULT_NEXT_PACKAGE_VERSION = "__NEXT_VERSION__";
const DEFAULT_REACT_PACKAGE_VERSION = "__REACT_VERSION__";
const DEFAULT_REACT_DOM_PACKAGE_VERSION = "__REACT_DOM_VERSION__";
const DEFAULT_STREAMDOWN_PACKAGE_VERSION = "__STREAMDOWN_VERSION__";
const DEFAULT_ZOD_PACKAGE_VERSION = "__ZOD_VERSION__";
const NEXT_TYPESCRIPT_PACKAGE_VERSION = "6.0.3";
const DEFAULT_TYPES_REACT_PACKAGE_VERSION = "__TYPES_REACT_VERSION__";
const DEFAULT_TYPES_REACT_DOM_PACKAGE_VERSION = "__TYPES_REACT_DOM_VERSION__";
const CONNECT_PACKAGE_NAME = "@vercel/connect";
const NEXT_PACKAGE_NAME = "next";
const PACKAGE_DEPENDENCY_FIELDS = ["dependencies", "devDependencies"] as const;
const USER_AUTHORED_CHANNEL_DIR = "agent/channels";
const WEB_CHANNEL_PATH = "agent/channels/eve.ts";
const WEB_NEXT_CONFIG_PATH = "next.config.ts";
const WEB_VERCEL_JSON_PATH = "vercel.json";
const WEB_VERCEL_JSON_SCHEMA = "https://openapi.vercel.sh/vercel.json";
const SUPPORTED_NEXT_CONFIG_PATHS = [
  "next.config.js",
  "next.config.mjs",
  WEB_NEXT_CONFIG_PATH,
  "next.config.mts",
] as const;
const WEB_COMPETING_NEXT_CONFIG_PATHS = SUPPORTED_NEXT_CONFIG_PATHS.filter(
  (path) => path !== WEB_NEXT_CONFIG_PATH,
);

declare const slackConnectorSlugBrand: unique symbol;

export type ChannelKind = "slack" | "web";
export type SlackConnectorSlug = string & { readonly [slackConnectorSlugBrand]: true };

export interface PackageJsonMutation {
  path: string;
  dependencies: string[];
  devDependencies: string[];
  scripts: string[];
}

export type ChannelMutationAction = "created" | "overwritten" | "skipped";

export type ChannelMutationResult = SlackChannelMutationResult | WebChannelMutationResult;

interface SlackChannelWrittenResult {
  kind: "slack";
  action: "created" | "overwritten";
  filesWritten: [string];
  filesOverwritten?: [string];
  filesSkipped: [];
  packageJsonUpdated: PackageJsonMutation[];
  slackConnectorSlug: SlackConnectorSlug;
}

interface SlackChannelSkippedResult {
  kind: "slack";
  action: "skipped";
  filesWritten: [];
  filesOverwritten?: [];
  filesSkipped: [string];
  packageJsonUpdated: [];
}

type SlackChannelMutationResult = SlackChannelWrittenResult | SlackChannelSkippedResult;

interface WebChannelWrittenResult {
  kind: "web";
  action: "created" | "overwritten";
  filesWritten: string[];
  filesOverwritten?: string[];
  competingNextConfigFiles?: string[];
  nodeEngineOverride?: NodeEngineOverride;
  filesSkipped: string[];
  packageJsonUpdated: PackageJsonMutation[];
}

interface WebChannelSkippedResult {
  kind: "web";
  action: "skipped";
  skipReason: "nextjs-project";
  filesWritten: [];
  filesOverwritten?: [];
  filesSkipped: [string];
  packageJsonUpdated: [];
}

type WebChannelMutationResult = WebChannelWrittenResult | WebChannelSkippedResult;

function toSlackConnectorSlug(value: string): SlackConnectorSlug {
  return value as SlackConnectorSlug;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read and parse a project's `package.json` into a plain object, or `undefined`
 * when it is missing or does not parse to a JSON object.
 */
async function readPackageJsonObject(
  packageJsonPath: string,
): Promise<Record<string, unknown> | undefined> {
  if (!(await pathExists(packageJsonPath))) return undefined;

  const parsed: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
  return isJsonObject(parsed) ? parsed : undefined;
}

async function readDependencyVersion(
  packageJsonPath: string,
  dependencyName: string,
): Promise<string | undefined> {
  const parsed = await readPackageJsonObject(packageJsonPath);
  if (parsed === undefined || !isJsonObject(parsed.dependencies)) return undefined;

  const version = parsed.dependencies[dependencyName];
  return typeof version === "string" ? version : undefined;
}

function packageJsonHasDependency(
  parsed: Record<string, unknown>,
  dependencyName: string,
): boolean {
  for (const field of PACKAGE_DEPENDENCY_FIELDS) {
    const dependencies = parsed[field];
    if (isJsonObject(dependencies) && typeof dependencies[dependencyName] === "string") {
      return true;
    }
  }
  return false;
}

async function hasPackageDependency(
  packageJsonPath: string,
  dependencyName: string,
): Promise<boolean> {
  const parsed = await readPackageJsonObject(packageJsonPath);
  return parsed !== undefined && packageJsonHasDependency(parsed, dependencyName);
}

/**
 * Whether the project already carries a Next.js app: `package.json` declares a
 * `next` dependency in the same dependency fields Vercel framework detection
 * checks. This is the exact predicate the
 * web scaffold skips on (`skipReason: "nextjs-project"`), so pickers can mark
 * Web Chat as already present precisely when scaffolding would be a no-op.
 * A missing `package.json` reads as "no app".
 */
export async function isNextJsProject(projectRoot: string): Promise<boolean> {
  return hasPackageDependency(join(projectRoot, "package.json"), NEXT_PACKAGE_NAME);
}

/**
 * Host-framework dependency → the Vercel Framework Preset slug it must deploy
 * under (so the framework owns the top-level build and eve runs as a sibling).
 * Single source of truth for which dependencies mark a host framework;
 * {@link hasVercelHostFramework} derives from it.
 */
const VERCEL_HOST_FRAMEWORK_PRESETS: Readonly<Record<string, string>> = {
  "@sveltejs/kit": "sveltekit",
  [NEXT_PACKAGE_NAME]: "nextjs",
  nuxt: "nuxtjs",
  nuxt3: "nuxtjs",
  "nuxt-edge": "nuxtjs",
  "nuxt-nightly": "nuxtjs",
};

/**
 * The Vercel Framework Preset slug for the host framework a project declares, or
 * `undefined` when it declares none (a missing `package.json` reads as none).
 */
export async function resolveVercelHostFrameworkPreset(
  projectRoot: string,
): Promise<string | undefined> {
  const parsed = await readPackageJsonObject(join(projectRoot, "package.json"));
  if (parsed === undefined) return undefined;

  for (const [dependencyName, preset] of Object.entries(VERCEL_HOST_FRAMEWORK_PRESETS)) {
    if (packageJsonHasDependency(parsed, dependencyName)) return preset;
  }
  return undefined;
}

/**
 * Whether the root app declares a Vercel framework that should own the
 * top-level deployment while eve runs as a sibling service. These match Eve's
 * current framework integrations: Next.js, Nuxt, and SvelteKit. Derived from
 * {@link resolveVercelHostFrameworkPreset} so the two share one dependency list.
 */
export async function hasVercelHostFramework(projectRoot: string): Promise<boolean> {
  return (await resolveVercelHostFrameworkPreset(projectRoot)) !== undefined;
}

async function ensurePackageDependency(
  packageJsonPath: string,
  dependencyName: string,
  dependencyVersion: string,
): Promise<PackageJsonMutation[]> {
  if (!(await pathExists(packageJsonPath))) return [];
  const currentVersion = await readDependencyVersion(packageJsonPath, dependencyName);
  if (currentVersion === dependencyVersion) return [];

  await patchPackageJson(packageJsonPath, {
    dependencies: { [dependencyName]: dependencyVersion },
  });
  return [
    {
      path: packageJsonPath,
      dependencies: [dependencyName],
      devDependencies: [],
      scripts: [],
    },
  ];
}

function resolveWebPackageVersions(
  input: WebPackageVersions | undefined,
): Required<WebPackageVersions> {
  return {
    evePackage: input?.evePackage ?? DEFAULT_EVE_PACKAGE_CONTRACT,
    aiPackageVersion: input?.aiPackageVersion ?? DEFAULT_AI_PACKAGE_VERSION,
    nextPackageVersion: input?.nextPackageVersion ?? DEFAULT_NEXT_PACKAGE_VERSION,
    reactPackageVersion: input?.reactPackageVersion ?? DEFAULT_REACT_PACKAGE_VERSION,
    reactDomPackageVersion: input?.reactDomPackageVersion ?? DEFAULT_REACT_DOM_PACKAGE_VERSION,
    streamdownPackageVersion: input?.streamdownPackageVersion ?? DEFAULT_STREAMDOWN_PACKAGE_VERSION,
    zodPackageVersion: input?.zodPackageVersion ?? DEFAULT_ZOD_PACKAGE_VERSION,
    typesReactPackageVersion:
      input?.typesReactPackageVersion ?? DEFAULT_TYPES_REACT_PACKAGE_VERSION,
    typesReactDomPackageVersion:
      input?.typesReactDomPackageVersion ?? DEFAULT_TYPES_REACT_DOM_PACKAGE_VERSION,
  };
}

function formatEveDependencySpecifier(versionOrSpecifier: string): string {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/.test(versionOrSpecifier)
    ? `^${versionOrSpecifier}`
    : versionOrSpecifier;
}

async function patchWebPackageJson(
  projectRoot: string,
  packageManager: PackageManagerKind,
  workspaceProbeRoot: string,
  options: Required<WebPackageVersions>,
  onWorkspaceRootMutation?: (mutation: WorkspaceRootMutation) => void | Promise<void>,
): Promise<{
  mutations: PackageJsonMutation[];
  nodeEngineOverride?: NodeEngineOverride;
}> {
  const packageJsonPath = join(projectRoot, "package.json");
  if (!(await pathExists(packageJsonPath))) return { mutations: [] };

  // Resolved here, not at the defaults site, so a project without a
  // package.json keeps skipping version handling entirely (the early return
  // above), exactly as the stamped-only guard did.
  const evePackage = resolveEvePackageContract(options.evePackage);
  const nodeEngine = pinnedNodeEngineMajor(evePackage.nodeEngine);
  const dependencies = {
    ...WEB_APP_TEMPLATE_PACKAGE_JSON.dependencies,
    ai: resolveVersionToken("aiPackageVersion", options.aiPackageVersion),
    eve: formatEveDependencySpecifier(evePackage.version),
    next: resolveVersionToken("nextPackageVersion", options.nextPackageVersion),
    react: resolveVersionToken("reactPackageVersion", options.reactPackageVersion),
    "react-dom": resolveVersionToken("reactDomPackageVersion", options.reactDomPackageVersion),
    streamdown: resolveVersionToken("streamdownPackageVersion", options.streamdownPackageVersion),
    zod: resolveVersionToken("zodPackageVersion", options.zodPackageVersion),
  } satisfies Record<string, string>;
  const devDependencies = {
    ...WEB_APP_TEMPLATE_PACKAGE_JSON.devDependencies,
    "@types/node": nodeEngine,
    "@types/react": resolveVersionToken(
      "typesReactPackageVersion",
      options.typesReactPackageVersion,
    ),
    "@types/react-dom": resolveVersionToken(
      "typesReactDomPackageVersion",
      options.typesReactDomPackageVersion,
    ),
    typescript: NEXT_TYPESCRIPT_PACKAGE_VERSION,
  } satisfies Record<string, string>;
  const scripts = WEB_APP_TEMPLATE_PACKAGE_JSON.scripts;

  const workspaceMember = isPackageManagerWorkspaceMember(packageManager, workspaceProbeRoot);
  const packageJsonPatch: PackageJsonPatch = {
    dependencies,
    devDependencies,
    scripts,
  };
  if (!workspaceMember) {
    packageJsonPatch.nodeEngineRequirement = evePackage.nodeEngine;
  }
  const patchResult = await patchPackageJson(packageJsonPath, packageJsonPatch);
  const workspacePatchResult = await patchWorkspaceRootPackageJson(
    packageManager,
    workspaceProbeRoot,
    {
      aiPackageVersion: dependencies.ai,
      nodeEngineRequirement: evePackage.nodeEngine,
      onWorkspaceRootMutation,
    },
  );
  const nodeEngineOverride =
    workspacePatchResult.nodeEngineOverride ?? patchResult.nodeEngineOverride;

  return {
    mutations: [
      {
        path: packageJsonPath,
        dependencies: Object.keys(dependencies),
        devDependencies: Object.keys(devDependencies),
        scripts: Object.keys(scripts),
      },
    ],
    nodeEngineOverride,
  };
}

export function normalizeSlackConnectorSlug(input: string): SlackConnectorSlug {
  const withoutScope = input.trim().replace(/^@/, "").split("/").at(-1) ?? "";
  const normalized = withoutScope
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, 100)
    .replace(/[^a-z0-9]+$/, "");

  return toSlackConnectorSlug(normalized || DEFAULT_SLACK_CONNECTOR_SLUG);
}

export async function deriveSlackConnectorSlug(
  projectRoot: string,
  projectNameHint?: string,
): Promise<SlackConnectorSlug> {
  if (
    projectNameHint !== undefined &&
    projectNameHint.length > 0 &&
    projectNameHint !== CURRENT_DIRECTORY_PROJECT_NAME
  ) {
    return normalizeSlackConnectorSlug(projectNameHint);
  }
  try {
    const raw = await readFile(join(projectRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed.name === "string" && parsed.name.length > 0) {
      return normalizeSlackConnectorSlug(parsed.name);
    }
  } catch {
    // Fall through to the directory basename fallback.
  }
  const dir = basename(resolve(projectRoot));
  return normalizeSlackConnectorSlug(dir || DEFAULT_SLACK_CONNECTOR_SLUG);
}

function buildSlackTemplate(connectorUid: string): string {
  if (!connectorUid.startsWith("slack/") || connectorUid.length === "slack/".length) {
    throw new Error(`Invalid Slack connector UID "${connectorUid}".`);
  }
  return `import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials(${JSON.stringify(connectorUid)}),
});
`;
}

function renderWebAppTemplate(content: string, appName: string): string {
  return content
    .replaceAll("__EVE_INIT_APP_NAME__", appName)
    .replaceAll("__EVE_INIT_WITH_EVE_OPTIONS__", "");
}

/**
 * Ensure the Next.js web channel has a minimal `vercel.json`.
 *
 * The eve service and its `/eve/v1/*` routes are generated by `withEve()` into
 * `.vercel/output/config.json` at build time — which reads `vercel.json`'s
 * `services`, not a scaffolded block — so the scaffold intentionally writes no
 * services entry. Emitting one only risks a `services` schema that today's
 * Vercel platform rejects before the build ever runs.
 *
 * When a `vercel.json` already exists it is left untouched: `withEve()` owns the
 * eve service, so the scaffold has nothing to add to a file the user manages.
 */
async function ensureWebVercelJson(filePath: string): Promise<"skipped" | "written"> {
  if (await pathExists(filePath)) {
    return "skipped";
  }

  await writeTextFile(
    filePath,
    `${JSON.stringify({ $schema: WEB_VERCEL_JSON_SCHEMA }, null, 2)}\n`,
    {
      force: true,
    },
  );
  return "written";
}

async function findCompetingNextConfigFiles(projectRoot: string): Promise<string[]> {
  const filePaths: string[] = [];
  for (const relativePath of WEB_COMPETING_NEXT_CONFIG_PATHS) {
    const filePath = join(projectRoot, relativePath);
    if (!(await pathExists(filePath))) continue;
    filePaths.push(filePath);
  }
  return filePaths;
}

export interface EnsureChannelOptions {
  projectRoot: string;
  kind: ChannelKind;
  /** Manager that owns generated project configuration. Defaults to pnpm. */
  packageManager?: PackageManagerKind;
  /**
   * Final project path used to discover ancestor workspaces. This differs from
   * `projectRoot` only when scaffolding writes into a temporary staging
   * directory before moving the project into place.
   */
  workspaceProbeDirectory?: string;
  force?: boolean;
  /** Exact UID returned by Vercel Connect; takes precedence over the derived slug. */
  slackConnectorUid?: string;
  slackConnectorSlug?: SlackConnectorSlug;
  connectPackageVersion?: string;
  webPackageVersions?: WebPackageVersions;
  /** When false, Web Chat leaves Vercel Services config unwritten for preview-only scaffolds. */
  configureVercelServices?: boolean;
  onWorkspaceRootMutation?: (mutation: WorkspaceRootMutation) => void | Promise<void>;
}

export interface WebPackageVersions {
  evePackage?: EvePackageContract;
  aiPackageVersion?: string;
  nextPackageVersion?: string;
  reactPackageVersion?: string;
  reactDomPackageVersion?: string;
  streamdownPackageVersion?: string;
  zodPackageVersion?: string;
  typesReactPackageVersion?: string;
  typesReactDomPackageVersion?: string;
}

export async function ensureChannel(options: EnsureChannelOptions): Promise<ChannelMutationResult> {
  switch (options.kind) {
    case "slack":
      return ensureSlackChannel({ ...options, kind: "slack" });
    case "web":
      return ensureWebChannel({ ...options, kind: "web" });
  }
}

async function ensureWebChannel(
  options: Omit<EnsureChannelOptions, "kind"> & { kind: "web" },
): Promise<WebChannelMutationResult> {
  const packageJsonPath = join(options.projectRoot, "package.json");
  const webEntryPath = join(options.projectRoot, "app/page.tsx");
  const webEntryAlreadyExists = await pathExists(webEntryPath);
  if (!options.force && (await isNextJsProject(options.projectRoot))) {
    return {
      kind: "web",
      action: "skipped",
      skipReason: "nextjs-project",
      filesWritten: [],
      filesSkipped: [packageJsonPath],
      packageJsonUpdated: [],
    };
  }

  const webPackageVersions = resolveWebPackageVersions(options.webPackageVersions);
  const packageManager = options.packageManager ?? "pnpm";
  const workspaceProbeRoot = resolve(options.workspaceProbeDirectory ?? options.projectRoot);
  const packageJsonPatch = await patchWebPackageJson(
    options.projectRoot,
    packageManager,
    workspaceProbeRoot,
    webPackageVersions,
    options.onWorkspaceRootMutation,
  );
  const filesWritten: string[] = [];
  const filesOverwritten: string[] = [];
  const competingNextConfigFiles: string[] = [];
  const filesSkipped: string[] = [];
  const appName = basename(resolve(options.projectRoot));
  const configureVercelServices = options.configureVercelServices ?? true;

  if (configureVercelServices) {
    const vercelJsonPath = join(options.projectRoot, WEB_VERCEL_JSON_PATH);
    const vercelJsonResult = await ensureWebVercelJson(vercelJsonPath);
    if (vercelJsonResult === "written") {
      filesWritten.push(vercelJsonPath);
    } else {
      filesSkipped.push(vercelJsonPath);
    }
  }

  const packageManagerConfiguration = await applyPackageManagerWorkspaceConfiguration({
    packageManager,
    projectRoot: options.projectRoot,
    workspaceProbeRoot,
    onWorkspaceRootMutation: options.onWorkspaceRootMutation,
  });
  filesWritten.push(...packageManagerConfiguration.filesWritten);
  filesSkipped.push(...packageManagerConfiguration.filesSkipped);

  for (const [relPath, content] of Object.entries(WEB_APP_TEMPLATE_FILES)) {
    const filePath = join(options.projectRoot, relPath);
    if (relPath === WEB_CHANNEL_PATH && !options.force && (await pathExists(filePath))) {
      filesSkipped.push(filePath);
      continue;
    }

    const existed = await pathExists(filePath);
    await writeTextFile(filePath, renderWebAppTemplate(content, appName), {
      force: true,
    });
    filesWritten.push(filePath);
    if (existed) {
      filesOverwritten.push(filePath);
    }
  }

  competingNextConfigFiles.push(...(await findCompetingNextConfigFiles(options.projectRoot)));
  const uniqueFilesWritten = [...new Set(filesWritten)];
  const uniqueFilesSkipped = [...new Set(filesSkipped)].filter(
    (filePath) => !uniqueFilesWritten.includes(filePath),
  );

  const result: WebChannelWrittenResult = {
    kind: "web",
    action: webEntryAlreadyExists ? "overwritten" : "created",
    filesWritten: uniqueFilesWritten,
    filesSkipped: uniqueFilesSkipped,
    packageJsonUpdated: packageJsonPatch.mutations,
  };
  if (filesOverwritten.length > 0) {
    result.filesOverwritten = filesOverwritten;
  }
  if (competingNextConfigFiles.length > 0) {
    result.competingNextConfigFiles = competingNextConfigFiles;
  }
  if (packageJsonPatch.nodeEngineOverride !== undefined) {
    result.nodeEngineOverride = packageJsonPatch.nodeEngineOverride;
  }
  return result;
}

async function ensureSlackChannel(
  options: Omit<EnsureChannelOptions, "kind"> & { kind: "slack" },
): Promise<SlackChannelMutationResult> {
  const filePath = join(options.projectRoot, "agent/channels/slack.ts");
  const fileAlreadyExists = await pathExists(filePath);
  if (!options.force && fileAlreadyExists) {
    return {
      kind: "slack",
      action: "skipped",
      filesWritten: [],
      filesSkipped: [filePath],
      packageJsonUpdated: [],
    };
  }

  const connectPackageVersion = resolveVersionToken(
    "connectPackageVersion",
    options.connectPackageVersion ?? DEFAULT_CONNECT_PACKAGE_VERSION,
  );

  const packageJsonUpdated = await ensurePackageDependency(
    join(options.projectRoot, "package.json"),
    CONNECT_PACKAGE_NAME,
    connectPackageVersion,
  );
  const slug = options.slackConnectorSlug ?? (await deriveSlackConnectorSlug(options.projectRoot));
  const connectorUid = options.slackConnectorUid ?? `slack/${slug}`;
  await writeTextFile(filePath, buildSlackTemplate(connectorUid), { force: options.force });
  const result: SlackChannelWrittenResult = {
    kind: "slack",
    action: fileAlreadyExists ? "overwritten" : "created",
    filesWritten: [filePath],
    filesSkipped: [],
    packageJsonUpdated,
    slackConnectorSlug: slug,
  };
  if (fileAlreadyExists) {
    result.filesOverwritten = [filePath];
  }
  return result;
}

export async function listAuthoredChannels(projectRoot: string): Promise<string[]> {
  const channelsDir = join(projectRoot, USER_AUTHORED_CHANNEL_DIR);
  let entries;
  try {
    entries = await readdir(channelsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const channels: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      const baseName = getSupportedModuleBaseName(entry.name);
      if (baseName !== null) channels.push(baseName);
      continue;
    }
    if (entry.isDirectory()) {
      try {
        const inner = await readdir(join(channelsDir, entry.name));
        if (inner.some((fileName) => matchesSupportedModuleBaseName(fileName, "connection"))) {
          channels.push(entry.name);
        }
      } catch {
        // Skip unreadable directories.
      }
    }
  }

  return channels.sort();
}
