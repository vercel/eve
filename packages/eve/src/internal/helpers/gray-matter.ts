import matter, { type GrayMatterFile } from "#compiled/gray-matter/index.js";

/**
 * gray-matter ships built-in `javascript`/`js` frontmatter engines that
 * `eval()` the frontmatter body, so a document whose opening fence is
 * `---js` (or `---javascript`) executes that body the instant it is parsed —
 * before any validation runs. eve treats frontmatter strictly as data, so
 * these options disable the code-capable engines and pin the default language
 * to YAML. Pinning `language` alone is not enough: gray-matter reads the
 * language named after the opening fence and uses it in preference to the
 * option, so the engines must be replaced as well.
 */
function rejectJavaScriptFrontmatter(): never {
  throw new Error("JavaScript frontmatter is not supported.");
}

const SAFE_GRAY_MATTER_OPTIONS = {
  language: "yaml",
  engines: {
    javascript: rejectJavaScriptFrontmatter,
    js: rejectJavaScriptFrontmatter,
  },
} as const;

/** Options for {@link parseFrontmatter}. */
export interface ParseFrontmatterOptions {
  /**
   * Opt in to gray-matter's built-in code-capable engines, so a `---js` /
   * `---javascript` frontmatter fence is `eval()`d while parsing. This runs
   * arbitrary code the instant the document is read, so only enable it for
   * input you fully control and trust. Defaults to `false`, which rejects a
   * JavaScript frontmatter fence instead of evaluating it.
   */
  readonly allowCodeEngines?: boolean;
}

/**
 * Parses a document's YAML frontmatter and body.
 *
 * Safe by default: the code-capable frontmatter engines are disabled, so a
 * `---js` fence throws rather than executing. This is the only supported way
 * to run gray-matter in eve — callers must not import the bundled module
 * directly, so that untrusted input can never reach an evaluating engine by
 * accident. Pass `{ allowCodeEngines: true }` to deliberately opt back into
 * evaluation for trusted input.
 */
export function parseFrontmatter(
  source: string,
  options: ParseFrontmatterOptions = {},
): GrayMatterFile<string> {
  return options.allowCodeEngines ? matter(source) : matter(source, SAFE_GRAY_MATTER_OPTIONS);
}

/** Reports whether a document opens with a frontmatter delimiter. */
export function hasFrontmatter(source: string): boolean {
  return matter.test(source);
}
