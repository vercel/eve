import { withEve } from "eve/vercel";

export default await withEve({
  services: {
    web: {
      framework: "nuxtjs",
      root: "apps/web",
      buildCommand: "node ../../node_modules/nuxt/bin/nuxt.mjs build",
    },
  },
  routes: [{ src: "^(.*)$", destination: { type: "service", service: "web" } }],
});
