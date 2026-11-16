/**
 * Sync the house-wide writing-style references into every skill, and generate the
 * `reviewer` subagent's bundled rubric module.
 *
 * @remarks
 * Source of truth: `shared-references/` (the house lists) plus each skill's own
 * `references/` (per-surface best-practices and specs). Each shared file is copied verbatim
 * into every `agent/skills/<name>/references/` folder, and a managed `## Shared references`
 * section is (re)generated at the end of each skill's `SKILL.md` so the skill always cites
 * exactly the shared files it carries. Each skill's own `## References` section — and any
 * skill-specific bullets in it — is preserved untouched.
 *
 * The `reviewer` subagent inherits no skills and runs no sandbox, so it can't reach those
 * files the way the root does. Instead this script bundles them into a generated TypeScript
 * module ({@link REVIEWER_RUBRIC_MODULE}) that the reviewer's `get_surface_rubric` tool
 * imports — one app-runtime call returns the house lists plus a surface's best-practices and
 * specs, with no sandbox round-trip.
 *
 * The canonical surface list is likewise derived from the `<surface>-style` folders into a
 * shared {@link SURFACES_MODULE} that both `check_style` and `get_surface_rubric` import,
 * so the folders are the single source of truth and no hand-edited enum can drift.
 *
 * Each skill's `references/banned-words.json` is bundled the same way into
 * {@link BANNED_WORDS_MODULE}, which `check_style` imports. Tool code can't read a skill's
 * files at runtime (eve removed `ctx.getSkill()` in 0.66), so the list ships as a module instead;
 * the JSON in the skill folder stays the source of truth the model also reads.
 *
 * The generated copies, SKILL.md sections, and modules are committed, so they ship with
 * `eve build` / `eve deploy` and are visible to `eve info` even when the build command
 * does not trigger the pnpm lifecycle hooks.
 *
 * Run it with `pnpm sync:shared`; it also runs automatically on the `predev` and
 * `prebuild` hooks. Edit the originals in `shared-references/` and the bullet text in
 * {@link SHARED_FILES}, never the generated copies or the managed section.
 *
 * @module scripts/sync-shared
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute repository root (one level up from this script). */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directory holding the canonical shared reference files. */
const sharedDir = resolve(root, "shared-references");

/** Directory holding the per-platform skill folders. */
const skillsDir = resolve(root, "agent", "skills");

/** The `agent/` root, the base every generated module must resolve inside. */
const agentDir = resolve(root, "agent");

/** Directory holding the declared subagents. */
const subagentsDir = resolve(agentDir, "subagents");

/**
 * Generated TypeScript module: the canonical surface list, shared across agents.
 *
 * @remarks
 * The surfaces are derived from the `<surface>-style` skill folders, so the folders are the
 * single source of truth. Both the root's `check_style` tool and the reviewer's
 * `get_surface_rubric` tool import `SURFACES` from here — adding a skill folder updates the enum
 * everywhere with no hand-edited list to drift. `lib/` is import-only shared code (it is never
 * mounted into a sandbox), which is how a subagent reaches it across the isolation boundary.
 * Excluded from Biome in `biome.jsonc` (machine-written) but still type-checked by `tsc`.
 */
const SURFACES_MODULE = join(agentDir, "lib", "surfaces.generated.ts");

/**
 * Generated TypeScript module bundling the reviewer's per-surface rubric.
 *
 * @remarks
 * The `reviewer` subagent inherits no skills, so its `get_surface_rubric` tool can't read skill
 * files at runtime. This script writes the rubric into a committed module the tool imports, so
 * the content ships with `eve build` / `eve deploy`. Must resolve inside {@link subagentsDir}.
 * It is type-checked by `tsc` but excluded from Biome in `biome.jsonc` (it is machine-written).
 */
const REVIEWER_RUBRIC_MODULE = join(
  subagentsDir,
  "reviewer",
  "lib",
  "rubric.generated.ts"
);

/**
 * Generated TypeScript module: each surface's banned-words list, for `check_style`.
 *
 * @remarks
 * Built from every `<surface>-style/references/banned-words.json`. Lives in `lib/` (import-only
 * shared code). Excluded from Biome in `biome.jsonc` (machine-written) but type-checked by `tsc`.
 */
const BANNED_WORDS_MODULE = join(agentDir, "lib", "banned-words.generated.ts");

/** Basename of each skill's banned-words reference file. */
const BANNED_WORDS_FILE = "banned-words.json";

