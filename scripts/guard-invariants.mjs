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
 *   rule 15 — No `@workflow/*` imports inside `src/channel/**`,
 *             `src/harness/**`, or `src/tracing/**`. Channels, harnesses,
 *             and tracing must stay workflow-agnostic — only
 *             runtime/execution code touches workflow primitives.
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
 *             `@eve/catalog` data package. The scaffold stays free of
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
 *   rule 32 — Every Markdown file under `research/` must have valid YAML
 *             frontmatter with non-empty `issue` and `status` fields plus an
 *             ISO `last_updated` date. Research documents are implementation
 *             plans attached to tracked GitHub work, not an unowned parallel
 *             backlog.
 *   rule 33 — Workflow runtime imports and queue-namespace environment writes
 *             must go through the `src/internal/workflow/runtime.ts` facade and
 *             `queue-namespace.ts`. The generated agent bootstrap installs the
 *             agent-scoped namespace before queue-producing APIs can run.
 *   rule 34 — `phase` stays a runtime-only dependency. No file under the Eve\n *             logo renderer's GPU/runtime boundary (render/, shaders/, or the\n *             offline render harness) may import the `phase` package. This keeps\n *             the mechanical separation between the lifecycle layer and the GPU\n *             renderer enforceable.
 *   rule 35 — No direct `#compiled/gray-matter` imports outside the
 *             `internal/helpers/gray-matter.ts` wrapper. gray-matter's default
 *             engines `eval()` a `---js` frontmatter fence, so every call must
 *             route through `parseFrontmatter`, which is safe by default. A
 *             direct import lets untrusted input reach an evaluating engine.
 *   rule 36 — Extension capability epochs have immutable hashed API metadata
 *             and explicit support history. The current hash must match the
 *             authoring roots, every historical epoch must be supported or
 *             dropped, every retained epoch needs a compiling fixture, and
 *             every public authoring value must belong to a capability.
 *   rule 37 — The instrumentation lifecycle contract stays provider-neutral.
 *             `harness/instrumentation/lifecycle.ts` must not import from
 *             `ai`: its event payloads are eve's published shape, so deriving
 *             them from the model SDK's callback types would make an SDK
 *             upgrade a breaking change for every provider. Map at the bridge.
 *   rule 38 — Workspace build scripts must not launch a nested
 *             `pnpm --filter eve build`. Turbo owns workspace dependency
 *             ordering; nested builds race on eve's clean-and-publish dist
 *             directory and let consumers observe a partial package.
 *   rule 40 — Every shipped wire-version module
 *             (`src/execution/wire/*-wire.vN.ts`) must carry a colocated
 *             `*-wire.vN.test.ts`. The session-inbox registry must also be
 *             contiguous, name every module, and identify its highest version
 *             as current. Version modules are append-only protocol history;
 *             the paired test pins that version's schema/encoder or
 *             migration/fixtures so a version cannot exist as untested code.
 *   rule 41 — Compiled module bindings and source composition are required,
 *             constructed before normalization, and authoritative for backing
 *             and ownership. Programmatic namespaces stay lazy, source ids
 *             remain opaque, and no loader may reconstruct physical paths or
 *             ownership from logical identity.
 *   rule 42 — Public tool primitives cannot import runtime internals, ordinary
 *             framework tool sources can import only public tool modules, and
 *             the deleted `runtime/framework-tools` subsystem cannot return.
 *             Definitions, execution state, and native kernel capabilities
 *             each have one authoritative owner.
 *   rule 43 — The kernel lifecycle table is private to its exhaustive owner,
 *             and native kernel modules cannot fabricate ordinary public
 *             resources. Consumers use the typed lifecycle selectors instead
 *             of building parallel capability registries.
 *
 * Baselines for rules with pre-existing violations live in
 * `guard-invariants-baseline.json`. Counts and allowlists in that file
 * may only shrink (as offenders are removed) — they may never grow.
 */
import { glob, readFile, readdir, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { checkExtensionCapabilityContracts } from "./extension-capability-contracts.mjs";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");
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
 *   rule33: Violation[];
 *   rule35: Violation[];
 *   rule37: Violation[];
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
    checkRule33(posix, lines, state.rule33);
    checkRule35(posix, lines, state.rule35);
    checkRule37(posix, content, state.rule37);
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
    posix.startsWith("packages/eve/src/channel/") ||
    posix.startsWith("packages/eve/src/harness/") ||
    posix.startsWith("packages/eve/src/tracing/")
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
        message: `imports from "@workflow/*". Channel, harness, and tracing code must stay workflow-agnostic. Move the workflow primitive call into src/runtime/ or src/execution/ and have the caller use a thin runtime helper instead.`,
      });
    }
  });
}

// ---------- Rule 33: namespaced Workflow runtime boundary ----------

