/**
 * Generated-file detection for repository edit tools.
 *
 * Models otherwise spend minutes generating lockfile hunks token by token.
 * Generated files must change through the deterministic command that
 * generates them, never through model-authored patches.
 */

const GENERATED_PATH_RULES: readonly {
  readonly test: (path: string) => boolean;
  readonly label: string;
  readonly remedy: string;
}[] = [
  {
    test: (path) =>
      /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/u.test(path),
    label: "package manager lockfile",
    remedy:
      "run the package manager in the sandbox (for example `pnpm install`) so it regenerates the lockfile",
  },
  {
    test: (path) => /(^|\/)(dist|\.next|\.eve|coverage)\//u.test(path),
    label: "build output",
    remedy: "run the build command that produces this directory",
  },
  {
    test: (path) => /(^|\/)vendor-compiled\//u.test(path),
    label: "vendored compiled asset",
    remedy: "run the repository's vendoring script that regenerates this directory",
  },
  {
    test: (path) => /(^|\/)node_modules\//u.test(path),
    label: "installed dependency",
    remedy: "change the dependency declaration and reinstall instead",
  },
];

export interface GeneratedPathMatch {
  readonly path: string;
  readonly label: string;
  readonly remedy: string;
}

/** Paths named by `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:` headers. */
export function patchTargetPaths(patchText: string): readonly string[] {
  const paths: string[] = [];
  const header = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gmu;
  for (const match of patchText.matchAll(header)) {
    const path = match[1]?.trim();
    if (path !== undefined && path.length > 0) paths.push(path);
  }
  return paths;
}

/** Generated files targeted by the patch, with the deterministic remedy for each. */
export function findGeneratedPatchTargets(patchText: string): readonly GeneratedPathMatch[] {
  const matches: GeneratedPathMatch[] = [];
  for (const path of patchTargetPaths(patchText)) {
    const rule = GENERATED_PATH_RULES.find((candidate) => candidate.test(path));
    if (rule !== undefined) matches.push({ label: rule.label, path, remedy: rule.remedy });
  }
  return matches;
}

/** One actionable error message covering every generated target in the patch. */
export function generatedPatchTargetsError(matches: readonly GeneratedPathMatch[]): string {
  const lines = matches.map((match) => `- ${match.path} (${match.label}): ${match.remedy}`);
  return [
    "This patch targets generated files, which must not be edited through model-authored patches:",
    ...lines,
    "Use the deterministic operation instead. Preserve existing user changes; if regeneration would overwrite them, stop and ask for explicit authorization.",
  ].join("\n");
}
