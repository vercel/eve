import type { SandboxAccess } from "#sandbox/state.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import type { MaterializableSkillPackage } from "#shared/skill-package.js";
import { MODEL_SKILL_ROOT, resolveSandboxModelPath } from "#shared/skill-paths.js";

export interface SkillStoreLocation {
  /**
   * Agent home directory (`/agents/{slug}`) for a subagent sharing a
   * parent sandbox. Absent for the sandbox-owning agent, whose skills
   * live under the real `$HOME`.
   */
  readonly home?: string;
}

export interface SkillStore {
  readonly location: SkillStoreLocation;
  modelRoot(): string;
  resolvedRoot(): Promise<string>;
  readBytes(skill: string, relativePath: string): Promise<Uint8Array | null>;
  readText(skill: string, relativePath: string): Promise<string | null>;
  remove(skill: string): Promise<void>;
  write(skill: MaterializableSkillPackage): Promise<void>;
}

export function createSkillStoreLocation(input: { readonly home?: string }): SkillStoreLocation {
  return { home: input.home };
}

/**
 * The skill root expression is the same for every agent —
 * `$HOME/.agents/skills`. Agents with a dedicated home resolve `$HOME`
 * to it here; the sandbox-owning agent defers to the live sandbox's
 * `$HOME` probe.
 */
export function resolveSkillStoreModelRoot(location: SkillStoreLocation): string {
  return location.home === undefined ? MODEL_SKILL_ROOT : `${location.home}/.agents/skills`;
}

export function createSandboxSkillStore(
  access: SandboxAccess,
  location: SkillStoreLocation,
): SkillStore {
  let sandboxPromise: Promise<SandboxSession> | undefined;

  async function sandbox(): Promise<SandboxSession> {
    if (sandboxPromise !== undefined) return await sandboxPromise;
    sandboxPromise = access.get().then((session) => {
      if (session === null) {
        throw new Error("The sandbox is not available in the current authored runtime context.");
      }
      return session;
    });
    return await sandboxPromise;
  }

  async function resolvedRoot(): Promise<string> {
    const session = await sandbox();
    return await resolveSandboxModelPath({
      path: resolveSkillStoreModelRoot(location),
      sandbox: session,
    });
  }

  function filePath(root: string, skill: string, relativePath: string): string {
    return `${root}/${skill}/${relativePath}`;
  }

  return {
    location,
    modelRoot: () => resolveSkillStoreModelRoot(location),
    resolvedRoot,
    async readBytes(skill, relativePath) {
      const session = await sandbox();
      return await session.readBinaryFile({
        path: filePath(await resolvedRoot(), skill, relativePath),
      });
    },
    async readText(skill, relativePath) {
      const session = await sandbox();
      return await session.readTextFile({
        path: filePath(await resolvedRoot(), skill, relativePath),
      });
    },
    async remove(skill) {
      const session = await sandbox();
      await session.removePath({
        force: true,
        path: `${await resolvedRoot()}/${skill}`,
        recursive: true,
      });
    },
    async write(skill) {
      const session = await sandbox();
      const root = await resolvedRoot();
      for (const file of skill.files) {
        await session.writeBinaryFile({
          content: file.content,
          path: filePath(root, skill.name, file.relativePath),
        });
      }
    },
  };
}
