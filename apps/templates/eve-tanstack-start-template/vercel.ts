import { withEve } from "eve/vercel";

export default await withEve({
  services: {
    web: {
      framework: "tanstack-start",
      root: "apps/web",
      buildCommand: "node ../../node_modules/vite/bin/vite.js build",
    },
  },
  routes: [{ src: "^(.*)$", destination: { type: "service", service: "web" } }],
});
