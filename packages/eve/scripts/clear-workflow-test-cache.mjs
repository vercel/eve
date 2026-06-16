import { rm } from "node:fs/promises";

await Promise.all([
  rm(new URL("../.eve/workflow-cache", import.meta.url), {
    force: true,
    recursive: true,
  }),
  rm(new URL("../dist/.eve/workflow-cache", import.meta.url), {
    force: true,
    recursive: true,
  }),
  rm(new URL("../.workflow-vitest", import.meta.url), {
    force: true,
    recursive: true,
  }),
  rm(new URL("../dist/.workflow-vitest", import.meta.url), {
    force: true,
    recursive: true,
  }),
]);
