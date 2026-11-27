import { getSessionSkillsRoot, runInternalCommand } from "#execution/sandbox/internal-shell.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const MODEL_HOME_ROOT = "$HOME";

export const MODEL_SKILL_ROOT = `${MODEL_HOME_ROOT}/.agents/skills`;
export const HOST_SKILL_ROOT_ENV = "EVE_SKILLS_DIR";
export const MODEL_HOST_SKILL_ROOT = `$${HOST_SKILL_ROOT_ENV}`;

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;
const SKILLS_DIR_PROBE_COMMAND = `printf '%s\\n' "$${HOST_SKILL_ROOT_ENV}"`;
const sandboxHomeCache = new WeakMap<SandboxSession, Promise<string | null>>();
const sandboxSkillsDirCache = new WeakMap<SandboxSession, Promise<string | null>>();

export async function resolveSandboxSkillRoot(input: {
  readonly sandbox: SandboxSession;
}): Promise<string> {
  const skillsRoot = getSessionSkillsRoot(input.sandbox);
  if (skillsRoot !== undefined && isUsableSandboxDirectory(skillsRoot)) {
    return normalizeSandboxDirectory(skillsRoot);
  }
  return await resolveSandboxModelPath({ path: MODEL_SKILL_ROOT, sandbox: input.sandbox });
}

export async function resolveSandboxModelPath(input: {
  readonly path: string;
  readonly sandbox: SandboxSession;
}): Promise<string> {
  if (isHostSkillPath(input.path)) {
    const skillsDir = await resolveSandboxSkillsDir(input.sandbox);
    if (skillsDir !== null) {
      const suffix = input.path.slice(MODEL_HOST_SKILL_ROOT.length);
      return suffix.length === 0 ? skillsDir : `${skillsDir === "/" ? "" : skillsDir}${suffix}`;
    }
    return input.path;
  }

  const prefix = homePrefixOf(input.path);
  if (prefix === undefined) {
    return input.path;
  }

  const home = await resolveSandboxHome(input.sandbox);
  if (home !== null) {
    const suffix = input.path.slice(prefix.length);
    return suffix.length === 0 ? home : `${home === "/" ? "" : home}${suffix}`;
  }

  if (isModelSkillPath(input.path)) {
    return input.sandbox.resolvePath(`skills${input.path.slice(MODEL_SKILL_ROOT.length)}`);
  }

  return input.path;
}

export async function resolveSandboxSkillWritePath(input: {
  readonly name: string;
  readonly relativePath: string;
  readonly sandbox: SandboxSession;
}): Promise<string> {
  return formatSkillPath({
    name: input.name,
    relativePath: input.relativePath,
    root: await resolveSandboxSkillRoot({ sandbox: input.sandbox }),
  });
}

function formatSkillPath(input: {
  readonly name: string;
  readonly relativePath: string;
  readonly root: string;
}): string {
  return `${input.root}/${input.name}/${input.relativePath}`;
}

async function resolveSandboxHome(sandbox: SandboxSession): Promise<string | null> {
  return await resolveCachedSandboxDirectory(sandbox, sandboxHomeCache, HOME_PROBE_COMMAND);
}

async function resolveSandboxSkillsDir(sandbox: SandboxSession): Promise<string | null> {
  const direct = getSessionSkillsRoot(sandbox);
  if (direct !== undefined && isUsableSandboxDirectory(direct)) {
    return normalizeSandboxDirectory(direct);
  }
  return await resolveCachedSandboxDirectory(
    sandbox,
    sandboxSkillsDirCache,
    SKILLS_DIR_PROBE_COMMAND,
  );
}

async function resolveCachedSandboxDirectory(
  sandbox: SandboxSession,
  cache: WeakMap<SandboxSession, Promise<string | null>>,
  command: string,
): Promise<string | null> {
  const cached = cache.get(sandbox);
  if (cached !== undefined) {
    return await cached;
  }

  const next = probeSandboxDirectory(sandbox, command).then((dir) => {
    if (dir === null) {
      cache.delete(sandbox);
    }
    return dir;
  });
  cache.set(sandbox, next);
  return await next;
}

async function probeSandboxDirectory(
  sandbox: SandboxSession,
  command: string,
): Promise<string | null> {
  try {
    const result = await runInternalCommand(sandbox, { command });
    if (result.exitCode !== 0) {
      return null;
    }

    const dir = result.stdout.trim();
    if (!isUsableSandboxDirectory(dir)) {
      return null;
    }

    return normalizeSandboxDirectory(dir);
  } catch {
    return null;
  }
}

function homePrefixOf(path: string): string | undefined {
  if (path === MODEL_HOME_ROOT || path.startsWith(`${MODEL_HOME_ROOT}/`)) return MODEL_HOME_ROOT;
  if (path === "~" || path.startsWith("~/")) return "~";
  return undefined;
}

function isHostSkillPath(path: string): boolean {
  return path === MODEL_HOST_SKILL_ROOT || path.startsWith(`${MODEL_HOST_SKILL_ROOT}/`);
}

function isModelSkillPath(path: string): boolean {
  return path === MODEL_SKILL_ROOT || path.startsWith(`${MODEL_SKILL_ROOT}/`);
}

function isUsableSandboxDirectory(path: string): boolean {
  return (
    path.length > 0 &&
    path.startsWith("/") &&
    !path.includes("\0") &&
    !path.includes("\n") &&
    !path.includes("\r")
  );
}

function normalizeSandboxDirectory(dir: string): string {
  return dir === "/" ? dir : dir.replace(/\/+$/, "");
}
