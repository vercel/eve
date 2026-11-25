import type { SandboxSession } from "#shared/sandbox-session.js";

const MODEL_HOME_ROOT = "$HOME";

export const MODEL_SKILL_ROOT = `${MODEL_HOME_ROOT}/.agents/skills`;

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;
const sandboxHomeCache = new WeakMap<SandboxSession, Promise<string | null>>();

export async function resolveSandboxSkillRoot(input: {
  readonly sandbox: SandboxSession;
}): Promise<string> {
  return await resolveSandboxModelPath({ path: MODEL_SKILL_ROOT, sandbox: input.sandbox });
}

export async function resolveSandboxModelPath(input: {
  readonly path: string;
  readonly sandbox: SandboxSession;
}): Promise<string> {
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
  const cached = sandboxHomeCache.get(sandbox);
  if (cached !== undefined) {
    return await cached;
  }

  const next = probeSandboxHome(sandbox).then((home) => {
    if (home === null) {
      sandboxHomeCache.delete(sandbox);
    }
    return home;
  });
  sandboxHomeCache.set(sandbox, next);
  return await next;
}

async function probeSandboxHome(sandbox: SandboxSession): Promise<string | null> {
  try {
    const result = await sandbox.run({ command: HOME_PROBE_COMMAND });
    if (result.exitCode !== 0) {
      return null;
    }

    const home = result.stdout.trim();
    if (!isUsableSandboxHome(home)) {
      return null;
    }

    return normalizeSandboxHome(home);
  } catch {
    return null;
  }
}

function homePrefixOf(path: string): string | undefined {
  if (path === MODEL_HOME_ROOT || path.startsWith(`${MODEL_HOME_ROOT}/`)) return MODEL_HOME_ROOT;
  if (path === "~" || path.startsWith("~/")) return "~";
  return undefined;
}

function isModelSkillPath(path: string): boolean {
  return path === MODEL_SKILL_ROOT || path.startsWith(`${MODEL_SKILL_ROOT}/`);
}

function isUsableSandboxHome(path: string): boolean {
  return (
    path.length > 0 &&
    path.startsWith("/") &&
    !path.includes("\0") &&
    !path.includes("\n") &&
    !path.includes("\r")
  );
}

function normalizeSandboxHome(home: string): string {
  return home === "/" ? home : home.replace(/\/+$/, "");
}
