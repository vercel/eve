import { connectGitHubCredentials } from "@vercel/connect/eve";
import { githubChannel } from "eve/channels/github";

export default githubChannel({
  credentials: connectGitHubCredentials("github/my-agent"),
});
