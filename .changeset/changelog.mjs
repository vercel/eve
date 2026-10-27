import { classifyTitle, parseSummary } from "../scripts/changeset-format.mjs";
import { pullRequestFor } from "../scripts/changeset-github.mjs";

const pulls = new Map();
const headings = {
  feature: "🚀 Features",
  bugfix: "🐛 Bug Fixes",
  internal: "Internal",
  other: "Other Changes",
};

export default {
  async getReleaseLine(changeset) {
    const { summary, details, contributors } = parseSummary(changeset.summary, changeset.id);
    if (!pulls.has(changeset.commit))
      pulls.set(changeset.commit, pullRequestFor(changeset.commit, changeset.id));
    const pull = await pulls.get(changeset.commit);
    let category;
    try {
      category = classifyTitle(pull.subject);
    } catch {
      category = "other";
      console.warn(
        `Changeset ${changeset.id}: commit subject has no release category; review the full list of changes.`,
      );
    }
    const heading = headings[category];
    const note =
      details &&
      `\n\n${details
        .split("\n")
        .map((line) => (line ? `  ${line}` : ""))
        .join("\n")}`;
    const line = `- ${summary} [#${pull.number}](https://github.com/vercel/eve/pull/${pull.number})${note || ""}`;
    const logins = new Map();
    for (const login of [pull.author, ...pull.coauthors, ...contributors]) {
      if (login && !login.endsWith("[bot]")) logins.set(login.toLowerCase(), login);
    }
    const credits = [...logins.values()].map(
      (login) => `- [@${login}](https://github.com/${login})`,
    );
    return [
      `#### ${heading}\n\n${line}`,
      credits.length && `#### Contributors\n\n${credits.join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  },
  getDependencyReleaseLine(_changesets, dependencies) {
    if (!dependencies.length) return "";
    return `#### Dependencies\n\n${dependencies.map(({ name, newVersion }) => `- Updated ${name} to ${newVersion}.`).join("\n")}`;
  },
};
