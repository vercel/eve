import type { SandboxAccess } from "#sandbox/state.js";
import type { SkillHandle } from "#execution/skills/types.js";
import { createSandboxSkillStore, type SkillStoreLocation } from "#runtime/skills/store.js";

const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

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
  location: SkillStoreLocation = {},
): Promise<string> {
  assertSafeSkillId(id);
  const store = createSandboxSkillStore(access, location);
  const instructions = await store.readText(id, "SKILL.md");
  if (instructions !== null) {
    return instructions.replace(FRONTMATTER_PATTERN, "");
  }

  const hint = availableNames.length > 0 ? ` Available skills: ${availableNames.join(", ")}.` : "";
  throw new Error(`No skill named "${id}" at ${await store.resolvedRoot()}/${id}/SKILL.md.${hint}`);
}

/**
 * Creates the public runtime skill handle. Existence is checked lazily by
 * each file read against the sandbox.
 */
export function createSandboxSkillHandle(
  access: SandboxAccess,
  id: string,
  location: SkillStoreLocation = {},
): SkillHandle {
  assertSafeSkillId(id);
  const store = createSandboxSkillStore(access, location);

  return {
    name: id,
    file(relativePath: string) {
      assertSafeSkillRelativePath(relativePath);

      return {
        async bytes(): Promise<Uint8Array> {
          const content = await store.readBytes(id, relativePath);
          if (content !== null) return content;
          throw new Error(`Skill file not found: ${store.modelRoot()}/${id}/${relativePath}`);
        },
        async text(): Promise<string> {
          const content = await store.readText(id, relativePath);
          if (content !== null) return content;
          throw new Error(`Skill file not found: ${store.modelRoot()}/${id}/${relativePath}`);
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
