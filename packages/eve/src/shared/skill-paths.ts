import type { SandboxSession } from "#shared/sandbox-session.js";

export const MODEL_SKILL_ROOT = "$HOME/.agents/skills";
export const FALLBACK_SKILL_ROOT = "/workspace/skills";

const HOME_SKILL_SUFFIX = ".agents/skills";
const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;
const skillRootCache = new WeakMap<SandboxSession, Promise<string>>();

export function formatSkillModelPath(input: {
  readonly name: string;
  readonly relativePath: string;
}): string {
  return formatSkillPath({
    name: input.name,
    relativePath: input.relativePath,
    root: MODEL_SKILL_ROOT,
  });
}

export function formatFallbackSkillPath(input: {
  readonly name: string;
  readonly relativePath: string;
}): string {
  return formatSkillPath({
    name: input.name,
    relativePath: input.relativePath,
    root: FALLBACK_SKILL_ROOT,
  });
}

export async function resolveSandboxSkillRoot(input: {
  readonly sandbox: SandboxSession;
}): Promise<string> {
  const cached = skillRootCache.get(input.sandbox);
  if (cached !== undefined) {
    return await cached;
  }

  const next = probeSandboxSkillRoot(input.sandbox);
  skillRootCache.set(input.sandbox, next);
  return await next;
}

export async function resolveSandboxSkillReadPaths(input: {
  readonly name: string;
  readonly relativePath: string;
  readonly sandbox: SandboxSession;
}): Promise<readonly string[]> {
  return [
    formatSkillPath({
      name: input.name,
      relativePath: input.relativePath,
      root: await resolveSandboxSkillRoot({ sandbox: input.sandbox }),
    }),
  ];
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

export async function resolveSandboxSeedFilePath(input: {
  readonly path: string;
  readonly sandbox: SandboxSession;
}): Promise<string> {
  if (!input.path.startsWith(`${MODEL_SKILL_ROOT}/`)) {
    return input.path;
  }

  const root = await resolveSandboxSkillRoot({ sandbox: input.sandbox });
  return `${root}${input.path.slice(MODEL_SKILL_ROOT.length)}`;
}

function formatSkillPath(input: {
  readonly name: string;
  readonly relativePath: string;
  readonly root: string;
}): string {
  return `${input.root}/${input.name}/${input.relativePath}`;
}

async function probeSandboxSkillRoot(sandbox: SandboxSession): Promise<string> {
  try {
    const result = await sandbox.run({ command: HOME_PROBE_COMMAND });
    if (result.exitCode !== 0) {
      return FALLBACK_SKILL_ROOT;
    }

    const home = result.stdout.trim();
    if (!isUsableSandboxHome(home)) {
      return FALLBACK_SKILL_ROOT;
    }

    return joinHomeSkillRoot(home);
  } catch {
    return FALLBACK_SKILL_ROOT;
  }
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

function joinHomeSkillRoot(home: string): string {
  const normalizedHome = home === "/" ? "" : home.replace(/\/+$/, "");
  return `${normalizedHome}/${HOME_SKILL_SUFFIX}`;
}
