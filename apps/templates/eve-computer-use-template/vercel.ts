import { withEve } from "eve/vercel";

export default await withEve({
  services: {
    web: {
      framework: "nextjs",
      root: "apps/web",
      buildCommand: "node ../../node_modules/next/dist/bin/next build",
      // The /api/live route reads sessions from the agent with each viewer's own credentials.
      // A binding gives it the agent's address, so a request can never point it elsewhere.
      bindings: [{ type: "service", service: "eve", format: "url", env: "EVE_URL" }],
    },
  },
  routes: [{ src: "^(.*)$", destination: { type: "service", service: "web" } }],
});
