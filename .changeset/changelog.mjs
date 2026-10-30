import { classifyTitle, parseSummary } from "../scripts/changeset-format.mjs";
import { pullRequestFor } from "../scripts/changeset-github.mjs";

const pulls = new Map();
const headings = {
  breaking: "Breaking Changes",
  feature: "Features",
  bugfix: "Bug Fixes",
  internal: "Internal",
  other: "Other Changes",
};
const blockLine = /^(?:\s*(?:[-*+]|\d+[.)])\s|\s{4}|#|>|```|~~~|\|)/u;

// Prose details fold into the summary's paragraph so lists stay tight; a blank
// line inside any item would make CommonMark space out the whole list. Lists,
// code, quotes, and tables cannot fold, so they follow as indented blocks.
function renderEntry(summary, details, link) {
  const prose = details && !details.split("\n").some((line) => blockLine.test(line));
  const body = prose
    ? `${summary}\n${details.replace(/\n\s*\n/gu, "\n")} ${link}`
    : `${summary} ${link}${details ? `\n\n${details}` : ""}`;
  return `- ${body
    .split("\n")
    .map((line, index) => (index && line ? `  ${line}` : line))
    .join("\n")}`;
}

export default {
  async getReleaseLine(changeset, type) {
    const { summary, details } = parseSummary(changeset.summary, changeset.id);
    if (!pulls.has(changeset.commit))
      pulls.set(changeset.commit, pullRequestFor(changeset.commit, changeset.id));
    const pull = await pulls.get(changeset.commit);
    // Pre-1.0, a minor bump is how a changeset declares a breaking change.
    let category = type === "major" || type === "minor" ? "breaking" : undefined;
    if (!category) {
      try {
        category = classifyTitle(pull.subject);
      } catch {
        category = "other";
        console.warn(
          `Changeset ${changeset.id}: commit subject has no release category; review the compare link.`,
        );
      }
    }
    const link = `([#${pull.number}](https://github.com/vercel/eve/pull/${pull.number}))`;
    return `#### ${headings[category]}\n\n${renderEntry(summary, details, link)}`;
  },
  getDependencyReleaseLine(_changesets, dependencies) {
    if (!dependencies.length) return "";
    return `#### Dependencies\n\n${dependencies.map(({ name, newVersion }) => `- Updated ${name} to ${newVersion}.`).join("\n")}`;
  },
};