/** Suffix marking a skill folder (`blog-style`); stripped to get the surface (`blog`). */
const SKILL_SUFFIX = "-style";

/** Basename of every skill's definition file. */
const SKILL_FILE = "SKILL.md";

/** Suffix marking a skill's per-surface specs reference file (`format-specs.md`). */
const SPECS_SUFFIX = "-specs.md";

/** Basename of each skill's best-practices reference file. */
const BEST_PRACTICES_FILE = "best-practices.md";

/** Header marking the generated rubric module as machine-written. */
const GENERATED_HEADER = [
  "// AUTO-GENERATED by scripts/sync-shared.mjs — do not edit.",
  "// Run `pnpm sync:shared` after changing shared-references/ or a skill's references.",
].join("\n");

/**
 * Shared reference files mirrored into every skill, each with the Markdown bullet that
 * describes it in the generated `## Shared references` section.
 *
 * @remarks
 * Hard-coded rather than derived from input, so the copy set and its prose are fixed and
 * auditable. Adding a house-wide reference is a single entry here plus the file in
 * `shared-references/`; every skill then picks up both the copy and the bullet on the
 * next `pnpm sync:shared`. Bullet `lines` are pre-wrapped to match the surrounding docs.
 */
const SHARED_FILES = [
  {
    lines: [
      "- `references/ai-phrases-to-avoid.md` — AI-tell words, phrases, and punctuation to avoid.",
    ],
    name: "ai-phrases-to-avoid.md",
  },
  {
    lines: [
      "- `references/plain-english-alternatives.md` — plain-English swaps for bloated or vague wording.",
    ],
    name: "plain-english-alternatives.md",
  },
];

/** Heading that introduces the script-managed shared-references section in each SKILL.md. */
const SHARED_SECTION_HEADING = "## Shared references";

/** Heading each SKILL.md must already carry; the managed section is anchored after it. */
const REQUIRED_ANCHOR_HEADING = "## References";

/** Intro paragraph rendered under the managed section heading. */
const SHARED_SECTION_INTRO =
  "Shared global references for all skills in the content agent. These apply regardless of the\ncontent type.";

/**
 * Render the managed `## Shared references` Markdown section from {@link SHARED_FILES}.
 *
 * @returns The section text (heading, intro paragraph, one bullet per shared file),
 *   with no trailing newline.
 */
const renderSharedSection = () =>
  [
    SHARED_SECTION_HEADING,
    "",
    SHARED_SECTION_INTRO,
    "",
    ...SHARED_FILES.map((file) => file.lines.join("\n")),
  ].join("\n");

/** A single, traversal-free path segment: no separators, no `.`/`..` tricks. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Trailing whitespace, trimmed before the managed section is re-appended. */
const TRAILING_WHITESPACE = /\s*$/;

/**
 * Whether a string is a safe, single path segment.
 *
 * @remarks
 * Rejects empty strings, `.` / `..`, and anything with a path separator or other
 * unexpected character, so a crafted directory or file name can never redirect a read
 * or write outside its intended folder.
 *
 * @param name - A file or directory name (not a path).
 * @returns `true` when `name` is a single, traversal-free segment.
 */
const isSafeSegment = (name) =>
  SAFE_SEGMENT.test(name) && name !== "." && name !== "..";

/**
 * Resolve `target` and assert it stays inside `base`.
 *
 * @param base - Absolute directory the target must remain within.
 * @param target - Path to resolve and check.
 * @returns The resolved absolute path when it is contained by `base`.
 * @throws When `target` resolves outside `base`.
 */
const resolveWithin = (base, target) => {
  const resolved = resolve(target);
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error(`refusing to touch path outside ${base}: ${resolved}`);
  }
  return resolved;
};

/**
 * Read every shared source file once.
 *
 * @returns A map of filename to UTF-8 contents.
 * @throws When a configured filename is unsafe or a source file is missing.
 */
const readSources = async () => {
  const entries = await Promise.all(
    SHARED_FILES.map(async ({ name }) => {
      if (!isSafeSegment(name)) {
        throw new Error(`unsafe shared filename: ${name}`);
      }
      const path = resolveWithin(sharedDir, join(sharedDir, name));
      return [name, await readFile(path, "utf8")];
    })
  );
  return new Map(entries);
};

