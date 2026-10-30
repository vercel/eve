/** The files the replay reads, one per turn, oldest first. */
export const FILES = ["auth.md", "billing.md", "search.md", "export.md", "audit.md", "sync.md"];

/** Each file's access code: the fact the last turn needs back from the first file. */
export function codeOf(file: string): string {
  return `CODE-${file.replace(".md", "").toUpperCase()}-${file.length * 7919}`;
}

/** A file's text: its code once, then ~3k tokens of filler. */
export function contentOf(file: string): string {
  const filler = Array.from(
    { length: 200 },
    (_, line) => `Line ${line + 1} of ${file}: notes on retries, paging and error shapes.`,
  );
  return [`# ${file}`, `Access code for ${file}: ${codeOf(file)}`, ...filler].join("\n");
}

/** The replay: one turn per file, then a question only the first file answers. */
export const TURNS = [
  ...FILES.map((file) => `Read ${file} with read-file, then reply with only "done".`),
  `What is the access code in ${FILES[0]}? Reply with only the code.`,
];

export const STRATEGIES = ["default", "opencode", "codex"] as const;
export type StrategyName = (typeof STRATEGIES)[number];

/** The context window the fixture declares, small enough that the replay compacts. */
export const CONTEXT_WINDOW_TOKENS = 16_000;

/**
 * opencode and Codex size their constants for ~200k-token windows; the fixture scales them to
 * its window so each strategy keeps its proportions.
 */
export const SCALE = CONTEXT_WINDOW_TOKENS / 200_000;
