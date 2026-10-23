/**
 * Nitro server plugin the eve Nuxt module registers for non-Vercel production
 * builds. Nitro runs it when the built Nuxt server boots, which is the only
 * point the module can reach inside `node .output/server/index.mjs`.
 */
export default function eveProductionServerPlugin(): void {
  void startEveServer().catch((error: unknown) => {
    // Starting eve must not take the Nuxt server down: eve routes answer 502
    // until the service is reachable, and the reason belongs in the log.
    console.error("[eve] failed to start the eve production server.", error);
  });
}

async function startEveServer(): Promise<void> {
  // Nitro bundles this plugin into the Nuxt server, and that bundle cannot
  // resolve eve's internal subpath imports. Keeping the specifier out of the
  // module graph loads eve from the deployed node_modules at boot instead; the
  // module adds eve to Nitro's traced externals so it is there.
  // Built from parts so no bundler folds it back into a static import.
  const specifier = ["eve", "nuxt", "production-server"].join("/");
  const { ensureEveProductionServer } = (await import(
    /* @vite-ignore */ specifier
  )) as typeof import("../production-server.js");

  await ensureEveProductionServer();
}
