const labels = /^(feature|bugfix|docs\(feature\)|docs\(bugfix\)|internal):\s+(.+)$/u;
const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

export function parseSummary(text, id) {
  const [line, ...notes] = text.trim().split(/\r?\n/u);
  const match = labels.exec(line);
  if (!match) {
    throw new Error(
      `Changeset ${id}: start the summary with feature:, bugfix:, docs(feature):, docs(bugfix):, or internal: followed by one sentence.`,
    );
  }
  const summary = match[2].trim();
  if (!/[.!?]$/u.test(summary) || [...sentences.segment(summary)].length !== 1) {
    throw new Error(`Changeset ${id}: the first line must contain exactly one complete sentence.`);
  }
  const category = match[1].startsWith("docs(") ? match[1].slice(5, -1) : match[1];
  const contributors = [
    ...notes.join("\n").matchAll(/(?<![\w@])@([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)(?![\w-])/giu),
  ].map((match) => match[1]);
  return { category, summary, contributors };
}