/**
 * Write `contents` to `path` only when it differs from what is already there.
 *
 * @remarks
 * Keeps the sync a true no-op on an unchanged run, so the `predev` / `prebuild` hooks do
 * not rewrite (and re-trigger watchers on) identical files, and the reported counts
 * reflect real changes.
 *
 * @param path - Absolute destination path, already checked to live in `skillsDir`.
 * @param contents - Desired file contents.
 * @returns `true` when a write happened.
 */
const writeIfChanged = async (path, contents) => {
  let current;
  try {
    current = await readFile(path, "utf8");
  } catch {
    current = undefined;
  }
  if (current === contents) {
    return false;
  }
  await writeFile(path, contents);
  return true;
};

/**
 * Read one SKILL.md, validate its structure, and compute its desired content with the
 * managed `## Shared references` section (re)generated at the end.
 *
 * @remarks
 * Writes nothing, so every skill can be validated before any file is touched — a single
 * malformed file then aborts the whole run instead of leaving the tree half-synced.
 * Everything above the managed section — including the skill's own `## References` heading
 * and skill-specific bullets — is preserved verbatim. The managed section must be the last
 * heading; a later `##` heading is rejected so the splice can never clobber unrelated
 * content.
 *
 * @param skillFile - Absolute path to a SKILL.md, already checked to live in `skillsDir`.
 * @returns The current file contents and the desired contents.
 * @throws When the file lacks a `## References` anchor, or the managed section is not last.
 */
const planSkillSection = async (skillFile) => {
  const currentMd = await readFile(skillFile, "utf8");
  if (!currentMd.includes(`\n${REQUIRED_ANCHOR_HEADING}`)) {
    throw new Error(
      `${skillFile} has no "${REQUIRED_ANCHOR_HEADING}" section to anchor shared references under`
    );
  }

  const startIdx = currentMd.indexOf(`\n${SHARED_SECTION_HEADING}`);
  let before = currentMd;
  if (startIdx !== -1) {
    if (currentMd.indexOf("\n## ", startIdx + 1) !== -1) {
      throw new Error(
        `${skillFile}: "${SHARED_SECTION_HEADING}" must be the last section`
      );
    }
    before = currentMd.slice(0, startIdx);
  }

  const nextMd = `${before.replace(TRAILING_WHITESPACE, "")}\n\n${renderSharedSection()}\n`;
  return { currentMd, nextMd };
};

/**
 * Copy the shared sources into every skill's `references/` directory and refresh the
 * managed `## Shared references` section in every `SKILL.md`.
 *
 * @remarks
 * Two-phase: every skill's `SKILL.md` is read and validated first, so a single malformed
 * file aborts the run before anything is written rather than leaving the tree half-synced.
 * Only plain subdirectories with safe names are targeted; symlinked entries are skipped so
 * they cannot redirect writes elsewhere, and every destination is re-checked to stay within
 * `agent/skills/`. Writes are skipped when the content is already up to date.
 *
 * @param sources - The shared source files, read once by the caller.
 * @returns Counts of skills scanned, files written, and SKILL.md sections updated.
 */
const syncSharedReferences = async (sources) => {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills = entries
    .filter((entry) => entry.isDirectory() && isSafeSegment(entry.name))
    .map((entry) => entry.name);

  // Phase 1 — resolve paths and validate every SKILL.md before touching the filesystem.
  const plans = await Promise.all(
    skills.map(async (skill) => {
      const referencesDir = resolveWithin(
        skillsDir,
        join(skillsDir, skill, "references")
      );
      const skillFile = resolveWithin(
        skillsDir,
        join(skillsDir, skill, SKILL_FILE)
      );
      const { currentMd, nextMd } = await planSkillSection(skillFile);
      return { currentMd, nextMd, referencesDir, skillFile };
    })
  );

  // Phase 2 — apply, writing only what actually changed.
  const results = await Promise.all(
    plans.map(async ({ currentMd, nextMd, referencesDir, skillFile }) => {
      await mkdir(referencesDir, { recursive: true });
      const writes = await Promise.all(
        [...sources].map(([name, contents]) =>
          writeIfChanged(
            resolveWithin(skillsDir, join(referencesDir, name)),
            contents
          )
        )
      );
      let sectionChanged = false;
      if (nextMd !== currentMd) {
        await writeFile(skillFile, nextMd);
        sectionChanged = true;
      }
      return { sectionChanged, writes: writes.filter(Boolean).length };
    })
  );
  const written = results.reduce((sum, result) => sum + result.writes, 0);
  const sections = results.filter((result) => result.sectionChanged).length;
  return { sections, skills: skills.length, written };
};

