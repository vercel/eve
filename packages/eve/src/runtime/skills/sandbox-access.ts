import type { SandboxSession } from "#public/definitions/sandbox.js";
import type { SandboxAccess } from "#sandbox/state.js";
import type { SkillHandle } from "#shared/skill-types.js";
import { resolveSandboxSkillReadPaths } from "#shared/skill-paths.js";

/**
 * Validates a skill id before it is used as one path segment under
 * the sandbox skill root.
 */
export function assertSafeSkillId(id: string): asserts id is string {
  if (
    id.length === 0 ||
    id.trim() !== id ||
    id.startsWith(".") ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("..") ||
    /^[A-Za-z]:/.test(id)
  ) {
    throw new Error(
      'Expected skill id to be a non-empty safe path segment without whitespace, separators, "." prefix, or "..".',
    );
  }
}

/**
 * Creates the public runtime skill handle. Existence is checked lazily by
 * each file read against the sandbox.
 */
export function createSandboxSkillHandle(access: SandboxAccess, id: string): SkillHandle {
  assertSafeSkillId(id);

  return {
    name: id,
    file(relativePath: string) {
      assertSafeSkillRelativePath(relativePath);

      return {
        async bytes(): Promise<Uint8Array> {
          const sandbox = await requireSandboxSession(access);
          const paths = await resolveSandboxSkillReadPaths({
            name: id,
            relativePath,
            sandbox,
          });

          for (const path of paths) {
            const content = await sandbox.readBinaryFile({ path });
            if (content !== null) {
              return content;
            }
          }

          throw new Error(`Skill file not found: ${paths[0]}`);
        },
        async text(): Promise<string> {
          const sandbox = await requireSandboxSession(access);
          const paths = await resolveSandboxSkillReadPaths({
            name: id,
            relativePath,
            sandbox,
          });

          for (const path of paths) {
            const content = await sandbox.readTextFile({ path });
            if (content !== null) {
              return content;
            }
          }

          throw new Error(`Skill file not found: ${paths[0]}`);
        },
      };
    },
  };
}

function assertSafeSkillRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("Expected skill file path to be a relative path inside the skill directory.");
  }
}

async function requireSandboxSession(access: SandboxAccess): Promise<SandboxSession> {
  const sandbox = await access.get();
  if (sandbox === null) {
    throw new Error("The sandbox is not available in the current authored runtime context.");
  }
  return sandbox;
}
