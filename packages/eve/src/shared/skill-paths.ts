import { getSessionSkillsRoot, runInternalCommand } from "#execution/sandbox/internal-shell.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const MODEL_HOME_ROOT = "$HOME";

export const MODEL_SKILL_ROOT = `${MODEL_HOME_ROOT}/.agents/skills`;
export const HOST_SKILL_ROOT_ENV = "EVE_SKILLS_DIR";
export const MODEL_HOST_SKILL_ROOT = `$${HOST_SKILL_ROOT_ENV}`;

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;
const sandboxHomeCache = new WeakMap<SandboxSession, Promise<string | null>>();

export async function resolveSandboxSkillRoot(input: {
  readonly sandbox: SandboxSession;
}): Promise<string> {
  const skillsRoot = sessionSkillsRoot(input.sandbox);
  if (skillsRoot !== undefined) return skillsRoot;
  return await resolveSandboxModelPath({ path: MODEL_SKILL_ROOT, sandbox: input.sandbox });
}

export async function resolveSandboxModelPath(input: {
  readonly path: string;
  readonly sandbox: SandboxSession;
}): Promise<string> {
  if (input.path === MODEL_HOST_SKILL_ROOT || input.path.startsWith(`${MODEL_HOST_SKILL_ROOT}/`)) {
    const skillsRoot = sessionSkillsRoot(input.sandbox);
    return skillsRoot === undefined
      ? input.path
      : replacePrefix(input.path, MODEL_HOST_SKILL_ROOT, skillsRoot);
  }

  const prefix = homePrefixOf(input.path);
  if (prefix === undefined) return input.path;

  const home = await resolveSandboxHome(input.sandbox);
  if (home !== null) return replacePrefix(input.path, prefix, home);

  if (input.path === MODEL_SKILL_ROOT || input.path.startsWith(`${MODEL_SKILL_ROOT}/`)) {
    return input.sandbox.resolvePath(`skills${input.path.slice(MODEL_SKILL_ROOT.length)}`);
  }

  return input.path;
}

export async function resolveSandboxSkillWritePath(input: {
  readonly name: string;
  readonly relativePath: string;
  readonly sandbox: SandboxSession;
}): Promise<string> {
  const root = await resolveSandboxSkillRoot({ sandbox: input.sandbox });
  return `${root === "/" ? "" : root}/${input.name}/${input.relativePath}`;
}

function sessionSkillsRoot(sandbox: SandboxSession): string | undefined {
  const direct = getSessionSkillsRoot(sandbox);
  return direct !== undefined && isUsableSandboxDirectory(direct)
    ? normalizeSandboxDirectory(direct)
    : undefined;
}

function replacePrefix(path: string, prefix: string, root: string): string {
  const suffix = path.slice(prefix.length);
  return suffix.length === 0 ? root : `${root === "/" ? "" : root}${suffix}`;
}

async function resolveSandboxHome(sandbox: SandboxSession): Promise<string | null> {
  const cached = sandboxHomeCache.get(sandbox);
  if (cached !== undefined) return await cached;

  const next = probeSandboxHome(sandbox).then((home) => {
    if (home === null) sandboxHomeCache.delete(sandbox);
    return home;
  });
  sandboxHomeCache.set(sandbox, next);
  return await next;
}

async function probeSandboxHome(sandbox: SandboxSession): Promise<string | null> {
  try {
    const result = await runInternalCommand(sandbox, { command: HOME_PROBE_COMMAND });
    if (result.exitCode !== 0) return null;
    const home = result.stdout.trim();
    return isUsableSandboxDirectory(home) ? normalizeSandboxDirectory(home) : null;
  } catch {
    return null;
  }
}

function homePrefixOf(path: string): string | undefined {
  if (path === MODEL_HOME_ROOT || path.startsWith(`${MODEL_HOME_ROOT}/`)) return MODEL_HOME_ROOT;
  if (path === "~" || path.startsWith("~/")) return "~";
  return undefined;
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