/**
 * Render the shared surfaces module source from each surface's description.
 *
 * @remarks
 * Emits `SURFACES` as an `as const` tuple plus the `Surface` union derived from it, so tools can
 * build a `zod` enum and a type from one import, and `SURFACE_DESCRIPTIONS`, which the
 * `detect_surface` tool gives the decision model as its choices. Excluded from Biome
 * (generated) but type-checked by `tsc`.
 *
 * @param descriptions - Each surface id mapped to its skill's `description`, in sorted order.
 * @returns The full module source, with a trailing newline.
 */
const renderSurfacesModule = (descriptions) =>
  `${[
    GENERATED_HEADER,
    "",
    `export const SURFACES = ${JSON.stringify(Object.keys(descriptions))} as const;`,
    "",
    "export type Surface = (typeof SURFACES)[number];",
    "",
    `export const SURFACE_DESCRIPTIONS: Readonly<Record<Surface, string>> = ${JSON.stringify(descriptions, null, 2)};`,
  ].join("\n")}\n`;

/**
 * Render the generated rubric module source from its data.
 *
 * @remarks
 * The literal is emitted with `JSON.stringify` and typed `as const`. The surface list lives in
 * the shared {@link SURFACES_MODULE}, so this module exports only the content map. Excluded from
 * Biome (generated) but type-checked by `tsc`.
 *
 * @param data - The `{ house, surfaces }` rubric data.
 * @returns The full module source, with a trailing newline.
 */
const renderRubricModule = (data) =>
  `${[
    GENERATED_HEADER,
    "",
    `export const REVIEWER_RUBRIC = ${JSON.stringify(data, null, 2)} as const;`,
  ].join("\n")}\n`;

/**
 * Generate the reviewer's bundled rubric module from the house lists and each skill's
 * per-surface references.
 *
 * @remarks
 * Reads each `<surface>-style` skill's {@link BEST_PRACTICES_FILE} and its single `*-specs.md`
 * file, pairs them with the two house lists, and writes a committed `as const` module the
 * reviewer's `get_surface_rubric` tool imports. The surface key is the skill folder name with
 * its {@link SKILL_SUFFIX} removed, matching the `check_style` surface enum. Reuses the
 * same containment checks and write-if-changed behavior as the skill sync.
 *
 * @param sources - The shared house lists, read once by the caller.
 * @returns Whether the module changed and the surfaces it covers.
 * @throws When a skill's references lack a best-practices or `*-specs.md` file.
 */
const generateReviewerRubric = async (sources) => {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        isSafeSegment(entry.name) &&
        entry.name.endsWith(SKILL_SUFFIX)
    )
    .map((entry) => entry.name)
    .sort();

  const surfaceEntries = await Promise.all(
    skills.map(async (skill) => {
      const surface = skill.slice(0, -SKILL_SUFFIX.length);
      const referencesDir = resolveWithin(
        skillsDir,
        join(skillsDir, skill, "references")
      );
      const refEntries = await readdir(referencesDir);
      const specsName = refEntries.find((name) => name.endsWith(SPECS_SUFFIX));
      if (!specsName) {
        throw new Error(
          `${skill}: no "*${SPECS_SUFFIX}" specs file in references/`
        );
      }
      const [bestPractices, specs] = await Promise.all([
        readFile(
          resolveWithin(skillsDir, join(referencesDir, BEST_PRACTICES_FILE)),
          "utf8"
        ),
        readFile(
          resolveWithin(skillsDir, join(referencesDir, specsName)),
          "utf8"
        ),
      ]);
      return [surface, { bestPractices, specs }];
    })
  );
  const surfaces = Object.fromEntries(surfaceEntries);

  const data = {
    house: {
      aiPhrasesToAvoid: sources.get("ai-phrases-to-avoid.md"),
      plainEnglishAlternatives: sources.get("plain-english-alternatives.md"),
    },
    surfaces,
  };

  const path = resolveWithin(subagentsDir, REVIEWER_RUBRIC_MODULE);
  await mkdir(dirname(path), { recursive: true });
  const changed = await writeIfChanged(path, renderRubricModule(data));
  return { changed, surfaces: Object.keys(surfaces) };
};

