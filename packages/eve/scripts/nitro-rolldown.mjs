import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

let rolldownPromise;

export async function loadNitroRolldown() {
  rolldownPromise ??= (async () => {
    const require = createRequire(import.meta.url);
    const nitroRequire = createRequire(require.resolve("nitro/package.json"));
    return await import(pathToFileURL(nitroRequire.resolve("rolldown")).href);
  })();

  return await rolldownPromise;
}

export async function buildWithNitroRolldown(options) {
  const { build } = await loadNitroRolldown();
  return await build(options);
}
