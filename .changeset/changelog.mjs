import { parseSummary } from "../scripts/changeset-format.mjs";
import { pullRequestFor } from "../scripts/changeset-github.mjs";

const pulls = new Map();

function marker(data) {
  return `<!-- eve-changeset:${Buffer.from(JSON.stringify(data)).toString("base64url")} -->`;
}

export default {
  async getReleaseLine(changeset) {
    const { category, summary, contributors } = parseSummary(changeset.summary, changeset.id);
    if (!pulls.has(changeset.commit))
      pulls.set(changeset.commit, pullRequestFor(changeset.commit, changeset.id));
    const pull = await pulls.get(changeset.commit);
    return marker({ category, summary, contributors, pull });
  },
  getDependencyReleaseLine(_changesets, dependencies) {
    if (!dependencies.length) return "";
    return marker({
      dependencies: dependencies.map(({ name, newVersion }) => ({ name, newVersion })),
    });
  },
};
