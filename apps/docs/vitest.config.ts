import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^eve\/(connections|tools\/approval)$/,
        replacement: new URL("../../packages/eve/src/public/$1/index.ts", import.meta.url).pathname,
      },
      {
        find: "eve/channels/auth",
        replacement: new URL("../../packages/eve/src/public/channels/auth.ts", import.meta.url)
          .pathname,
      },
      {
        find: /^#compiled\/(.+)\.js$/,
        replacement: new URL("../../packages/eve/.generated/compiled/$1.js", import.meta.url)
          .pathname,
      },
      {
        find: /^#(.+)\.js$/,
        replacement: new URL("../../packages/eve/src/$1.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    include: ["lib/**/*.test.ts"],
    server: {
      deps: {
        inline: [/@vercel\/connect/],
      },
    },
  },
});
