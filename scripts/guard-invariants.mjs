#!/usr/bin/env node
/**
 * Mechanical enforcement of framework code invariants.
 *
 * Several framework invariants can be checked mechanically. Each one gets a
 * dedicated guard here. Every guard prints an error message that explains
 * *why* the invariant exists and how to fix the violation, so contributors
 * can self-correct without needing a reviewer to re-explain the rule.
 *
 * The numeric rule IDs below are stable identifiers for these lints, tied to
 * the underlying invariant.
 *
 *   rule 9  — No symlinks anywhere in the repo. (Rationale: symlinks are
 *             too unpredictable for a framework to rely on; replace with a
 *             real file or a small loader.)
 *   rule 13 — No spread-ternary object composition
 *             (`...(c ? {} : { k: v })`). (Rationale: hard to read, easy
 *             to mistype; declare the object then assign optional keys.)
 *   rule 15 — No `@workflow/*` imports inside `src/channel/**` or
 *             `src/harness/**`. Channels and harnesses must stay
 *             workflow-agnostic — only runtime/execution code touches
 *             workflow primitives.
 *   rule 19 — No `new AsyncLocalStorage()` outside the two allowlisted
 *             files. All ambient runtime state flows through a single
 *             `EveContext`.
 *   rule 21 — No authored `name:` (or `id:`) field on
 *             `defineMcpClientConnection`, `defineTool`, `defineSkill`,
 *             `defineSandbox`, `defineSchedule`, `defineAgent`, or
 *             `defineEval` calls inside authored
 *             agent trees (`apps/<name>/agent/**`,
 *             `apps/<category>/<name>/agent/**`,
 *             `apps/<name>/evals/**`,
 *             `apps/<category>/<name>/evals/**`, or a top-level `agent/**` /
 *             `evals/**` directory). Identity is derived from the file
 *             path (or, for the root agent, from the package name); an
 *             authored field creates a redundant source of truth that
 *             can drift. Evals also reject `id:` because eval
 *             identity comes from the path under `evals/`.
 *   rule 23 — No new `as unknown as T` double casts (ratcheted via
 *             baseline). Double casts hide real type errors.
 *   rule 25 — No new direct calls to `installBundledCompiledArtifacts`,
 *             `resetBundledCompiledArtifacts`, or
 *             `clearProcessDefaultRuntimeSession` from test bodies.
 *             Tests must scope runtime state through
 *             `createTestRuntime().run(fn)` / `withRuntimeSession(...)`.
 *   rule 26 — No `loadContext() as ContextContainer` casts. Thread a
 *             `ContextContainer` parameter through instead.
 *   rule 27 — No `state:` field on hook lifecycle result types in
 *             `packages/eve/src/public/definitions/hook.ts`. Hook
 *             return shapes must carry only what the harness consumes;
 *             durable state belongs on `ctx.eve`.
 *   rule 28 — Imports under `packages/eve/src/setup/scaffold/**` stay within
 *             their layer: node:* builtins, relative siblings, and the shared
 *             `@vercel/eve-catalog` data package. The scaffold stays free of
 *             framework runtime, compiler, terminal UI, and provider SDK
 *             dependencies.
 *   rule 29 — Changeset package keys must match workspace package names.
 *             Release metadata is consumed before `pnpm release`, so bad
 *             changeset package names must fail in PR CI rather than in the
 *             post-merge release workflow.
 *   rule 30 — The compiled-vendor pipeline (`scripts/vendor-compiled/**`)
 *             must not write a per-package `package.json` into a vendored
 *             output directory. Such a file creates a package scope that
 *             shadows eve's `#compiled/*` imports map, so a cross-package
 *             `#compiled/<pkg>` reference inside one vendored `.d.ts`
 *             (e.g. `@workflow/core` → `@workflow/world` → `zod`) silently
 *             degrades to `any` under `skipLibCheck`. The bundled ESM
 *             inherits `"type": "module"` from eve's root package.json, so
 *             no per-package file is needed. See `prepareCompiledModule`.
 *   rule 31 — Active source and docs must not reference the removed
 *             `create-eve` package or `eve setup` command. Use `eve init`
 *             for project creation and the dedicated current commands
 *             (`eve link`, `eve channels add`, `eve deploy`) afterward.
 *             Changelogs and changesets are historical records and excluded.
 *
 * Baselines for rules with pre-existing violations live in
 * `guard-invariants-baseline.json`. Counts and allowlists in that file
 * may only shrink (as offenders are removed) — they may never grow.
 */
