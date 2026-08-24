import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import type { CompileFromMemorySkillInput } from "#compiler/compile-from-memory.js";

/**
 * Declarative description of one synthetic authored skill.
 *
 * Resource files are materialized under one tmpdir and cleaned up through
 * an automatically registered `afterEach`.
 */
export interface MockSkillInput extends CompileFromMemorySkillInput {
  /** Stable skill name exposed to the runtime. */
  readonly name: string;
  /** Semantic description of the skill. */
  readonly description: string;
  /**
   * Markdown body written to `SKILL.md`. Defaults to the description when
   * omitted.
   */
  readonly markdown?: string;
  /**
   * Reference files keyed by their logical filename (e.g. `catalog.yml`).
   * Pass this to simulate the `references/` subtree of a skill package.
   */
  readonly references?: Readonly<Record<string, string>>;
  /**
   * Script files keyed by logical filename.
   */
  readonly scripts?: Readonly<Record<string, string>>;
  /**
   * Asset files keyed by logical filename.
   */
  readonly assets?: Readonly<Record<string, string>>;
}

/**
 * A materialized mock skill returned from {@link mockSkill}.
 */
export interface MockSkill {
  /** Authored skill input suitable for AppHarness descriptors. */
  readonly input: CompileFromMemorySkillInput;
  /** Materialized paths exposed only for filesystem-focused mock tests. */
  readonly paths: MockSkillMaterializedPaths;
  /**
   * Removes any on-disk files written on behalf of this skill.
   *
   * Tests do **not** need to wire this into their own `afterEach` —
   * this module installs an automatic cleanup hook at import time. This
   * method is retained as an escape hatch for tests that want to release
   * the tmpdir mid-body (e.g. to prove the runtime gracefully handles
   * missing reference files). Calling it more than once is safe.
   */
  cleanup(): Promise<void>;
}

/** Filesystem paths materialized for one {@link MockSkill}. */
export interface MockSkillMaterializedPaths {
  readonly assetsPath?: string;
  readonly referencesPath?: string;
  readonly rootPath: string;
  readonly scriptsPath?: string;
  readonly skillFilePath: string;
}

/**
 * Registers an `afterEach` hook that cleans up every {@link MockSkill}
 * materialized during a test. The hook is installed at module import time
 * so it is bound to the file-level suite rather than a nested suite.
 *
 * Using a module-level registration (rather than re-registering per call)
 * keeps the vitest hook list short — vitest reports each `afterEach`
 * registration, so one shared hook avoids cluttering the runner's
 * accounting.
 */
const pendingMockSkillCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const cleanups = pendingMockSkillCleanups.splice(0);
  await Promise.all(
    cleanups.map(async (cleanup) => {
      try {
        await cleanup();
      } catch {
        // Best-effort cleanup; a leaked tmpdir must not fail the run.
      }
    }),
  );
});

/**
 * Builds a {@link MockSkill} for the AppHarness.
 *
 * File subtree materialization happens eagerly at construction time so the
 * returned `paths.referencesPath` / `scriptsPath` / `assetsPath` are
 * ready before the first test read. Cleanup of any materialized directory
 * runs automatically via this module's `afterEach` hook.
 */
export async function mockSkill(input: MockSkillInput): Promise<MockSkill> {
  const hasReferences = input.references !== undefined && Object.keys(input.references).length > 0;
  const hasScripts = input.scripts !== undefined && Object.keys(input.scripts).length > 0;
  const hasAssets = input.assets !== undefined && Object.keys(input.assets).length > 0;

  let referencesPath: string | undefined;
  let scriptsPath: string | undefined;
  let assetsPath: string | undefined;

  const rootPath = await mkdtemp(join(tmpdir(), `eve-mock-skill-${input.name}-`));
  const markdown = input.markdown ?? input.description;
  const skillFilePath = join(rootPath, "SKILL.md");
  await writeFile(skillFilePath, markdown);

  if (hasReferences) {
    referencesPath = join(rootPath, "references");
    await materializeSubtree(referencesPath, input.references ?? {});
  }

  if (hasScripts) {
    scriptsPath = join(rootPath, "scripts");
    await materializeSubtree(scriptsPath, input.scripts ?? {});
  }

  if (hasAssets) {
    assetsPath = join(rootPath, "assets");
    await materializeSubtree(assetsPath, input.assets ?? {});
  }

  const authoredInput: {
    description: string;
    license?: string;
    markdown: string;
    metadata?: Readonly<Record<string, string>>;
    name: string;
  } = {
    description: input.description,
    markdown,
    name: input.name,
  };
  if (input.license !== undefined) {
    authoredInput.license = input.license;
  }
  if (input.metadata !== undefined) {
    authoredInput.metadata = input.metadata;
  }

  const paths: {
    assetsPath?: string;
    referencesPath?: string;
    rootPath: string;
    scriptsPath?: string;
    skillFilePath: string;
  } = { rootPath, skillFilePath };
  if (assetsPath !== undefined) {
    paths.assetsPath = assetsPath;
  }
  if (referencesPath !== undefined) {
    paths.referencesPath = referencesPath;
  }
  if (scriptsPath !== undefined) {
    paths.scriptsPath = scriptsPath;
  }

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;

    await rm(rootPath, { force: true, recursive: true });
  };

  pendingMockSkillCleanups.push(cleanup);

  return {
    cleanup,
    input: authoredInput,
    paths,
  };
}

async function materializeSubtree(
  directory: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(directory, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), content);
  }
}
