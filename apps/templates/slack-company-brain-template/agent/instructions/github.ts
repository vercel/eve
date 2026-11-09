import { defineDynamic, defineInstructions } from "eve/instructions";
import { isGitHubConnected } from "../lib/github.ts";

// Tells the agent GitHub isn't set up, so it points people to setup instead of
// failing at it. Once you've connected GitHub (README, "Connect GitHub"),
// delete this file: it adds nothing once the connector exists, and the git
// extension's own instructions cover using GitHub.
const NOT_CONNECTED = `## GitHub

GitHub isn't connected, so you have no GitHub access, and \`git__gh\` commands
fail. Don't run them. When someone asks about GitHub or needs repository
access, say it isn't set up and that an admin can connect it:

1. Create the connector with \`vercel connect create github --name company-brain\`
   and attach it to the Vercel project.
2. Install its GitHub App on the repositories the agent may use, from the
   Connect dashboard.

The template README's "Connect GitHub" section has the details.`;

export default defineDynamic(async () =>
  (await isGitHubConnected()) ? null : defineInstructions({ content: NOT_CONNECTED }),
);