import { readFile, readdir, lstat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/guard-invariants-baseline.json");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".turbo",
  ".eve",
  ".next",
  ".nitro",
  ".output",
  "dist",
  "build",
  "coverage",
  ".vercel",
]);

/** @typedef {{ rule: number; file: string; line?: number; message: string }} Violation */

/**
 * Recursively walk the workspace, yielding regular files.
 * Skips well-known build/dependency directories.
 *
 * @param {string} root
 * @returns {AsyncGenerator<{ absPath: string; relPath: string; stat: import("node:fs").Stats }>}
 */
async function* walkFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const absPath = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      const stat = await lstat(absPath);
      yield { absPath, relPath: relative(REPO_ROOT, absPath), stat };
      continue;
    }
    if (entry.isDirectory()) {
      yield* walkFiles(absPath);
    } else if (entry.isFile()) {
      const stat = await lstat(absPath);
      yield { absPath, relPath: relative(REPO_ROOT, absPath), stat };
    }
  }
}

/**
 * Normalize a relative path to forward slashes so baselines stay
 * portable across Windows and POSIX.
 *
 * @param {string} relPath
 */
function toPosix(relPath) {
  return sep === "/" ? relPath : relPath.split(sep).join("/");
}

/**
 * @param {string} relPath
 */
function isTsLike(relPath) {
  return /\.(ts|tsx|mts|cts)$/.test(relPath) && !relPath.endsWith(".d.ts");
}

/**
 * Walks the working copy once and feeds each TypeScript file through the
 * per-file rule checks. Rule 9 (symlinks) and rule 23 (file-count baseline)
 * also run during the walk.
 *
 * @param {{
 *   rule13: { baseline: Record<string, number>; current: Map<string, number> };
 *   rule15: Violation[];
 *   rule19: { allowlist: Set<string>; current: Set<string>; lines: Map<string, number> };
 *   rule21: { allowlist: Set<string>; violations: Violation[] };
 *   rule23: { baseline: Record<string, number>; current: Map<string, number> };
 *   rule25: { allowlist: Set<string>; new: Map<string, number> };
 *   rule26: Violation[];
 *   rule27: Violation[];
 *   rule28: Violation[];
 *   symlinks: string[];
 * }} state
 */
async function scanRepo(state) {
  for await (const { absPath, relPath, stat } of walkFiles(REPO_ROOT)) {
    const posix = toPosix(relPath);

    if (stat.isSymbolicLink()) {
      state.symlinks.push(posix);
      continue;
    }

    if (!isTsLike(posix)) continue;

    const content = await readFile(absPath, "utf8");
    const lines = content.split(/\r?\n/);

    checkRule13(posix, lines, state.rule13);
    checkRule15(posix, lines, state.rule15);
    checkRule19(posix, lines, state.rule19);
    checkRule21(posix, lines, state.rule21.allowlist, state.rule21.violations);
    checkRule23(posix, lines, state.rule23);
    checkRule25(posix, lines, state.rule25);
    checkRule26(posix, lines, state.rule26);
    checkRule27(posix, lines, state.rule27);
    checkRule28(posix, lines, state.rule28);
  }
}

// ---------- Rule 13: spread-ternary object composition ----------

