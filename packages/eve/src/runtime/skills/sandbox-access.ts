import type { SandboxSession } from "#public/definitions/sandbox.js";
import type { SandboxAccess } from "#sandbox/state.js";
import type { SkillHandle } from "#execution/skills/types.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Validates a skill id before it is used as one path segment under
 * `/workspace/skills`.
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
 * Reads one skill's instruction markdown from the current sandbox.
 *
 * Returns the SKILL.md body with any YAML frontmatter stripped, so the
 * model receives plain markdown as the tool result. Throws when the id
 * is unsafe or the file does not exist; the AI SDK forwards the error
 * to the model as a tool-error result. `availableNames`, when given, is
 * listed in the not-found error so the model can correct a wrong id.
 */
export async function loadSkillFromSandbox(
  access: SandboxAccess,
  id: string,
  availableNames: readonly string[] = [],
): Promise<string> {
  assertSafeSkillId(id);
  const sandbox = await requireSandboxSession(access);
  const path = skillFilePath(id, "SKILL.md");
  const instructions = await sandbox.readTextFile({ path });

  if (instructions === null) {
    const hint =
      availableNames.length > 0 ? ` Available skills: ${availableNames.join(", ")}.` : "";
    throw new Error(`No skill named "${id}" at ${path}.${hint}`);
  }

  return instructions.replace(FRONTMATTER_PATTERN, "");
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
      const path = skillFilePath(id, relativePath);

      return {
        async bytes(): Promise<Uint8Array> {
          const sandbox = await requireSandboxSession(access);
          const content = await sandbox.readBinaryFile({ path });
          if (content === null) throw new Error(`Skill file not found: ${path}`);
          return content;
        },
        async text(): Promise<string> {
          const sandbox = await requireSandboxSession(access);
          const content = await sandbox.readTextFile({ path });
          if (content === null) throw new Error(`Skill file not found: ${path}`);
          return content;
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

function skillFilePath(id: string, relativePath: string): string {
  return `${WORKSPACE_ROOT}/skills/${id}/${relativePath}`;
}
