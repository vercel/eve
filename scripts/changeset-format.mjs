const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

export function classifyTitle(title) {
  title = title.replace(/^\[\d+\/\d+\]\s+/u, "");
  if (/^perf(?:\([^)]+\))?!?:\s+\S/iu.test(title)) return "feature";
  if (/^feat(?:\([^)]+\))?!?:\s+\S/iu.test(title)) return "feature";
  if (/^fix(?:\([^)]+\))?!?:\s+\S/iu.test(title)) return "bugfix";
  if (/^docs\(feature\)!?:\s+\S/iu.test(title)) return "feature";
  if (/^docs\(bugfix\)!?:\s+\S/iu.test(title)) return "bugfix";
  if (/^(?:internal|chore|refactor|test|ci|build)(?:\([^)]+\))?!?:\s+\S/iu.test(title))
    return "internal";
  throw new Error(
    `Invalid release PR title ${JSON.stringify(title)}. Use feat:, perf:, fix:, docs(feature):, docs(bugfix):, or an internal type (chore:, refactor:, test:, ci:, build:, internal:).`,
  );
}

export function parseSummary(text, id) {
  const [line, ...notes] = text.trim().split(/\r?\n/u);
  const summary = line.trim();
  if (!/[.!?]$/u.test(summary) || [...sentences.segment(summary)].length !== 1) {
    throw new Error(`Changeset ${id}: the first line must contain exactly one complete sentence.`);
  }
  const details = notes.join("\n").trim();
  const credits = [...sentences.segment(details)]
    .map(({ segment }) => segment)
    .filter((sentence) => /\bthanks\b/iu.test(sentence))
    .join(" ")
    .replace(/`[^`]*`|https?:\/\/\S+/gu, "");
  const contributors = [
    ...credits.matchAll(/(?<![\w@/])@([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)(?![\w/-])/giu),
  ].map((match) => match[1]);
  return { summary, details, contributors };
}
