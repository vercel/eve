import { defineDynamic, defineInstructions } from "eve/instructions";
import { GITHUB_CONNECTOR } from "../lib/github.ts";

// Tells the agent GitHub isn't set up, so it points people to setup instead of
// failing at it. Once you've connected GitHub (README, "Connect GitHub") and
// set GITHUB_CONNECTOR, delete this file: it adds nothing while
// GITHUB_CONNECTOR is set, and the git extension's own instructions cover
// using GitHub.
//
// Without GITHUB_CONNECTOR, `extensions/git.ts` mounts the git extension without
// Connect, and the extension then tells the model to use the shell's `gh` and
// `git` credentials. The sandbox has none, so this overrides that.
const NOT_CONNECTED = `## GitHub

GitHub isn't connected, so you have no GitHub access. Ignore any guidance to
use \`gh\` or \`git\` with shell credentials: the sandbox has none, and those
commands fail. When someone asks about GitHub or needs repository access, say
it isn't set up and that an admin can connect it:

1. Create a Vercel Connect GitHub connector with
   \`vercel connect create github --name company-brain\`.
2. Install its GitHub App on the repositories the agent may use, from the
   Connect dashboard.
3. Set \`GITHUB_CONNECTOR\` on the Vercel project to the connector's UID, then
   redeploy.

The template README's "Connect GitHub" section has the details.`;

export default defineDynamic(() =>
  GITHUB_CONNECTOR ? null : defineInstructions({ content: NOT_CONNECTED }),
);