/**
 * Read and normalize one skill's banned-words list.
 *
 * @remarks
 * The file must be a JSON array of strings. Entries are trimmed, empties dropped, and duplicates
 * removed (first occurrence wins), so the generated list is exactly what the lint matches. A
 * missing file yields an empty list — the surface simply has no banned words — but a file that
 * exists and is malformed fails the run, so a typo surfaces at build time instead of silently
 * disabling the lint.
 *
 * @param skill - The skill folder name, e.g. `blog-style`.
 * @returns The normalized banned words for that surface.
 * @throws When the file is not valid JSON or not an array of strings.
 */
const readBannedWords = async (skill) => {
  const path = resolveWithin(
    skillsDir,
    join(skillsDir, skill, "references", BANNED_WORDS_FILE)
  );
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${skill}: ${BANNED_WORDS_FILE} is not valid JSON`, {
      cause: error,
    });
  }
  if (!(Array.isArray(parsed) && parsed.every((w) => typeof w === "string"))) {
    throw new Error(
      `${skill}: ${BANNED_WORDS_FILE} must be a JSON array of strings`
    );
  }
  return [...new Set(parsed.map((w) => w.trim()).filter(Boolean))];
};

/**
 * Render the banned-words module source.
 *
 * @param data - Map of surface id to its normalized banned words.
 * @returns The full module source, with a trailing newline.
 */
const renderBannedWordsModule = (data) =>
  `${[
    GENERATED_HEADER,
    "",
    'import type { Surface } from "./surfaces.generated.js";',
    "",
    `export const BANNED_WORDS: Readonly<Record<Surface, readonly string[]>> = ${JSON.stringify(data, null, 2)};`,
  ].join("\n")}\n`;

/**
 * Generate {@link BANNED_WORDS_MODULE} from every surface skill's banned-words list.
 *
 * @param surfaces - The surface ids, in stable sorted order.
 * @returns `true` when the module changed.
 */
const generateBannedWordsModule = async (surfaces) => {
  const entries = await Promise.all(
    surfaces.map(async (surface) => [
      surface,
      await readBannedWords(`${surface}${SKILL_SUFFIX}`),
    ])
  );
  const path = resolveWithin(agentDir, BANNED_WORDS_MODULE);
  await mkdir(dirname(path), { recursive: true });
  return writeIfChanged(
    path,
    renderBannedWordsModule(Object.fromEntries(entries))
  );
};

/** Matches the `description` line inside a SKILL.md frontmatter block. */
const FRONTMATTER_DESCRIPTION =
  /^---\n(?:.*\n)*?description:[ \t]*(.+)\n(?:.*\n)*?---/;

/**
 * Read a skill's `description` from its SKILL.md frontmatter.
 *
 * @param skill - The skill folder name.
 * @returns The description text, trimmed.
 * @throws When the skill has no single-line `description` in its frontmatter.
 */
const readSkillDescription = async (skill) => {
  const source = await readFile(
    resolveWithin(skillsDir, join(skillsDir, skill, SKILL_FILE)),
    "utf8"
  );
  const description = FRONTMATTER_DESCRIPTION.exec(source)?.[1]?.trim();
  if (!description) {
    throw new Error(`${skill}: no "description" in ${SKILL_FILE} frontmatter`);
  }
  return description;
};

/**
 * Write the shared {@link SURFACES_MODULE} from the derived surface list.
 *
 * @param surfaces - The surface ids, in stable sorted order.
 * @returns `true` when the module changed.
 */
const generateSurfacesModule = async (surfaces) => {
  const entries = await Promise.all(
    surfaces.map(async (surface) => [
      surface,
      await readSkillDescription(`${surface}${SKILL_SUFFIX}`),
    ])
  );
  const path = resolveWithin(agentDir, SURFACES_MODULE);
  await mkdir(dirname(path), { recursive: true });
  return writeIfChanged(
    path,
    renderSurfacesModule(Object.fromEntries(entries))
  );
};

const sharedSources = await readSources();
const { skills, written, sections } = await syncSharedReferences(sharedSources);
const { changed, surfaces: surfaceIds } =
  await generateReviewerRubric(sharedSources);
await generateSurfacesModule(surfaceIds);
const bannedChanged = await generateBannedWordsModule(surfaceIds);
process.stdout.write(
  `shared skill references: wrote ${written} file(s), updated ${sections} SKILL.md ` +
    `section(s) across ${skills} skill(s); reviewer rubric: ` +
    `${changed ? "regenerated" : "unchanged"} (${surfaceIds.length} surfaces); ` +
    `banned words: ${bannedChanged ? "regenerated" : "unchanged"}\n`
);
