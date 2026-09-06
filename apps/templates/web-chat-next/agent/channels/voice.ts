import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";
import { voiceChannel } from "eve/channels/voice";

export default voiceChannel({
  auth: [
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the browser voice demo.
    localDev(),
    // This placeholder will not allow browser requests in production.
    // Replace it with your app's auth provider before shipping voice.
    placeholderAuth(),
  ],
  greeting: "Hi! I'm your eve agent. Hold the button and say something.",
});
