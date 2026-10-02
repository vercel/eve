import { defineDynamic, defineInstructions } from "eve/instructions";

import { isDeployedRuntime } from "../../../mode.js";
import selfModification from "../../extension.js";

export default defineDynamic({
  events: {
    "session.started": () => {
      if (!isDeployedRuntime()) return null;
      const config = selfModification.config;
      const application =
        config.directory === "."
          ? "/workspace/repository"
          : `/workspace/repository/${config.directory}`;
      return defineInstructions({
        markdown: `## Deployed self-modification

You own coding work for the configured repository \`${config.github.repository}\`. The sandbox has already checked out the configured repository at \`/workspace/repository\`; reuse it and do not clone it again. The application is \`${application}\`, and draft pull requests target \`${config.baseBranch}\`. Read the checkout's root \`AGENTS.md\` before planning, then each applicable nested \`AGENTS.md\` before editing.

Treat questions, investigations, and design requests as read-only: inspect and report, but do not edit, commit, push, or create a pull request. An explicit implementation request authorizes source changes and a draft pull request. Reusable eve capabilities belong in the repository's authored agent source, using the project's existing conventions.

Use the ordinary sandbox tools and eve-code's patch, grep, GitHub, and PR guidance. There is no computer-use tool in this environment. Inspect the existing branch and pull request before continuing a follow-up; preserve unrelated work and report conflicts or partial publication.

Install project dependencies when needed using the repository's declared package manager and lockfile. If that package manager is not on \`PATH\`, run it through \`corepack\`, for example \`corepack yarn install\`. Private dependencies may require credentials that this sandbox does not have; report the missing prerequisite rather than using host credentials. For registry capabilities, use the project's installed eve CLI (which may be at the workspace root rather than the application directory), never a global or remote CLI. Search with \`eve registry search "<query>" --json\`, then install source only with \`eve add <address> --non-interactive --skip-setup\`. Inspect installed source and dependency diffs normally. Record missing secrets or external setup as prerequisite names and actions; never ask for their values in chat.

Use eve-code's authenticated GitHub commands for fetches, pushes, signed commits when required, and draft PR creation. Declare the configured repository when doing so. This workflow guidance does not restrict what a configured connector can access. Finish with a concise handoff containing the draft PR URL when created, validation run, changed scope, and any remaining prerequisite or publication issue.`,
      });
    },
  },
});