const RAW_WORKFLOW_RUNTIME_SPECIFIER_RE =
  /["'](?:#compiled\/@workflow\/core\/runtime(?:\.js|\/[^"']+\.js)|@workflow\/core\/runtime(?:\/[^"']+)?|workflow\/(?:api|runtime))["']/;
const WORKFLOW_QUEUE_NAMESPACE_WRITE_RE =
  /process\.env(?:\.WORKFLOW_QUEUE_NAMESPACE|\[\s*(?:WORKFLOW_QUEUE_NAMESPACE_ENV|["']WORKFLOW_QUEUE_NAMESPACE["'])\s*\])\s*=/;
const WORKFLOW_RUNTIME_FACADES = new Set(["packages/eve/src/internal/workflow/runtime.ts"]);
const WORKFLOW_QUEUE_NAMESPACE_MODULE = "packages/eve/src/internal/workflow/queue-namespace.ts";

/**
 * @param {string} posix
 * @param {string[]} lines
 * @param {Violation[]} violations
 */
function checkRule33(posix, lines, violations) {
  lines.forEach((line, idx) => {
    const isTypeOnlyImport = /^\s*(?:import|export)\s+type\b/.test(line);
    const isRuntimeImport =
      /^(?:import|export)\b|^}\s*from\b|\b(?:import|require)\s*\(/.test(line.trimStart()) &&
      RAW_WORKFLOW_RUNTIME_SPECIFIER_RE.test(line);
    if (!WORKFLOW_RUNTIME_FACADES.has(posix) && !isTypeOnlyImport && isRuntimeImport) {
      violations.push({
        rule: 33,
        file: posix,
        line: idx + 1,
        message: `imports the raw Workflow runtime. Import from "#internal/workflow/runtime.js" to preserve eve's single Workflow runtime package identity.`,
      });
    }

    if (posix !== WORKFLOW_QUEUE_NAMESPACE_MODULE && WORKFLOW_QUEUE_NAMESPACE_WRITE_RE.test(line)) {
      violations.push({
        rule: 33,
        file: posix,
        line: idx + 1,
        message: `writes WORKFLOW_QUEUE_NAMESPACE outside the canonical namespace module. Use installEveWorkflowQueueNamespace() so every queue surface derives the same agent-scoped value.`,
      });
    }
  });
}

// ---------- Rule 35: direct gray-matter imports ----------

const GRAY_MATTER_SPECIFIER_RE = /["']#compiled\/gray-matter(?:\/[^"']+)?["']/;
const GRAY_MATTER_FACADE = "packages/eve/src/internal/helpers/gray-matter.ts";

/**
 * @param {string} posix
 * @param {string[]} lines
 * @param {Violation[]} violations
 */
function checkRule35(posix, lines, violations) {
  if (posix === GRAY_MATTER_FACADE) return;
  lines.forEach((line, idx) => {
    const isImport =
      /^(?:import|export)\b|^}\s*from\b|\b(?:import|require)\s*\(/.test(line.trimStart()) &&
      GRAY_MATTER_SPECIFIER_RE.test(line);
    if (isImport) {
      violations.push({
        rule: 35,
        file: posix,
        line: idx + 1,
        message: `imports "#compiled/gray-matter" directly. gray-matter's default engines eval() a \`---js\` frontmatter fence, so parse through parseFrontmatter() from "#internal/helpers/gray-matter.js" instead — it is safe by default and takes an explicit { allowCodeEngines: true } opt-in for trusted input.`,
      });
    }
  });
}

// ---------- Rule 37: instrumentation lifecycle provider boundary ----------

const INSTRUMENTATION_LIFECYCLE_CONTRACT = "packages/eve/src/harness/instrumentation/lifecycle.ts";

/**
 * @param {string} posix
 * @param {string} source
 * @param {Violation[]} violations
 */
function checkRule37(posix, source, violations) {
  if (posix !== INSTRUMENTATION_LIFECYCLE_CONTRACT) return;

  const sourceFile = ts.createSourceFile(
    posix,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const visit = (node) => {
    const specifier = importSpecifier(node);
    if (specifier !== undefined && (specifier.text === "ai" || specifier.text.startsWith("ai/"))) {
      violations.push({
        rule: 37,
        file: posix,
        line: sourceFile.getLineAndCharacterOfPosition(specifier.getStart(sourceFile)).line + 1,
        message: `imports from "ai". Lifecycle event payloads are eve's own shape, so an AI SDK type reaching them makes an SDK upgrade a breaking change for every provider. Add an eve type here and map to it in ai-sdk-hook-bridge.ts.`,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function importSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression !== undefined &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression;
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    return node.argument.literal;
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
    node.arguments[0] !== undefined &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0];
  }
  return undefined;
}

// ---------- Rule 40: wire versions carry colocated contract tests ----------

const WIRE_FAMILY_DIR = "packages/eve/src/execution/wire";
const SESSION_INBOX_WIRE_CONTRACT = `${WIRE_FAMILY_DIR}/session-inbox-contract.ts`;

async function checkRule40WireContracts() {
  /** @type {Violation[]} */
  const violations = [];
  let entries;
  try {
    entries = await readdir(join(REPO_ROOT, WIRE_FAMILY_DIR));
  } catch {
    return violations;
  }

  for (const name of entries) {
    const match = name.match(/^([a-z0-9-]+)-wire\.v(\d+)\.ts$/);
    if (match === null) continue;
    const [, family, version] = match;

    const testName = `${family}-wire.v${version}.test.ts`;
    if (!entries.includes(testName)) {
      violations.push({
        rule: 40,
        file: `${WIRE_FAMILY_DIR}/${name}`,
        line: 1,
        message: `wire family "${family}" version ${version} has no colocated contract test (${testName}). Pin this version's schema/encoder or migration/fixtures before shipping it.`,
      });
    }
  }

  const contractSource = await readFile(join(REPO_ROOT, SESSION_INBOX_WIRE_CONTRACT), "utf8");
  const registryMatch = contractSource.match(
    /SESSION_INBOX_WIRE_VERSIONS\s*=\s*\[([^\]]*)\]\s*as const/,
  );
  const tokens = registryMatch?.[1]
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens === undefined || tokens.length === 0 || tokens.some((token) => !/^\d+$/.test(token))) {
    violations.push({
      rule: 40,
      file: SESSION_INBOX_WIRE_CONTRACT,
      line: 1,
      message:
        "SESSION_INBOX_WIRE_VERSIONS must be an explicit numeric tuple so CI can compare the declared protocol history with shipped version modules.",
    });
    return violations;
  }

  const line = contractSource.slice(0, registryMatch.index).split("\n").length;
  const versions = tokens.map(Number);
  const expectedVersions = versions.map((_, index) => index + 1);
  if (JSON.stringify(versions) !== JSON.stringify(expectedVersions)) {
    violations.push({
      rule: 40,
      file: SESSION_INBOX_WIRE_CONTRACT,
      line,
      message: `SESSION_INBOX_WIRE_VERSIONS must be contiguous and ascending from 1; found [${versions.join(", ")}]. Add new versions without renumbering or removing protocol history.`,
    });
  }

  const shippedVersions = entries
    .flatMap((name) => {
      const match = name.match(/^session-inbox-wire\.v(\d+)\.ts$/);
      return match === null ? [] : [Number(match[1])];
    })
    .sort((left, right) => left - right);
  const registeredModules = [0, ...versions];
  if (JSON.stringify(shippedVersions) !== JSON.stringify(registeredModules)) {
    violations.push({
      rule: 40,
      file: SESSION_INBOX_WIRE_CONTRACT,
      line,
      message: `session-inbox wire modules [${shippedVersions.join(", ")}] must exactly match legacy v0 plus registered versions [${registeredModules.join(", ")}].`,
    });
  }

  return violations;
}

// ---------- Rule 41: compiled binding authority ----------

const COMPILED_MANIFEST_CONTRACT = "packages/eve/src/compiler/manifest.ts";
const COMPILED_MANIFEST_VALIDATION = "packages/eve/src/compiler/compiled-manifest-validation.ts";
const COMPILED_BINDING_CONTRACT = "packages/eve/src/compiler/module-binding.ts";
const COMPILED_BINDING_SEMANTICS = "packages/eve/src/compiler/module-binding-semantics.ts";
const COMPILED_GRAPH_SEMANTICS = "packages/eve/src/compiler/compiled-agent-graph-semantics.ts";
const SOURCE_COMPOSITION_SEMANTICS = "packages/eve/src/compiler/source-composition-semantics.ts";
const AUTHORED_MODULE_MAP_LOADER = "packages/eve/src/internal/authored-module-map-loader.ts";
const MODULE_BACKED_NORMALIZER_GLOB = "packages/eve/src/compiler/normalize-*.ts";
const NORMALIZE_SANDBOX = "packages/eve/src/compiler/normalize-sandbox.ts";
const PROGRAMMATIC_AGENT_SOURCE = "packages/eve/src/compiler/programmatic-agent-source.ts";
const AGENT_SOURCE_REGISTRY = "packages/eve/src/compiler/agent-source-registry.ts";
const FRAMEWORK_SOURCE_REGISTRY = "packages/eve/src/framework-sources/registry.ts";
const FRAMEWORK_SOURCE_REGISTRY_STATIC_IMPORTS = new Set([
  "#compiler/agent-source-registry.js",
  "#compiler/programmatic-agent-source.js",
  "#framework-sources/revision.js",
  "./constants.js",
]);
const EFFECTIVE_AGENT_SOURCE_GRAPH = "packages/eve/src/compiler/effective-agent-source-graph.ts";
const SOURCE_CANDIDATE_PATH_CONSTRUCTION_FUNCTIONS = new Map([
  [EFFECTIVE_AGENT_SOURCE_GRAPH, new Set(["createFilesystemCandidate"])],
  ["packages/eve/src/compiler/extension-source-candidates.ts", new Set(["physicalSourcePath"])],
]);
const OPAQUE_SOURCE_ID_RUNTIME_ROOTS = ["packages/eve/src/internal", "packages/eve/src/runtime"];
const COMPILED_ARTIFACT_FACTORIES = new Set([
  "createCompiledAgentResources",
  "createCompiledAgentNodeManifest",
  "createCompiledAgentManifest",
]);

async function checkRule41CompiledBindingAuthority() {
  /** @type {Violation[]} */
  const violations = [];
  const manifestSource = await readFile(join(REPO_ROOT, COMPILED_MANIFEST_CONTRACT), "utf8");
  const manifestFile = ts.createSourceFile(
    COMPILED_MANIFEST_CONTRACT,
    manifestSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let resourcesInput;
  let resourcesOptions;
  let nodeInput;
  let rootInput;

  const visitManifest = (node) => {
    if (ts.isInterfaceDeclaration(node)) {
      if (node.name.text === "CreateCompiledAgentResourcesInput") resourcesInput = node;
      if (node.name.text === "CreateCompiledAgentResourcesOptions") resourcesOptions = node;
      if (node.name.text === "CreateCompiledAgentManifestInput") rootInput = node;
    }
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === "CreateCompiledAgentNodeManifestInput"
    ) {
      nodeInput = node;
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      COMPILED_ARTIFACT_FACTORIES.has(node.name.text) &&
      node.body !== undefined
    ) {
      const factoryName = node.name.text;
      if (factoryName !== "createCompiledAgentManifest") {
        const optionsParameter = node.parameters[1];
        if (
          optionsParameter === undefined ||
          optionsParameter.questionToken !== undefined ||
          optionsParameter.initializer !== undefined
        ) {
          violations.push({
            rule: 41,
            file: COMPILED_MANIFEST_CONTRACT,
            line: manifestFile.getLineAndCharacterOfPosition(node.getStart(manifestFile)).line + 1,
            message: `${factoryName} must require explicit node identity and root scope options so relational validation cannot guess a compiled node's authority.`,
          });
        }
      }
      const visitFactory = (child) => {
        if (
          ts.isCallExpression(child) &&
          ts.isIdentifier(child.expression) &&
          child.expression.text === "createFilesystemModuleBindings"
        ) {
          violations.push({
            rule: 41,
            file: COMPILED_MANIFEST_CONTRACT,
            line: manifestFile.getLineAndCharacterOfPosition(child.getStart(manifestFile)).line + 1,
            message: `${factoryName} reconstructs bindings. Compiled artifact constructors must receive and validate the complete binding table supplied by the compiler phase that owns source discovery.`,
          });
        }
        ts.forEachChild(child, visitFactory);
      };
      ts.forEachChild(node.body, visitFactory);
    }
    ts.forEachChild(node, visitManifest);
  };
  visitManifest(manifestFile);

  const bindingsMember = resourcesInput?.members.find(
    (member) =>
      ts.isPropertySignature(member) &&
      member.name !== undefined &&
      member.name.getText(manifestFile) === "bindings",
  );
  if (
    bindingsMember === undefined ||
    !ts.isPropertySignature(bindingsMember) ||
    bindingsMember.questionToken !== undefined
  ) {
    violations.push({
      rule: 41,
      file: COMPILED_MANIFEST_CONTRACT,
      message:
        "CreateCompiledAgentResourcesInput.bindings must be a required property so no compiled artifact constructor can infer or omit physical/programmatic backing.",
    });
  }

  const compositionMember = resourcesInput?.members.find(
    (member) =>
      ts.isPropertySignature(member) &&
      member.name !== undefined &&
      member.name.getText(manifestFile) === "sourceComposition",
  );
  if (
    compositionMember === undefined ||
    !ts.isPropertySignature(compositionMember) ||
    compositionMember.questionToken !== undefined
  ) {
    violations.push({
      rule: 41,
      file: COMPILED_MANIFEST_CONTRACT,
      message:
        "CreateCompiledAgentResourcesInput.sourceComposition must be required. Every compiled node must persist the exact selected, shadowed, and disabled source graph.",
    });
  }

  if (
    nodeInput === undefined ||
    !nodeInput.getText(manifestFile).includes("CreateCompiledAgentResourcesInput")
  ) {
    violations.push({
      rule: 41,
      file: COMPILED_MANIFEST_CONTRACT,
      message:
        "CreateCompiledAgentNodeManifestInput must inherit the required compiled-resource binding contract.",
    });
  }
  if (
    rootInput === undefined ||
    !rootInput.heritageClauses?.some((clause) =>
      clause.types.some(
        (type) => type.expression.getText(manifestFile) === "CreateCompiledAgentResourcesInput",
      ),
    )
  ) {
    violations.push({
      rule: 41,
      file: COMPILED_MANIFEST_CONTRACT,
      message:
        "CreateCompiledAgentManifestInput must inherit the required compiled-resource binding contract.",
    });
  }

  for (const optionName of ["isRoot", "nodeId"]) {
    const optionMember = resourcesOptions?.members.find(
      (member) =>
        ts.isPropertySignature(member) &&
        member.name !== undefined &&
        member.name.getText(manifestFile) === optionName,
    );
    if (
      optionMember === undefined ||
      !ts.isPropertySignature(optionMember) ||
      optionMember.questionToken !== undefined
    ) {
      violations.push({
        rule: 41,
        file: COMPILED_MANIFEST_CONTRACT,
        message: `CreateCompiledAgentResourcesOptions.${optionName} must be required so every compiled node validates workspace identity, child scope, and provenance against explicit authority.`,
      });
    }
  }

  const bindingSemanticsSource = await readFile(
    join(REPO_ROOT, COMPILED_BINDING_SEMANTICS),
    "utf8",
  );
  const bindingSemanticsFile = ts.createSourceFile(
    COMPILED_BINDING_SEMANTICS,
    bindingSemanticsSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const semanticScopeCheck = bindingSemanticsFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "assertCompiledSourceBackingSemantics",
  );
  const semanticScopeText = semanticScopeCheck?.getText(bindingSemanticsFile) ?? "";
  if (
    !semanticScopeText.includes('owner.kind === "framework"') ||
    !semanticScopeText.includes('owner.kind === "application"') ||
    !semanticScopeText.includes('backing.kind !== "filesystem"') ||
    !semanticScopeText.includes('backing.kind !== "programmatic"') ||
    !semanticScopeText.includes("extensionScope") ||
    !semanticScopeText.includes("scope === undefined") ||
    !semanticScopeText.includes("packageStateNamespace") ||
    !semanticScopeText.includes("isPathInside")
  ) {
    violations.push({
      rule: 41,
      file: COMPILED_BINDING_SEMANTICS,
      message:
        "The semantic binding validator must enforce the closed owner/backing relation, exact extension namespace, and extension path containment before hydration.",
    });
  }

  const semanticValidatorConsumers = new Map([
    [COMPILED_BINDING_CONTRACT, "assertTotalModuleBindings"],
    [COMPILED_GRAPH_SEMANTICS, "assertCompiledRemoteAgentNodeSemantics"],
  ]);
  for (const [consumer, consumerFunctionName] of semanticValidatorConsumers) {
    const source = await readFile(join(REPO_ROOT, consumer), "utf8");
    const sourceFile = ts.createSourceFile(
      consumer,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let callsSemanticValidator = false;
    const visitSemanticValidatorCalls = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "assertCompiledModuleBindingSemantics"
      ) {
        callsSemanticValidator = true;
      }
      ts.forEachChild(node, visitSemanticValidatorCalls);
    };
    const consumerFunction = sourceFile.statements.find(
      (statement) =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === consumerFunctionName,
    );
    if (consumerFunction?.body !== undefined) {
      visitSemanticValidatorCalls(consumerFunction.body);
    }
    if (!callsSemanticValidator) {
      violations.push({
        rule: 41,
        file: consumer,
        message: `${consumerFunctionName} must call the shared semantic validator so root, local, and remote nodes enforce identical owner-specific invariants.`,
      });
    }
  }

  const descriptorSemanticsSource = await readFile(
    join(REPO_ROOT, SOURCE_COMPOSITION_SEMANTICS),
    "utf8",
  );
  if (
    !descriptorSemanticsSource.includes('descriptor.layer === "framework-default"') ||
    !descriptorSemanticsSource.includes('descriptor.layer === "extension-package"') ||
    !descriptorSemanticsSource.includes("assertCompiledSourceBackingSemantics")
  ) {
    violations.push({
      rule: 41,
      file: SOURCE_COMPOSITION_SEMANTICS,
      message:
        "Retained source descriptors must validate their layer-to-owner relationship and owner-specific backing semantics.",
    });
  }

  const descriptorValidatorConsumers = new Map([
    [COMPILED_BINDING_CONTRACT, "assertTotalModuleBindings"],
    [COMPILED_GRAPH_SEMANTICS, "assertCompiledRemoteAgentNodeSemantics"],
  ]);
  for (const [consumer, consumerFunctionName] of descriptorValidatorConsumers) {
    const source = await readFile(join(REPO_ROOT, consumer), "utf8");
    const sourceFile = ts.createSourceFile(
      consumer,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const consumerFunction = sourceFile.statements.find(
      (statement) =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === consumerFunctionName,
    );
    const functionText = consumerFunction?.getText(sourceFile) ?? "";
    if (!functionText.includes("assertAgentSourceDescriptorSemantics")) {
      violations.push({
        rule: 41,
        file: consumer,
        message: `${consumerFunctionName} must validate every retained descriptor through the shared source-composition semantic boundary.`,
      });
    }
  }

  const loaderSource = await readFile(join(REPO_ROOT, AUTHORED_MODULE_MAP_LOADER), "utf8");
  const loaderFile = ts.createSourceFile(
    AUTHORED_MODULE_MAP_LOADER,
    loaderSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const visitLoader = (node) => {
    const decodesExtensionPrefix =
      (ts.isRegularExpressionLiteral(node) && node.text.includes("^ext:")) ||
      (ts.isIdentifier(node) && node.text === "extensionNamespaceForSourceId") ||
      (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["match", "split"].includes(node.expression.name.text) &&
        node.expression.expression.getText(loaderFile).includes("sourceId"));
    if (decodesExtensionPrefix) {
      violations.push({
        rule: 41,
        file: AUTHORED_MODULE_MAP_LOADER,
        line: loaderFile.getLineAndCharacterOfPosition(node.getStart(loaderFile)).line + 1,
        message:
          "decodes extension ownership from sourceId. Source ids are opaque; hydration must read extension scope only from the compiled binding backing.",
      });
    }
    ts.forEachChild(node, visitLoader);
  };
  visitLoader(loaderFile);

  for await (const normalizerPath of glob(MODULE_BACKED_NORMALIZER_GLOB, { cwd: REPO_ROOT })) {
    if (normalizerPath.includes(".test.")) continue;
    const source = await readFile(join(REPO_ROOT, normalizerPath), "utf8");
    if (!source.includes("loadModuleBackedDefinition")) continue;
    const sourceFile = ts.createSourceFile(
      normalizerPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const issue of findRule41OptionalModuleBindingIssues(sourceFile)) {
      violations.push({
        rule: 41,
        file: normalizerPath,
        line: sourceFile.getLineAndCharacterOfPosition(issue.node.getStart(sourceFile)).line + 1,
        message:
          "module-backed normalizer options accept a missing binding. Selected module definitions must require their binding in the type boundary before they can execute.",
      });
    }
  }
  const sandboxSource = await readFile(join(REPO_ROOT, NORMALIZE_SANDBOX), "utf8");
  if (/readFile\s*\(\s*(?:join|resolve)\s*\(/.test(sandboxSource)) {
    violations.push({
      rule: 41,
      file: NORMALIZE_SANDBOX,
      message:
        "hashes a sandbox by reconstructing a path. Sandbox hashing must read the selected filesystem binding backing.",
    });
  }

  const effectiveGraphSource = await readFile(
    join(REPO_ROOT, EFFECTIVE_AGENT_SOURCE_GRAPH),
    "utf8",
  );
  const effectiveGraphFile = ts.createSourceFile(
    EFFECTIVE_AGENT_SOURCE_GRAPH,
    effectiveGraphSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const finalizeDisabledSources = effectiveGraphFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "finalizeDisabledSources",
  );
  let projectsDisabledSourcesFromComposedEntries = false;
  if (finalizeDisabledSources !== undefined) {
    const visitFinalizeDisabledSources = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "createAgentSourceComposition" &&
        node.arguments[0]?.getText(effectiveGraphFile) === "graph.entries"
      ) {
        projectsDisabledSourcesFromComposedEntries = true;
      }
      ts.forEachChild(node, visitFinalizeDisabledSources);
    };
    visitFinalizeDisabledSources(finalizeDisabledSources);
  }
  if (!projectsDisabledSourcesFromComposedEntries) {
    violations.push({
      rule: 41,
      file: EFFECTIVE_AGENT_SOURCE_GRAPH,
      message:
        "finalizeDisabledSources must project from the retained composed entries. Reconstructing candidates from winners or serialized composition loses original candidate provenance.",
    });
  }

  const programmaticSource = await readFile(join(REPO_ROOT, PROGRAMMATIC_AGENT_SOURCE), "utf8");
  if (
    !programmaticSource.includes("readonly loadNamespace:") ||
    /readonly namespace\s*:/.test(programmaticSource)
  ) {
    violations.push({
      rule: 41,
      file: PROGRAMMATIC_AGENT_SOURCE,
      message:
        "programmatic modules must expose loadNamespace() metadata only. Eager namespace values execute unselected framework definitions.",
    });
  }
  const registrySource = await readFile(join(REPO_ROOT, AGENT_SOURCE_REGISTRY), "utf8");
  if (/\.namespace\b/.test(registrySource) || !registrySource.includes("loadModule(")) {
    violations.push({
      rule: 41,
      file: AGENT_SOURCE_REGISTRY,
      message:
        "the programmatic registry must lazily load selected namespaces through loadModule(); eager namespace access is forbidden.",
    });
  }

  let frameworkRegistrySource;
  try {
    frameworkRegistrySource = await readFile(join(REPO_ROOT, FRAMEWORK_SOURCE_REGISTRY), "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !Object.hasOwn(error, "code") || error.code !== "ENOENT") {
      throw error;
    }
  }
  if (frameworkRegistrySource !== undefined) {
    const frameworkRegistryFile = ts.createSourceFile(
      FRAMEWORK_SOURCE_REGISTRY,
      frameworkRegistrySource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const issue of findRule41FrameworkRegistryImportIssues(frameworkRegistryFile)) {
      violations.push({
        rule: 41,
        file: FRAMEWORK_SOURCE_REGISTRY,
        line: frameworkRegistryFile.getLineAndCharacterOfPosition(issue.node.getStart()).line + 1,
        message: `statically imports "${issue.specifier}". Framework definition modules must remain behind literal dynamic-import loadNamespace() functions so unselected defaults never execute. Only the registry contracts, framework constants, and framework revision metadata may be statically imported here.`,
      });
    }

    let loaderCount = 0;
    const visitFrameworkRegistry = (node) => {
      const isLoaderProperty =
        ts.isPropertyAssignment(node) &&
        ((ts.isIdentifier(node.name) && node.name.text === "loadNamespace") ||
          (ts.isStringLiteral(node.name) && node.name.text === "loadNamespace"));
      if (isLoaderProperty) {
        loaderCount++;
        const importCalls = [];
        const findImports = (child) => {
          if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword) {
            importCalls.push(child);
          }
          ts.forEachChild(child, findImports);
        };
        findImports(node.initializer);
        const literalLoader =
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
          importCalls.length === 1 &&
          importCalls[0].arguments.length === 1 &&
          ts.isStringLiteral(importCalls[0].arguments[0]);
        if (!literalLoader) {
          violations.push({
            rule: 41,
            file: FRAMEWORK_SOURCE_REGISTRY,
            line: frameworkRegistryFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            message:
              "each framework module registration must define loadNamespace as a function containing exactly one dynamic import with a string-literal specifier.",
          });
        }
      }
      ts.forEachChild(node, visitFrameworkRegistry);
    };
    visitFrameworkRegistry(frameworkRegistryFile);
    if (loaderCount === 0) {
      violations.push({
        rule: 41,
        file: FRAMEWORK_SOURCE_REGISTRY,
        message:
          "the framework source registry must register definition modules through literal dynamic-import loadNamespace() functions.",
      });
    }
  }

  const compilerRoot = join(REPO_ROOT, "packages/eve/src/compiler");
  for await (const { absPath, relPath } of walkFiles(compilerRoot)) {
    const posix = toPosix(relPath);
    if (!isTsLike(posix) || /\.(test|integration\.test|scenario\.test)\.ts$/.test(posix)) continue;
    const source = await readFile(absPath, "utf8");
    if (source.includes("createFilesystemModuleBindings")) {
      violations.push({
        rule: 41,
        file: posix,
        message:
          "uses post-normalization binding reconstruction. Bindings must be emitted directly from selected source candidates before normalization.",
      });
    }

    const sourceFile = ts.createSourceFile(
      posix,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const allowedPathConstructionFunctions =
      SOURCE_CANDIDATE_PATH_CONSTRUCTION_FUNCTIONS.get(posix) ?? new Set();
    const allowedPathConstructionRanges = sourceFile.statements.flatMap((statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      allowedPathConstructionFunctions.has(statement.name.text)
        ? [{ end: statement.end, start: statement.getStart(sourceFile) }]
        : [],
    );
    const visitPathConstruction = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : undefined;
        if (
          (callee === "join" || callee === "resolve") &&
          node.arguments.some((argument) => /\blogicalPath\b/.test(argument.getText(sourceFile))) &&
          !allowedPathConstructionRanges.some(
            (range) => range.start <= node.getStart(sourceFile) && node.end <= range.end,
          )
        ) {
          violations.push({
            rule: 41,
            file: posix,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            message:
              "reconstructs a physical module path from logicalPath after candidate construction. Load, hash, and identify selected modules only through their compiled binding backing.",
          });
        }
      }
      ts.forEachChild(node, visitPathConstruction);
    };
    visitPathConstruction(sourceFile);
  }

  for (const runtimeRoot of OPAQUE_SOURCE_ID_RUNTIME_ROOTS) {
    for await (const { absPath, relPath } of walkFiles(join(REPO_ROOT, runtimeRoot))) {
      const posix = toPosix(relPath);
      if (!isTsLike(posix) || /\.(?:integration\.|scenario\.)?test\.[mc]?tsx?$/.test(posix)) {
        continue;
      }
      const source = await readFile(absPath, "utf8");
      const sourceFile = ts.createSourceFile(
        posix,
        source,
        ts.ScriptTarget.Latest,
        true,
        posix.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visitSourceIds = (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ["includes", "match", "slice", "split", "startsWith", "substr", "substring"].includes(
            node.expression.name.text,
          ) &&
          /sourceId/i.test(node.expression.expression.getText(sourceFile))
        ) {
          violations.push({
            rule: 41,
            file: posix,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            message:
              "parses an opaque sourceId. Runtime ownership and backing decisions must use the compiled binding or selected source descriptor.",
          });
        }
        ts.forEachChild(node, visitSourceIds);
      };
      visitSourceIds(sourceFile);
    }
  }

  const sourceRoot = join(REPO_ROOT, "packages/eve/src");
  for await (const { absPath, relPath, stat } of walkFiles(sourceRoot)) {
    const posix = toPosix(relPath);
    if (
      !stat.isFile() ||
      !isTsLike(posix) ||
      /\.(?:integration\.|scenario\.)?test\.[mc]?tsx?$/.test(posix)
    ) {
      continue;
    }
    const source = await readFile(absPath, "utf8");
    const sourceFile = ts.createSourceFile(
      posix,
      source,
      ts.ScriptTarget.Latest,
      true,
      posix.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const issue of findRule41ManifestParseIssues(sourceFile)) {
      if (issue.kind === "direct-parse" && posix === COMPILED_MANIFEST_VALIDATION) continue;
      violations.push({
        rule: 41,
        file: posix,
        line: sourceFile.getLineAndCharacterOfPosition(issue.node.getStart(sourceFile)).line + 1,
        message:
          issue.kind === "unvalidated-safe-parse"
            ? "schema-parses a compiled manifest without invoking assertSerializedCompiledAgentManifestSemantics before use. Serialized manifests must pass both structural and relational validation."
            : issue.kind === "unsafe-cast"
              ? "casts JSON directly to CompiledAgentManifest. Parse serialized manifests through parseCompiledAgentManifest so structural and relational validation cannot be skipped."
              : "calls compiledAgentManifestSchema.parse outside the canonical validation helper. Use parseCompiledAgentManifest so relational validation cannot be skipped.",
      });
    }
  }

  return violations;
}

export function findRule41ManifestParseIssues(sourceFile) {
  const issues = [];
  const schemaNames = new Set();
  const semanticValidatorNames = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const bindings = statement.importClause.namedBindings;
    if (bindings === undefined || ts.isNamespaceImport(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === "compiledAgentManifestSchema") schemaNames.add(element.name.text);
      if (imported === "assertSerializedCompiledAgentManifestSemantics") {
        semanticValidatorNames.add(element.name.text);
      }
    }
  }

  const safeParses = [];
  const validatedResultsByScope = new Map();
  visitEveryNode(sourceFile, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      semanticValidatorNames.has(node.expression.text)
    ) {
      const argument = node.arguments[0];
      if (
        argument !== undefined &&
        ts.isPropertyAccessExpression(argument) &&
        argument.name.text === "data" &&
        ts.isIdentifier(argument.expression)
      ) {
        const scope = findRule41ValidationScope(node, sourceFile);
        const names = validatedResultsByScope.get(scope) ?? new Set();
        names.add(argument.expression.text);
        validatedResultsByScope.set(scope, names);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      schemaNames.has(node.expression.expression.text)
    ) {
      if (node.expression.name.text === "parse") {
        issues.push({ kind: "direct-parse", node });
      } else if (node.expression.name.text === "safeParse") {
        const declaration = node.parent;
        safeParses.push({
          name:
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer === node &&
            ts.isIdentifier(declaration.name)
              ? declaration.name.text
              : undefined,
          node,
          scope: findRule41ValidationScope(node, sourceFile),
        });
      }
    }
    if (
      ts.isAsExpression(node) &&
      /\bCompiledAgentManifest\b/u.test(node.type.getText(sourceFile)) &&
      /\bJSON\.parse\s*\(/u.test(node.expression.getText(sourceFile))
    ) {
      issues.push({ kind: "unsafe-cast", node });
    }
  });
  for (const safeParse of safeParses) {
    if (
      safeParse.name === undefined ||
      !validatedResultsByScope.get(safeParse.scope)?.has(safeParse.name)
    ) {
      issues.push({ kind: "unvalidated-safe-parse", node: safeParse.node });
    }
  }
  return issues;
}

function findRule41ValidationScope(node, sourceFile) {
  let current = node.parent;
  while (current !== undefined && current !== sourceFile) {
    if (
      ts.isArrowFunction(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return sourceFile;
}

export function analyzeRule41ManifestParseFixture(sourceText) {
  return findRule41ManifestParseIssues(
    ts.createSourceFile("fixture.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  ).map((issue) => issue.kind);
}

function findRule41OptionalModuleBindingIssues(sourceFile) {
  const issues = [];
  visitEveryNode(sourceFile, (node) => {
    if (
      ts.isPropertySignature(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "binding" &&
      (node.questionToken !== undefined ||
        /\bundefined\b/u.test(node.type?.getText(sourceFile) ?? ""))
    ) {
      issues.push({ kind: "optional-binding", node });
      return;
    }
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === "Partial" &&
      node.typeArguments?.some((argument) =>
        /\bModuleBackedDefinitionLoadOptions\b/u.test(argument.getText(sourceFile)),
      )
    ) {
      issues.push({ kind: "partial-options", node });
    }
  });
  return issues;
}

export function analyzeRule41ModuleNormalizerBindingFixture(sourceText) {
  return findRule41OptionalModuleBindingIssues(
    ts.createSourceFile("fixture.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  ).map((issue) => issue.kind);
}

function findRule41FrameworkRegistryImportIssues(sourceFile) {
  const issues = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (!FRAMEWORK_SOURCE_REGISTRY_STATIC_IMPORTS.has(specifier)) {
      issues.push({ node: statement, specifier });
    }
  }
  return issues;
}

export function analyzeRule41FrameworkRegistryImportsFixture(sourceText) {
  return findRule41FrameworkRegistryImportIssues(
    ts.createSourceFile("fixture.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  ).map((issue) => issue.specifier);
}

// ---------- Rule 42: primitive ownership boundaries ----------

const IMPORT_SPECIFIER_RE = /(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/g;
const PUBLIC_INTERNAL_IMPORT_RE =
  /(?:from\s+|import\s*(?:\(\s*)?)["'](?:#(?:kernel|runtime)\/|(?:\.\.\/)+(?:kernel|runtime)\/)/;

async function checkRule42PrimitiveOwnership() {
  const violations = [];
  const sourceRoot = join(REPO_ROOT, "packages/eve/src");

  for await (const { absPath, relPath, stat } of walkFiles(sourceRoot)) {
    if (!stat.isFile() || !isTsLike(relPath)) continue;
    const posix = toPosix(relPath);
    const content = await readFile(absPath, "utf8");

    if (posix.includes("/runtime/framework-tools/")) {
      violations.push({
        rule: 42,
        file: posix,
        message:
          "the mixed runtime/framework-tools subsystem was deleted. Put public definitions and schemas under public/tools, execution state under execution, and native capabilities under kernel.",
      });
    }

    if (posix.startsWith("packages/eve/src/public/") && PUBLIC_INTERNAL_IMPORT_RE.test(content)) {
      violations.push({
        rule: 42,
        file: posix,
        message:
          "public modules must not import runtime or kernel internals. Move the implementation behind an execution-owned module or the definition into its public primitive owner.",
      });
    }

    if (!posix.startsWith("packages/eve/src/framework-sources/tools/")) continue;
    for (const match of content.matchAll(IMPORT_SPECIFIER_RE)) {
      const specifier = match[1];
      if (
        specifier.startsWith("#public/tools/") &&
        specifier !== "#public/tools/defaults.js" &&
        specifier !== "#public/tools/index.js"
      ) {
        continue;
      }
      violations.push({
        rule: 42,
        file: posix,
        message: `ordinary framework tool sources must import their owning public primitive directly; found \`${specifier}\`.`,
      });
    }
  }

  return violations;
}

// ---------- Rule 43: exhaustive kernel capability lifecycle ----------

const RAW_KERNEL_INVENTORY_NAMES = new Set([
  "KERNEL_CAPABILITIES",
  "KERNEL_CAPABILITY_NAMES",
  "getExecutableKernelCapabilityStrategy",
  "getKernelCapabilityStrategy",
]);
const NATIVE_ORDINARY_RESOURCE_CREATORS = new Set([
  "defineAgent",
  "defineChannel",
  "defineConnection",
  "defineDynamic",
  "defineEval",
  "defineHook",
  "defineMcpClientConnection",
  "defineSandbox",
  "defineSchedule",
  "defineSkill",
  "defineTool",
]);
const REGISTRY_BINDING_NAME_RE =
  /(?:kernel|capabilit|registr|inventor|dispatch|materializ|strateg|selector|provider.*(?:recover|tool)|upstream.*tool)/iu;

async function checkRule43KernelCapabilityLifecycle() {
  const violations = [];
  const sourceRoot = join(REPO_ROOT, "packages/eve/src");
  const ownerPath = join(sourceRoot, "kernel/capabilities.ts");
  const ownerContent = await readFile(ownerPath, "utf8");
  const ownerSourceFile = ts.createSourceFile(
    ownerPath,
    ownerContent,
    ts.ScriptTarget.Latest,
    true,
  );
  const kernelCapabilityNames = readKernelCapabilityNamesFromOwner(ownerSourceFile);
  if (kernelCapabilityNames.size === 0) {
    return [
      {
        rule: 43,
        file: "packages/eve/src/kernel/capabilities.ts",
        message:
          "the exhaustive kernel capability name tuple could not be read; keep KERNEL_CAPABILITY_NAMES as a literal tuple owned by this module.",
      },
    ];
  }

  for await (const { absPath, relPath, stat } of walkFiles(sourceRoot)) {
    if (!stat.isFile() || !isTsLike(relPath)) continue;
    const posix = toPosix(relPath);
    if (posix.endsWith(".test.ts") || posix.includes(".integration.test.")) continue;
    const content = await readFile(absPath, "utf8");
    const sourceFile = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, true);

    const ownsInventory = posix === "packages/eve/src/kernel/capabilities.ts";
    const ownsExecutablePipelines = posix === "packages/eve/src/kernel/executable-capabilities.ts";
    const validatesSerializedNames = posix === "packages/eve/src/compiler/manifest.ts";
    const sourceIssues = findRule43SourceIssues(sourceFile, kernelCapabilityNames, {
      checksLiteralBranches:
        /packages\/eve\/src\/(?:compiler|execution|harness|kernel)\//u.test(posix) &&
        !ownsInventory &&
        posix !== "packages/eve/src/harness/workflow-tool-description.ts",
      checksNativeOwnership: posix.startsWith("packages/eve/src/kernel/") && !ownsInventory,
      checksRawInventory: !ownsInventory,
      checksRegistries: !ownsInventory,
      allowedRawInventoryNames: new Set([
        ...(ownsExecutablePipelines ? ["getExecutableKernelCapabilityStrategy"] : []),
        ...(validatesSerializedNames ? ["KERNEL_CAPABILITY_NAMES"] : []),
      ]),
    });
    const rawInventory = sourceIssues.find((issue) => issue.kind === "raw-inventory");
    if (rawInventory !== undefined) {
      violations.push({
        rule: 43,
        file: posix,
        line:
          sourceFile.getLineAndCharacterOfPosition(rawInventory.node.getStart(sourceFile)).line + 1,
        message:
          "raw kernel capability inventories and strategy accessors are private to their owning kernel modules. Use a typed preparation, advertisement, materialization, dispatch, prompt, or inspection selector instead of bypassing the lifecycle pipelines.",
      });
    }

    const adHocRegistry = sourceIssues.find((issue) => issue.kind === "ad-hoc-registry");
    if (adHocRegistry !== undefined) {
      violations.push({
        rule: 43,
        file: posix,
        line:
          sourceFile.getLineAndCharacterOfPosition(adHocRegistry.node.getStart(sourceFile)).line +
          1,
        message:
          "kernel capability names cannot form an ad hoc array, object, Set, or Map registry. Select lifecycle groups through kernel/capabilities.ts.",
      });
    }

    const ordinaryResource = sourceIssues.find((issue) => issue.kind === "ordinary-resource");
    if (ordinaryResource !== undefined) {
      violations.push({
        rule: 43,
        file: posix,
        line:
          sourceFile.getLineAndCharacterOfPosition(ordinaryResource.node.getStart(sourceFile))
            .line + 1,
        message:
          "native kernel code must materialize native execution definitions, not fabricate ordinary public eve resources. Put ordinary definitions under public primitives and register them as sources.",
      });
    }

    const literalBranch = sourceIssues.find((issue) => issue.kind === "literal-branch");
    if (literalBranch !== undefined) {
      violations.push({
        rule: 43,
        file: posix,
        line:
          sourceFile.getLineAndCharacterOfPosition(literalBranch.node.getStart(sourceFile)).line +
          1,
        message:
          "runtime lifecycle code cannot branch directly on a kernel capability literal. Add an executable strategy hook and invoke it through kernel/capabilities.ts.",
      });
    }
  }

  return violations;
}

function readKernelCapabilityNamesFromOwner(sourceFile) {
  const names = new Set();

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "KERNEL_CAPABILITY_NAMES" &&
      node.initializer !== undefined
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isArrayLiteralExpression(initializer)) {
        for (const element of initializer.elements) {
          const value = readStringLiteral(element);
          if (value !== undefined) names.add(value);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return names;
}

export function findRule43SourceIssues(sourceFile, kernelCapabilityNames, checks) {
  const issues = [];
  const bindings = collectIdentifierInitializers(sourceFile);
  const imports = collectImportedSymbols(sourceFile);

  if (checks.checksRawInventory) {
    const rawInventory = findNode(
      sourceFile,
      (node) =>
        ts.isIdentifier(node) &&
        RAW_KERNEL_INVENTORY_NAMES.has(node.text) &&
        !checks.allowedRawInventoryNames?.has(node.text),
    );
    if (rawInventory !== undefined) issues.push({ kind: "raw-inventory", node: rawInventory });
  }

  if (checks.checksRegistries) {
    const registry = findNode(sourceFile, (node) => {
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isIdentifier(node.name) ||
        node.initializer === undefined
      ) {
        return false;
      }
      const kind = readRegistryKind(node.initializer, bindings, new Set());
      if (kind === undefined) return false;
      if (!REGISTRY_BINDING_NAME_RE.test(node.name.text)) return false;
      const names = readRegistryKernelNames(
        node.initializer,
        kind,
        bindings,
        kernelCapabilityNames,
        new Set(),
      );
      return names.size > 0;
    });
    if (registry !== undefined) issues.push({ kind: "ad-hoc-registry", node: registry });
  }

  if (checks.checksNativeOwnership) {
    const ordinaryCall = findNode(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return false;
      const importedName = resolveImportedSymbol(node.expression, imports, bindings, new Set());
      return importedName !== undefined && NATIVE_ORDINARY_RESOURCE_CREATORS.has(importedName);
    });
    if (ordinaryCall !== undefined) issues.push({ kind: "ordinary-resource", node: ordinaryCall });
  }

  if (checks.checksLiteralBranches) {
    const literalBranch = findNode(sourceFile, (node) =>
      isDirectKernelLiteralBranch(node, kernelCapabilityNames),
    );
    if (literalBranch !== undefined) issues.push({ kind: "literal-branch", node: literalBranch });
  }

  return issues;
}

export function analyzeRule43Fixture(sourceText, checks = {}) {
  const sourceFile = ts.createSourceFile(
    "rule43-fixture.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  return findRule43SourceIssues(
    sourceFile,
    new Set([
      "agent",
      "task_cancel",
      "task_update",
      "ask_question",
      "load_skill",
      "web_search",
      "Workflow",
      "final_output",
    ]),
    {
      checksNativeOwnership: checks.checksNativeOwnership ?? false,
      checksLiteralBranches: checks.checksLiteralBranches ?? false,
      checksRawInventory: checks.checksRawInventory ?? true,
      checksRegistries: checks.checksRegistries ?? true,
      allowedRawInventoryNames: new Set(),
    },
  ).map((issue) => issue.kind);
}

function isDirectKernelLiteralBranch(node, kernelCapabilityNames) {
  if (ts.isBinaryExpression(node)) {
    const equalityOperators = new Set([
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ]);
    if (!equalityOperators.has(node.operatorToken.kind)) return false;
    const leftLiteral = resolveLiteralKernelName(node.left, kernelCapabilityNames);
    const rightLiteral = resolveLiteralKernelName(node.right, kernelCapabilityNames);
    return (
      (leftLiteral !== undefined && isLifecycleDiscriminant(node.right)) ||
      (rightLiteral !== undefined && isLifecycleDiscriminant(node.left))
    );
  }
  if (!ts.isCaseClause(node) || node.expression === undefined) return false;
  const literal = resolveLiteralKernelName(node.expression, kernelCapabilityNames);
  return literal !== undefined && isLifecycleDiscriminant(node.parent.parent.expression);
}

function resolveLiteralKernelName(expression, kernelCapabilityNames) {
  const value = readStringLiteral(expression);
  return value !== undefined && kernelCapabilityNames.has(value) ? value : undefined;
}

function isLifecycleDiscriminant(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return /^(?:capability|kernelCapability|name|toolName)$/u.test(unwrapped.text);
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return /^(?:capability|kernelCapability|name|toolName)$/u.test(unwrapped.name.text);
  }
  return false;
}

function collectIdentifierInitializers(sourceFile) {
  const bindings = new Map();
  visitEveryNode(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      bindings.set(node.name.text, node.initializer);
    }
  });
  return bindings;
}

function collectImportedSymbols(sourceFile) {
  const direct = new Map();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const bindings = statement.importClause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      direct.set(element.name.text, element.propertyName?.text ?? element.name.text);
    }
  }
  return { direct, namespaces };
}

function resolveImportedSymbol(expression, imports, bindings, seen) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const direct = imports.direct.get(unwrapped.text);
    if (direct !== undefined) return direct;
    if (seen.has(unwrapped.text)) return undefined;
    const initializer = bindings.get(unwrapped.text);
    if (initializer === undefined) return undefined;
    seen.add(unwrapped.text);
    return resolveImportedSymbol(initializer, imports, bindings, seen);
  }
  if (
    ts.isPropertyAccessExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    imports.namespaces.has(unwrapped.expression.text)
  ) {
    return unwrapped.name.text;
  }
  return undefined;
}

function readRegistryKind(expression, bindings, seen) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isArrayLiteralExpression(unwrapped)) return "array";
  if (ts.isObjectLiteralExpression(unwrapped)) return "object";
  if (
    ts.isNewExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    (unwrapped.expression.text === "Map" || unwrapped.expression.text === "Set")
  ) {
    return unwrapped.expression.text.toLowerCase();
  }
  if (!ts.isIdentifier(unwrapped) || seen.has(unwrapped.text)) return undefined;
  const initializer = bindings.get(unwrapped.text);
  if (initializer === undefined) return undefined;
  seen.add(unwrapped.text);
  return readRegistryKind(initializer, bindings, seen);
}

function readRegistryKernelNames(expression, kind, bindings, kernelCapabilityNames, seen) {
  const names = new Set();
  const unwrapped = resolveAliasedExpression(expression, bindings, seen);
  if (unwrapped === undefined) return names;

  if (kind === "array" && ts.isArrayLiteralExpression(unwrapped)) {
    for (const element of unwrapped.elements) {
      if (ts.isSpreadElement(element)) {
        for (const name of readRegistryKernelNames(
          element.expression,
          readRegistryKind(element.expression, bindings, new Set()) ?? "array",
          bindings,
          kernelCapabilityNames,
          new Set(seen),
        ))
          names.add(name);
        continue;
      }
      const value = resolveStringLiteral(element, bindings, new Set());
      if (value !== undefined && kernelCapabilityNames.has(value)) names.add(value);
    }
    return names;
  }

  if (kind === "object" && ts.isObjectLiteralExpression(unwrapped)) {
    for (const property of unwrapped.properties) {
      if (ts.isSpreadAssignment(property)) {
        for (const name of readRegistryKernelNames(
          property.expression,
          "object",
          bindings,
          kernelCapabilityNames,
          new Set(seen),
        ))
          names.add(name);
        continue;
      }
      const value = resolvePropertyName(property.name, bindings);
      if (value !== undefined && kernelCapabilityNames.has(value)) names.add(value);
      if (ts.isPropertyAssignment(property)) {
        const assigned = resolveStringLiteral(property.initializer, bindings, new Set());
        if (assigned !== undefined && kernelCapabilityNames.has(assigned)) names.add(assigned);
      }
    }
    return names;
  }

  if (kind === "set" && ts.isNewExpression(unwrapped) && unwrapped.arguments?.length === 1) {
    return readRegistryKernelNames(
      unwrapped.arguments[0],
      "array",
      bindings,
      kernelCapabilityNames,
      new Set(seen),
    );
  }

  if (kind === "map" && ts.isNewExpression(unwrapped) && unwrapped.arguments?.length === 1) {
    const entries = resolveAliasedExpression(unwrapped.arguments[0], bindings, new Set(seen));
    if (entries === undefined || !ts.isArrayLiteralExpression(entries)) return names;
    for (const entry of entries.elements) {
      if (ts.isSpreadElement(entry)) continue;
      const tuple = resolveAliasedExpression(entry, bindings, new Set(seen));
      if (tuple === undefined || !ts.isArrayLiteralExpression(tuple)) continue;
      const value =
        tuple.elements[0] === undefined
          ? undefined
          : resolveStringLiteral(tuple.elements[0], bindings, new Set());
      if (value !== undefined && kernelCapabilityNames.has(value)) names.add(value);
      const mapped =
        tuple.elements[1] === undefined
          ? undefined
          : resolveStringLiteral(tuple.elements[1], bindings, new Set());
      if (mapped !== undefined && kernelCapabilityNames.has(mapped)) names.add(mapped);
    }
  }
  return names;
}

function resolveAliasedExpression(expression, bindings, seen) {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isIdentifier(unwrapped)) return unwrapped;
  if (seen.has(unwrapped.text)) return undefined;
  const initializer = bindings.get(unwrapped.text);
  if (initializer === undefined) return unwrapped;
  seen.add(unwrapped.text);
  return resolveAliasedExpression(initializer, bindings, seen);
}

function resolveStringLiteral(expression, bindings, seen) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isStringLiteralLike(unwrapped)) return unwrapped.text;
  if (!ts.isIdentifier(unwrapped) || seen.has(unwrapped.text)) return undefined;
  const initializer = bindings.get(unwrapped.text);
  if (initializer === undefined) return undefined;
  seen.add(unwrapped.text);
  return resolveStringLiteral(initializer, bindings, seen);
}

function resolvePropertyName(name, bindings) {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return undefined;
  return resolveStringLiteral(name.expression, bindings, new Set());
}

function findNode(sourceFile, predicate) {
  let result;
  visitEveryNode(sourceFile, (node) => {
    if (result === undefined && predicate(node)) result = node;
  });
  return result;
}

function visitEveryNode(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => visitEveryNode(child, visitor));
}

function unwrapExpression(node) {
  let expression = node;
  while (
    ts.isAsExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function readStringLiteral(node) {
  const expression = unwrapExpression(node);
  return ts.isStringLiteralLike(expression) ? expression.text : undefined;
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
// overlays) read canonical identity from `@eve/catalog`, a
// dependency-free data package shared across the scaffolder and docs. It
// carries no runtime, compiler, or provider-SDK weight, so the entire scaffold
// layer may import it. The terminal UI adapters (which carry @clack/core and
// picocolors) live outside the scaffold, in `packages/eve/src/setup/cli/`.
const SCAFFOLD_ALLOWED_PACKAGES = new Set(["@eve/catalog"]);

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
            message: `import from "${spec}" not allowed in the packages/eve/src/setup/scaffold source layer. Scaffold modules allow only node:* builtins, relative files, and @eve/catalog. Keep runtime, compiler, terminal UI, and provider SDK dependencies in their owning package.`,
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

// ---------- Rule 32: research document frontmatter ----------

const RESEARCH_DIR = "research";
const RESEARCH_LAST_UPDATED_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @returns {Promise<Violation[]>}
 */
async function checkRule32ResearchFrontmatter() {
  /** @type {Violation[]} */
  const violations = [];
  const researchRoot = join(REPO_ROOT, RESEARCH_DIR);

  try {
    await readdir(researchRoot);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return violations;
    }
    throw error;
  }

  for await (const { absPath, relPath } of walkFiles(researchRoot)) {
    const posix = toPosix(relPath);
    if (!posix.endsWith(".md")) continue;

    const content = await readFile(absPath, "utf8");
    if (!matter.test(content)) {
      violations.push({
        rule: 32,
        file: posix,
        message:
          "research documents must start with YAML frontmatter containing `issue`, `status`, and `last_updated` fields.",
      });
      continue;
    }

    let data;
    try {
      data = matter(content).data;
    } catch (error) {
      violations.push({
        rule: 32,
        file: posix,
        message: `research frontmatter must be valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      violations.push({
        rule: 32,
        file: posix,
        message: "research frontmatter must parse to an object.",
      });
      continue;
    }

    for (const field of ["issue", "status"]) {
      if (typeof data[field] === "string" && data[field].trim().length > 0) continue;
      violations.push({
        rule: 32,
        file: posix,
        message: `research frontmatter must set \`${field}\` to a non-empty string.`,
      });
    }

    if (
      typeof data.last_updated !== "string" ||
      !RESEARCH_LAST_UPDATED_RE.test(data.last_updated)
    ) {
      violations.push({
        rule: 32,
        file: posix,
        message: "research frontmatter must set `last_updated` to a quoted `YYYY-MM-DD` string.",
      });
    }
  }

  return violations;
}

// ---------- Rule 34: no `phase` imports under GPU/shader boundaries ----------

const PHASE_BOUNDARY_DIRS = [
  "apps/docs/app/[lang]/(home)/components/eve-logo-shader/render",
  "apps/docs/app/[lang]/(home)/components/eve-logo-shader/shaders",
  "apps/docs/scripts/eve-render",
];
const PHASE_IMPORT_RE =
  /(from\s+|import\s+)(?:type\s+)?['"]phase(?:\/[^'"]*)?['"]|require\(\s*['"]phase(?:\/[^'")]*)?['"]\s*\)|import\(\s*['"]phase(?:\/[^'")]*)?['"]\s*\)/;

/**
 * @returns {Promise<Violation[]>}
 */
async function checkRule34PhaseBoundary() {
  /** @type {Violation[]} */
  const violations = [];
  for (const relDir of PHASE_BOUNDARY_DIRS) {
    const absDir = join(REPO_ROOT, relDir);
    let stats;
    try {
      stats = await lstat(absDir);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (!stats.isDirectory()) continue;
    for await (const entry of walkFiles(absDir)) {
      if (!entry.stat.isFile()) continue;
      const content = await readFile(entry.absPath, "utf8");
      const match = content.match(PHASE_IMPORT_RE);
      if (!match) continue;
      const before = content.slice(0, match.index ?? 0);
      const line = before.split(/\r?\n/).length;
      violations.push({
        rule: 34,
        file: entry.relPath,
        line,
        message:
          "imports the `phase` package inside the GPU/shader boundary. Phase must stay in the lifecycle/runtime layer — add lifecycle hooks above render/ and keep render/, shaders/, and scripts/eve-render/ free of `phase` imports.",
      });
    }
  }
  return violations;
}

// ---------- Rule 38: one owner for the eve package build ----------

const NESTED_EVE_BUILD_RE = /\bpnpm\s+(?:--filter(?:=|\s+)eve|-F\s+eve)\s+(?:run\s+)?build\b/;

/**
 * @returns {Promise<Violation[]>}
 */
async function checkRule38NoNestedEveBuild() {
  /** @type {Violation[]} */
  const violations = [];

  for (const dir of await readPnpmWorkspacePackageDirs()) {
    if (dir === "packages/eve") continue;
    const packageJson = await readJsonIfExists(join(REPO_ROOT, dir, "package.json"));
    for (const [scriptName, command] of Object.entries(packageJson?.scripts ?? {})) {
      if (typeof command !== "string" || !NESTED_EVE_BUILD_RE.test(command)) continue;
      violations.push({
        rule: 38,
        file: `${dir}/package.json`,
        message: `script "${scriptName}" launches a nested eve package build. Declare eve as a workspace dependency and let Turbo's ^build edge produce it once; rebuilding eve inside a consumer races its destructive dist clean against other consumers.`,
      });
    }
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

    if (!excluded && dirs.length === 0) {
      throw new Error(`Workspace package pattern "${rawPattern}" matched no package.json files.`);
    }

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
  const normalizedPattern = pattern.replace(/\/+$/, "");
  const dirs = [];

  for await (const manifestPath of glob(`${normalizedPattern}/package.json`, {
    cwd: REPO_ROOT,
  })) {
    dirs.push(toPosix(dirname(manifestPath)));
  }

  return dirs.sort();
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
    rule33: /** @type {Violation[]} */ ([]),
    rule35: /** @type {Violation[]} */ ([]),
    rule37: /** @type {Violation[]} */ ([]),
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

  // Rule 32
  violations.push(...(await checkRule32ResearchFrontmatter()));

  // Rule 33
  violations.push(...state.rule33);

  // Rule 34
  violations.push(...(await checkRule34PhaseBoundary()));

  // Rule 35
  violations.push(...state.rule35);

  // Rule 36
  for (const issue of await checkExtensionCapabilityContracts()) {
    violations.push({ rule: 36, ...issue });
  }

  // Rule 37
  violations.push(...state.rule37);

  // Rule 38
  violations.push(...(await checkRule38NoNestedEveBuild()));

  // Rule 40
  violations.push(...(await checkRule40WireContracts()));

  // Rule 41
  violations.push(...(await checkRule41CompiledBindingAuthority()));

  // Rule 42
  violations.push(...(await checkRule42PrimitiveOwnership()));

  // Rule 43
  violations.push(...(await checkRule43KernelCapabilityLifecycle()));

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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
