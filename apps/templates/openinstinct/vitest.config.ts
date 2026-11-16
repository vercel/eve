import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "server-only",
        replacement: fileURLToPath(
          new URL("tests/helpers/server-only.ts", import.meta.url)
        ),
      },
      {
        find: /^@db$/u,
        replacement: fileURLToPath(new URL("db/index.ts", import.meta.url)),
      },
      {
        find: /^@shared\/environment$/u,
        replacement: fileURLToPath(
          new URL("shared/environment/env.ts", import.meta.url)
        ),
      },
      ...["agent", "app", "db", "evals", "shared", "tests", "tools", "web"].map(
        (owner) => ({
          find: new RegExp(`^@${owner}/(.*)$`, "u"),
          replacement: fileURLToPath(new URL(`${owner}/$1`, import.meta.url)),
        })
      ),
    ],
  },
  test: {
    setupFiles: ["./tests/setup-env.ts"],
  },
});
