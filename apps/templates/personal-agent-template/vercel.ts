import { withEve } from "eve/vercel";

export default await withEve({
  services: {
    web: { framework: "nuxt", root: "apps/web" },
  },
  routes: [{ src: "^(.*)$", destination: { type: "service", service: "web" } }],
});
