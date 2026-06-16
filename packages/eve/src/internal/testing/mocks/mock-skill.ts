import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import type { CompiledSkillDefinition } from "#compiler/manifest.js";

/**
 * Declarative description of one synthetic authored skill.
 *
 * Resource files are materialized under one tmpdir and cleaned up through
 * an automatically registered `afterEach`.
 */
export interface MockSkillInput {
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
  /**
   * Compiled skill definition suitable for AppHarness descriptors.
   */
  readonly source: CompiledSkillDefinition;
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
 * returned `source.referencesPath` / `scriptsPath` / `assetsPath` are
 * ready before the first test read. Cleanup of any materialized directory
 * runs automatically via this module's `afterEach` hook.
 */
export async function mockSkill(input: MockSkillInput): Promise<MockSkill> {
  const hasReferences = input.references !== undefined && Object.keys(input.references).length > 0;
  const hasScripts = input.scripts !== undefined && Object.keys(input.scripts).length > 0;
  const hasAssets = input.assets !== undefined && Object.keys(input.assets).length > 0;

  let rootPath: string | undefined;
  let referencesPath: string | undefined;
  let scriptsPath: string | undefined;
  let assetsPath: string | undefined;

  rootPath = await mkdtemp(join(tmpdir(), `eve-mock-skill-${input.name}-`));
  await writeFile(join(rootPath, "SKILL.md"), input.markdown ?? input.description);

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

  const source: CompiledSkillDefinition = buildSkillSource({
    assetsPath,
    description: input.description,
    markdown: input.markdown ?? input.description,
    name: input.name,
    referencesPath,
    rootPath,
    scriptsPath,
  });

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;

    if (rootPath !== undefined) {
      await rm(rootPath, { force: true, recursive: true });
    }
  };

  if (rootPath !== undefined) {
    pendingMockSkillCleanups.push(cleanup);
  }

  return {
    cleanup,
    source,
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

function buildSkillSource(input: {
  assetsPath: string | undefined;
  description: string;
  markdown: string;
  name: string;
  referencesPath: string | undefined;
  rootPath: string;
  scriptsPath: string | undefined;
}): CompiledSkillDefinition {
  const source: CompiledSkillDefinition = {
    description: input.description,
    logicalPath: `skills/${input.name}/SKILL.md`,
    markdown: input.markdown,
    name: input.name,
    sourceId: `skills/${input.name}/SKILL.md`,
    sourceKind: "skill-package",
    skillId: input.name,
    skillFilePath: join(input.rootPath, "SKILL.md"),
    rootPath: input.rootPath,
  };

  const mutable = source as {
    assetsPath?: string;
    referencesPath?: string;
    scriptsPath?: string;
  };

  if (input.assetsPath !== undefined) {
    mutable.assetsPath = input.assetsPath;
  }
  if (input.referencesPath !== undefined) {
    mutable.referencesPath = input.referencesPath;
  }
  if (input.scriptsPath !== undefined) {
    mutable.scriptsPath = input.scriptsPath;
  }

  return source;
}