/** Matches `...(<expr> ? {} : { ... })` or the mirrored form. */
const SPREAD_TERNARY_RE = /\.\.\.\([^()\n]*\?[^()\n]*:\s*\{/;

/**
 * @param {string} posix
 * @param {string[]} lines
 * @param {{ baseline: Record<string, number>; current: Map<string, number> }} state
 */
function checkRule13(posix, lines, state) {
  let count = 0;
  for (const line of lines) {
    if (SPREAD_TERNARY_RE.test(line)) count++;
  }
  if (count > 0) state.current.set(posix, count);
}

// ---------- Rule 15: workflow primitives outside runtime/execution ----------

const WORKFLOW_IMPORT_RE = /from ["']@workflow\b/;

/**
 * @param {string} posix
 */
function isChannelOrHarness(posix) {
  return (
    posix.startsWith("packages/eve/src/channel/") || posix.startsWith("packages/eve/src/harness/")
  );
}

/**
 * @param {string} posix
 * @param {string[]} lines
 * @param {Violation[]} violations
 */
function checkRule15(posix, lines, violations) {
  if (!isChannelOrHarness(posix)) return;
  lines.forEach((line, idx) => {
    if (WORKFLOW_IMPORT_RE.test(line)) {
      violations.push({
        rule: 15,
        file: posix,
        line: idx + 1,
        message: `imports from "@workflow/*". Channel and harness code must stay workflow-agnostic. Move the workflow primitive call into src/runtime/ or src/execution/ and have the channel/harness call a thin runtime helper instead.`,
      });
    }
  });
}

// ---------- Rule 19: AsyncLocalStorage instances ----------

const NEW_ALS_RE = /new\s+AsyncLocalStorage\s*[<(]/;

/**
 * @param {string} posix
 * @param {string[]} lines
 * @param {{ allowlist: Set<string>; current: Set<string>; lines: Map<string, number> }} state
 */
function checkRule19(posix, lines, state) {
  lines.forEach((line, idx) => {
    if (NEW_ALS_RE.test(line)) {
      state.current.add(posix);
      if (!state.lines.has(posix)) state.lines.set(posix, idx + 1);
    }
  });
}

// ---------- Rule 21: authored `name:` (or `id:`) on define* calls ----------

const DEFINE_FNS = [
  "defineAgent",
  "defineEval",
  "defineMcpClientConnection",
  "defineSandbox",
  "defineSchedule",
  "defineSkill",
  "defineTool",
];
/**
 * `defineEval` rejects both `name:` and `id:`. Every other
 * primitive only forbids `name:`.
 */
const FORBIDDEN_KEYS_BY_FN = {
  defineEval: ["name", "id"],
};
const DEFAULT_FORBIDDEN_KEYS = ["name"];
const AUTHORED_PATH_RE = /(^|\/)(apps\/(?:[^/]+\/)?[^/]+\/(agent|evals)|agent|evals)\//;

/**
 * @param {string} posix
 * @param {string[]} lines
 * @param {Set<string>} allowlist
 * @param {Violation[]} violations
 */
function checkRule21(posix, lines, allowlist, violations) {
  if (!AUTHORED_PATH_RE.test(posix)) return;
  if (allowlist.has(posix)) return;

  // Find each `defineXxx(` call and inspect the next ~80 lines for a
  // top-level `name:` (or `id:`, for `defineEval`) property. We bail
  // out at the first balanced `)` to avoid crossing into unrelated calls.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fn = DEFINE_FNS.find((candidate) => line.includes(`${candidate}(`));
    if (fn === undefined) continue;
    const forbiddenKeys = FORBIDDEN_KEYS_BY_FN[fn] ?? DEFAULT_FORBIDDEN_KEYS;
    const forbiddenKeyRe = new RegExp(`^\\s*(?:${forbiddenKeys.join("|")})\\s*:`);
    let depth = 0;
    let started = false;
    for (let j = i; j < Math.min(lines.length, i + 80); j++) {
      const inner = lines[j];
      for (const ch of inner) {
        if (ch === "(" || ch === "{") {
          depth++;
          started = true;
        } else if (ch === ")" || ch === "}") {
          depth--;
        }
      }
      // The forbidden key is only authored identity at the TOP level of the
      // call's object literal — exactly depth 2 (the call paren plus the
      // outer `{`). Deeper occurrences are legitimate nested data.
      if (depth === 2 && forbiddenKeyRe.test(inner)) {
        const matchedKey = forbiddenKeys.find((key) => new RegExp(`^\\s*${key}\\s*:`).test(inner));
        violations.push({
          rule: 21,
          file: posix,
          line: j + 1,
          message: `authored ${fn}({ ${matchedKey ?? forbiddenKeys[0]}: ... }) — derive the identifier from the file path instead. Adding an authored \`${matchedKey ?? forbiddenKeys[0]}\` creates a redundant source of truth that can drift from the path. Remove the field; the framework derives "${
            posix
              .split("/")
              .pop()
              ?.replace(/\.[^.]+$/, "") ?? "<filename>"
          }" automatically.`,
        });
        break;
      }
      if (started && depth <= 0) break;
    }
  }
}

// ---------- Rule 23: `as unknown as T` double casts ----------

const UNKNOWN_CAST_RE = /\bas\s+unknown\s+as\b/;

/**
 * @param {string} posix
 * @param {string[]} lines
 * @param {{ baseline: Record<string, number>; current: Map<string, number> }} state
 */
function checkRule23(posix, lines, state) {
  let count = 0;
  for (const line of lines) {
    if (UNKNOWN_CAST_RE.test(line)) count++;
  }
  if (count > 0) state.current.set(posix, count);
}

// ---------- Rule 25: install/reset/clear runtime session in test bodies ----------

const RUNTIME_SESSION_FN_RE =
  /\b(installBundledCompiledArtifacts|resetBundledCompiledArtifacts|clearProcessDefaultRuntimeSession)\b/;

/**
 * @param {string} posix
 * @param {string[]} lines
 * @param {{ allowlist: Set<string>; new: Map<string, number> }} state
 */
function checkRule25(posix, lines, state) {
  let count = 0;
  for (const line of lines) {
    if (RUNTIME_SESSION_FN_RE.test(line)) count++;
  }
  if (count === 0) return;
  if (state.allowlist.has(posix)) return;
  state.new.set(posix, count);
}

// ---------- Rule 26: `loadContext() as ContextContainer` ----------

const LOAD_CONTEXT_CAST_RE = /loadContext\s*\(\s*\)\s*as\s+ContextContainer\b/;

/**
 * @param {string} posix
 * @param {string[]} lines
 * @param {Violation[]} violations
 */
function checkRule26(posix, lines, violations) {
  lines.forEach((line, idx) => {
    if (LOAD_CONTEXT_CAST_RE.test(line)) {
      violations.push({
        rule: 26,
        file: posix,
        line: idx + 1,
        message: `\`loadContext() as ContextContainer\` cast detected. Pass \`ctx: ContextContainer\` as an explicit parameter instead — the cast hides the runtime invariant behind a TypeScript assertion and creates an implicit AsyncLocalStorage dependency.`,
      });
    }
  });
}

// ---------- Rule 27: hook return shapes have no `state` field ----------

const HOOK_DEFINITIONS_PATH = "packages/eve/src/public/definitions/hook.ts";
/** Matches a `state:` (or `readonly state:`, `state?:`) struct member declaration. */
const HOOK_STATE_FIELD_RE = /^\s*(readonly\s+)?state\??\s*:/;

/**
 * @param {string} posix
 * @param {string[]} lines
 * @param {Violation[]} violations
 */
function checkRule27(posix, lines, violations) {
  if (posix !== HOOK_DEFINITIONS_PATH) return;
  lines.forEach((line, idx) => {
    if (HOOK_STATE_FIELD_RE.test(line)) {
      violations.push({
        rule: 27,
        file: posix,
        line: idx + 1,
        message: `\`state:\` field detected on a hook type definition. Hook return shapes must not carry a parallel state-patch channel — durable state goes through \`ctx.eve\`. Remove the \`state\` field; if the hook truly needs to persist something across turns, write it to a context key via \`ctx.eve.set(...)\` instead.`,
      });
    }
  });
}

// ---------- Rule 28: scaffold layer dependency whitelist ----------

const SCAFFOLD_PREFIX = "packages/eve/src/setup/scaffold/";

// The curated connection and channel catalogs (and any future surface
// overlays) read canonical identity from `@vercel/eve-catalog`, a
// dependency-free data package shared across the scaffolder and docs. It
// carries no runtime, compiler, or provider-SDK weight, so the entire scaffold
// layer may import it. The terminal UI adapters (which carry @clack/core and
// picocolors) live outside the scaffold, in `packages/eve/src/setup/cli/`.
const SCAFFOLD_ALLOWED_PACKAGES = new Set(["@vercel/eve-catalog"]);

const SCAFFOLD_ALLOWED_INTERNAL_IMPORTS = new Set([]);

// Only match top-of-line `import` statements, not strings nested inside
// template literals (e.g. the channel templates embed `from "react"` as
// generated source for the scaffolded project).
const SCAFFOLD_IMPORT_RE = /^\s*import\b[^"']*\sfrom\s+["']([^"']+)["']/;

/**
 * @param {string} posix
 * @param {string[]} lines
 * @param {Violation[]} violations
 */
function checkRule28(posix, lines, violations) {
  if (!posix.startsWith(SCAFFOLD_PREFIX)) return;
  // Test files never ship in the eve tarball, so the bundle-size rationale
  // doesn't apply to them. Allow vitest and other test-only dependencies.
  if (/\.(test|integration\.test|scenario\.test)\.ts$/.test(posix)) return;
  // Channel templates embed full source files inside backtick literals
  // (`from "react"`, etc.). Track template literal depth so we ignore
  // import-like lines that live inside an open backtick block.
  let insideTemplate = false;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!line) continue;
    if (!insideTemplate) {
      const match = line.match(SCAFFOLD_IMPORT_RE);
      if (match) {
        const spec = match[1];
        if (
          spec &&
          !spec.startsWith("node:") &&
          !spec.startsWith(".") &&
          !SCAFFOLD_ALLOWED_PACKAGES.has(spec) &&
          !SCAFFOLD_ALLOWED_INTERNAL_IMPORTS.has(spec)
        ) {
          violations.push({
            rule: 28,
            file: posix,
            line: idx + 1,
            message: `import from "${spec}" not allowed in the packages/eve/src/setup/scaffold source layer. Scaffold modules allow only node:* builtins, relative files, and @vercel/eve-catalog. Keep runtime, compiler, terminal UI, and provider SDK dependencies in their owning package.`,
          });
        }
      }
    }
    // Toggle template state on each unescaped backtick on this line.
    const backticks = (line.match(/(^|[^\\])`/g) ?? []).length;
    if (backticks % 2 === 1) insideTemplate = !insideTemplate;
  }
}

// ---------- Rule 29: changeset package names exist in the workspace ----------

const CHANGESET_DIR = ".changeset";

/**
 * @returns {Promise<Violation[]>}
 */
async function checkRule29ChangesetPackageNames() {
  const workspacePackageNames = await readWorkspacePackageNames();
  const changesetPath = join(REPO_ROOT, CHANGESET_DIR);
  /** @type {Violation[]} */
  const violations = [];

  let entries;
  try {
    entries = await readdir(changesetPath, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return violations;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;

    const relPath = `${CHANGESET_DIR}/${entry.name}`;
    const content = await readFile(join(REPO_ROOT, relPath), "utf8");

    if (!matter.test(content)) {
      violations.push({
        rule: 29,
        file: relPath,
        message:
          "changeset files must start with YAML frontmatter mapping package names to version bump types.",
      });
      continue;
    }

    let data;
    try {
      data = matter(content).data;
    } catch (error) {
      violations.push({
        rule: 29,
        file: relPath,
        message: `changeset frontmatter must be valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      violations.push({
        rule: 29,
        file: relPath,
        message:
          "changeset frontmatter must be an object mapping package names to version bump types.",
      });
      continue;
    }

    const releases = Object.entries(data);
    if (releases.length === 0) {
      violations.push({
        rule: 29,
        file: relPath,
        message: "changeset frontmatter must declare at least one package bump.",
      });
      continue;
    }

    for (const [packageName] of releases) {
      if (workspacePackageNames.has(packageName)) continue;

      violations.push({
        rule: 29,
        file: relPath,
        message: `changeset references package "${packageName}", but no workspace package has that name. Use the exact package.json "name" from the target workspace package; for packages/eve that is "eve".`,
      });
    }
  }

  return violations;
}

// ---------- Rule 30: vendored compiled output has no per-package package.json ----------

const VENDOR_COMPILED_DIR = "packages/eve/scripts/vendor-compiled";

// Matches a write/copy whose path argument is a `join(...)` ending in the
// `package.json` literal — i.e. emitting a package.json into the vendored
// output. Reads in `findPackageJson` use `readFile`, so keying on
// `writeFile`/`copyFile` distinguishes a write from a lookup. `[^)]*` keeps
// the match inside the single `join(...)` argument so an unrelated write
// (e.g. a stub `.d.ts`) followed later by a `package.json` read literal
// can't trigger a false positive.
const COMPILED_PACKAGE_JSON_WRITE_RE =
  /(?:writeFile|copyFile)\s*\(\s*join\([^)]*["']package\.json["']/;

/**
 * Rule 30. Scans the compiled-vendor scripts for any code that writes a
 * `package.json` into a vendored output directory. Such a file shadows eve's
 * `#compiled/*` imports map and silently turns cross-package vendored types
 * into `any` (see the rule 30 note in the header). Scanning the scripts (not
 * the generated artifact) keeps the guard meaningful in the `lint` CI job,
 * which runs before any `build:compiled`.
 *
 * @returns {Promise<Violation[]>}
 */
async function checkRule30VendoredCompiledPackageJson() {
  /** @type {Violation[]} */
  const violations = [];
  const scriptsRoot = join(REPO_ROOT, VENDOR_COMPILED_DIR);

  for await (const { absPath, relPath } of walkFiles(scriptsRoot)) {
    if (!absPath.endsWith(".mjs")) continue;
    const content = await readFile(absPath, "utf8");
    if (COMPILED_PACKAGE_JSON_WRITE_RE.test(content)) {
      violations.push({
        rule: 30,
        file: toPosix(relPath),
        message:
          'vendored-compile pipeline writes a package.json into the compiled output. Remove it: a per-package package.json creates a scope that shadows eve\'s `#compiled/*` imports map, so cross-package vendored type references (e.g. @workflow/core -> @workflow/world -> zod) silently resolve to `any` under skipLibCheck. The bundled ESM inherits `"type": "module"` from eve\'s root package.json, so no per-package file is needed.',
      });
    }
  }

  return violations;
}

// ---------- Rule 31: removed CLI entry points stay removed ----------

const ACTIVE_CLI_REFERENCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|mdx?|json|ya?ml)$/;
const ACTIVE_CLI_REFERENCE_ROOTS = [
  "apps/",
  "docs/",
  "e2e/",
  "packages/eve/src/",
  "packages/eve/test/",
];
const ACTIVE_CLI_REFERENCE_ROOT_FILES = new Set(["AGENTS.md", "CONTRIBUTING.md", "README.md"]);
const REMOVED_CLI_REFERENCES = [
  {
    pattern: /\b(?:npm|pnpm|yarn)\s+create\s+eve(?:@[^\s`"'<>]+)?\b/i,
    replacement: "`eve init <name>`",
  },
  { pattern: /\bcreate-eve\b/i, replacement: "`eve init`" },
  { pattern: /\beve\s+setup\b/i, replacement: "the dedicated current eve command" },
];

/**
 * @param {string} posix
 */
function isActiveCliReferenceFile(posix) {
  if (!ACTIVE_CLI_REFERENCE_EXTENSIONS.test(posix)) return false;
  return (
    ACTIVE_CLI_REFERENCE_ROOT_FILES.has(posix) ||
    ACTIVE_CLI_REFERENCE_ROOTS.some((prefix) => posix.startsWith(prefix))
  );
}

/**
 * @returns {Promise<Violation[]>}
 */
async function checkRule31RemovedCliReferences() {
  /** @type {Violation[]} */
  const violations = [];

  for await (const { absPath, relPath } of walkFiles(REPO_ROOT)) {
    const posix = toPosix(relPath);
    if (!isActiveCliReferenceFile(posix)) continue;
    const lines = (await readFile(absPath, "utf8")).split(/\r?\n/);

    lines.forEach((line, index) => {
      const removed = REMOVED_CLI_REFERENCES.find(({ pattern }) => pattern.test(line));
      if (removed === undefined) return;
      violations.push({
        rule: 31,
        file: posix,
        line: index + 1,
        message: `references a removed eve CLI entry point. Replace it with ${removed.replacement}. Historical mentions belong only in changelogs or changesets.`,
      });
    });
  }

  return violations;
}

/**
 * @returns {Promise<Set<string>>}
 */
async function readWorkspacePackageNames() {
  const packageDirs = await readPnpmWorkspacePackageDirs();
  const packageNames = new Set();

  for (const dir of packageDirs) {
    const packageJson = await readJsonIfExists(join(REPO_ROOT, dir, "package.json"));
    if (packageJson?.name) packageNames.add(packageJson.name);
  }

  return packageNames;
}

/**
 * @returns {Promise<string[]>}
 */
async function readPnpmWorkspacePackageDirs() {
  const workspaceYaml = await readFile(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const includeDirs = new Set();
  const excludeDirs = new Set();

  for (const rawPattern of readPnpmWorkspacePackagePatterns(workspaceYaml)) {
    const excluded = rawPattern.startsWith("!");
    const pattern = excluded ? rawPattern.slice(1) : rawPattern;
    const dirs = await expandWorkspacePackagePattern(pattern);
    const target = excluded ? excludeDirs : includeDirs;

    dirs.forEach((dir) => target.add(dir));
  }

  excludeDirs.forEach((dir) => includeDirs.delete(dir));
  return [...includeDirs].sort();
}

/**
 * @param {string} workspaceYaml
 */
function readPnpmWorkspacePackagePatterns(workspaceYaml) {
  const patterns = [];
  let inPackages = false;

  for (const line of workspaceYaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      continue;
    }

    if (!inPackages) continue;
    const match = line.match(/^\s*-\s+(.+?)\s*$/);
    if (!match) continue;

    patterns.push(stripYamlString(match[1]));
  }

  return patterns;
}

/**
 * @param {string} value
 */
function stripYamlString(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * @param {string} pattern
 * @returns {Promise<string[]>}
 */
async function expandWorkspacePackagePattern(pattern) {
  if (pattern.endsWith("/*")) {
    const root = pattern.slice(0, -2);
    let entries;
    try {
      entries = await readdir(join(REPO_ROOT, root), { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const dirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = `${root}/${entry.name}`;
      if (await readJsonIfExists(join(REPO_ROOT, dir, "package.json"))) dirs.push(dir);
    }
    return dirs;
  }

  if (await readJsonIfExists(join(REPO_ROOT, pattern, "package.json"))) {
    return [pattern];
  }
  return [];
}

/**
 * @param {string} path
 * @returns {Promise<any | undefined>}
 */
async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

// ---------- Reporting helpers ----------

/**
 * @param {Violation[]} violations
 */
function printViolations(violations) {
  for (const v of violations) {
    const where = v.line ? `${v.file}:${v.line}` : v.file;
    process.stderr.write(`  [rule ${v.rule}] ${where}\n    ${v.message}\n`);
  }
}

/**
 * Compares per-file counts against a baseline and returns the offending
 * entries. Files whose count exceeds the baseline (or are absent from it)
 * are reported as additions; baselines never increase.
 *
 * @param {Map<string, number>} current
 * @param {Record<string, number>} baseline
 */
function diffCounts(current, baseline) {
  /** @type {{ file: string; was: number; now: number }[]} */
  const additions = [];
  for (const [file, now] of current) {
    const was = baseline[file] ?? 0;
    if (now > was) additions.push({ file, was, now });
  }
  return additions;
}

// ---------- Entry point ----------

async function main() {
  const baselineRaw = await readFile(BASELINE_PATH, "utf8");
  const baseline = JSON.parse(baselineRaw);

  const state = {
    rule13: { baseline: baseline.rule13_spreadTernaryByFile, current: new Map() },
    rule15: /** @type {Violation[]} */ ([]),
    rule19: {
      allowlist: new Set(baseline.rule19_asyncLocalStorageAllowlist),
      current: new Set(),
      lines: new Map(),
    },
    rule21: {
      allowlist: new Set(baseline.rule21_authoredNameAllowlist ?? []),
      violations: /** @type {Violation[]} */ ([]),
    },
    rule23: { baseline: baseline.rule23_unknownCastByFile, current: new Map() },
    rule25: {
      allowlist: new Set(baseline.rule25_installRuntimeArtifactsAllowlist),
      new: new Map(),
    },
    rule26: /** @type {Violation[]} */ ([]),
    rule27: /** @type {Violation[]} */ ([]),
    rule28: /** @type {Violation[]} */ ([]),
    symlinks: /** @type {string[]} */ ([]),
  };

  await scanRepo(state);

  const violations = /** @type {Violation[]} */ ([]);

  // Rule 9
  for (const file of state.symlinks) {
    violations.push({
      rule: 9,
      file,
      message: `symlink detected. Symlinks are forbidden — they are too unpredictable for a framework to rely on. Replace it with a real file or a small loader that references the canonical location.`,
    });
  }

  // Rule 13
  for (const { file, was, now } of diffCounts(state.rule13.current, state.rule13.baseline)) {
    violations.push({
      rule: 13,
      file,
      message: `${now} spread-ternary object composition${now === 1 ? "" : "s"} detected (baseline: ${was}). Replace \`...(cond ? {} : { key: value })\` with explicit assignment: declare the object, then \`if (cond) obj.key = value;\` (or use the conditional form for the *value* not the spread).`,
    });
  }

  // Rule 15
  violations.push(...state.rule15);

  // Rule 19
  for (const file of state.rule19.current) {
    if (state.rule19.allowlist.has(file)) continue;
    const line = state.rule19.lines.get(file);
    violations.push({
      rule: 19,
      file,
      line,
      message: `\`new AsyncLocalStorage()\` outside the allowlist. All ambient runtime state must flow through the unified EveContext (one AsyncLocalStorage). If you genuinely need a new ALS, justify it in code review and add this file to scripts/guard-invariants-baseline.json under "rule19_asyncLocalStorageAllowlist".`,
    });
  }

  // Rule 21
  violations.push(...state.rule21.violations);

  // Rule 23
  for (const { file, was, now } of diffCounts(state.rule23.current, state.rule23.baseline)) {
    violations.push({
      rule: 23,
      file,
      message: `${now} \`as unknown as T\` cast${now === 1 ? "" : "s"} detected (baseline: ${was}). Avoid double casts through \`unknown\` — they hide real type errors. Try a direct \`as T\`, fix the source type, or thread a properly typed parameter through. To lower the baseline after a cleanup, regenerate the baseline file. The baseline may shrink, never grow.`,
    });
  }

  // Rule 25
  for (const [file, count] of state.rule25.new) {
    violations.push({
      rule: 25,
      file,
      message: `${count} call${count === 1 ? "" : "s"} to install/reset/clear runtime-session helpers. Tests must scope runtime state through createTestRuntime().run(fn) / runAsSession(init, fn) / withRuntimeSession(...). Direct calls mutate the process-default RuntimeSession and leak state across tests.`,
    });
  }

  // Rule 26
  violations.push(...state.rule26);

  // Rule 27
  violations.push(...state.rule27);

  // Rule 28
  violations.push(...state.rule28);

  // Rule 29
  violations.push(...(await checkRule29ChangesetPackageNames()));

  // Rule 30
  violations.push(...(await checkRule30VendoredCompiledPackageJson()));

  // Rule 31
  violations.push(...(await checkRule31RemovedCliReferences()));

  if (violations.length === 0) {
    process.stdout.write("[eve:guard:invariants] ok — all mechanical lints passed.\n");
    return;
  }

  process.stderr.write(
    `[eve:guard:invariants] FAIL: ${violations.length} violation${violations.length === 1 ? "" : "s"} of framework mechanical rules.\n\n`,
  );
  printViolations(violations);
  process.stderr.write(
    `\nEach rule above enforces a framework invariant. The header comment in scripts/guard-invariants.mjs explains the rationale for each rule ID. Fix the violation, or — if the failure is for a baselined rule and you have a deliberate reduction — update scripts/guard-invariants-baseline.json (counts and allowlists may shrink, never grow).\n`,
  );
  process.exit(1);
}

await main();
