import type { SandboxSession } from "#shared/sandbox-session.js";

const MODEL_HOME_ROOT = "$HOME";

export const MODEL_SKILL_ROOT = `${MODEL_HOME_ROOT}/.agents/skills`;
export const FALLBACK_SKILL_ROOT = "/workspace/skills";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;
const sandboxHomeCache = new WeakMap<SandboxSession, Promise<string | null>>();

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

/**
 * Resolves where skills live in the sandbox: under the probed home when it has
 * one, and under {@link FALLBACK_SKILL_ROOT} when it does not.
 */
export async function resolveSandboxSkillRoot(input: {
  readonly sandbox: SandboxSession;
}): Promise<string> {
  return await resolveSandboxModelPath({ path: MODEL_SKILL_ROOT, sandbox: input.sandbox });
}

/**
 * Resolves a leading `$HOME` in a model-supplied sandbox path without
 * evaluating any other shell syntax. Skill paths retain their documented
 * `/workspace/skills` fallback when the sandbox does not expose a usable
 * home directory.
 */
export async function resolveSandboxModelPath(input: {
  readonly path: string;
  readonly sandbox: SandboxSession;
}): Promise<string> {
  if (!isModelHomePath(input.path)) {
    return input.path;
  }

  const home = await resolveSandboxHome(input.sandbox);
  if (home !== null) {
    const suffix = input.path.slice(MODEL_HOME_ROOT.length);
    return suffix.length === 0 ? home : `${home === "/" ? "" : home}${suffix}`;
  }

  if (isModelSkillPath(input.path)) {
    return `${FALLBACK_SKILL_ROOT}${input.path.slice(MODEL_SKILL_ROOT.length)}`;
  }

  return input.path;
}

export async function resolveSandboxSkillReadPaths(input: {
  readonly name: string;
  readonly relativePath: string;
  readonly sandbox: SandboxSession;
}): Promise<readonly string[]> {
  return await resolveSkillRootCandidates({
    suffix: `/${input.name}/${input.relativePath}`,
    sandbox: input.sandbox,
  });
}

/**
 * Ordered sandbox paths to try when reading a model-supplied file. A path that
 * targets the skill root — either the symbolic `$HOME/.agents/skills/…` form or
 * the literal `/workspace/skills/…` fallback — resolves to the probed home root
 * first and the `/workspace/skills` fallback second, matching the documented
 * resolution order. Any other path resolves to a single entry via
 * {@link resolveSandboxModelPath}.
 */
export async function resolveSkillFilePathCandidates(input: {
  readonly path: string;
  readonly sandbox: SandboxSession;
}): Promise<readonly string[]> {
  const suffix = skillRootSuffix(input.path);
  if (suffix === null) {
    return [await resolveSandboxModelPath({ path: input.path, sandbox: input.sandbox })];
  }
  return await resolveSkillRootCandidates({ suffix, sandbox: input.sandbox });
}

/**
 * Extracts the `/<skill>/<relativePath>` remainder shared by both skill roots,
 * or `null` when the path targets neither root.
 */
function skillRootSuffix(path: string): string | null {
  if (path === MODEL_SKILL_ROOT || path.startsWith(`${MODEL_SKILL_ROOT}/`)) {
    return path.slice(MODEL_SKILL_ROOT.length);
  }
  if (path === FALLBACK_SKILL_ROOT || path.startsWith(`${FALLBACK_SKILL_ROOT}/`)) {
    return path.slice(FALLBACK_SKILL_ROOT.length);
  }
  return null;
}

async function resolveSkillRootCandidates(input: {
  readonly suffix: string;
  readonly sandbox: SandboxSession;
}): Promise<readonly string[]> {
  const candidates: string[] = [];
  const home = await resolveSandboxHome(input.sandbox);
  if (home !== null) {
    const base = home === "/" ? "" : home;
    candidates.push(`${base}${MODEL_SKILL_ROOT.slice(MODEL_HOME_ROOT.length)}${input.suffix}`);
  }
  candidates.push(`${FALLBACK_SKILL_ROOT}${input.suffix}`);
  return candidates;
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

  const next = probeSandboxHome(sandbox);
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

function isModelHomePath(path: string): boolean {
  return path === MODEL_HOME_ROOT || path.startsWith(`${MODEL_HOME_ROOT}/`);
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
