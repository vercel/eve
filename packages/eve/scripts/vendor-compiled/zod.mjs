import { loadDeclaration } from "./_shared.mjs";

const EVAL_PROBE_SOURCE = `    try {
        const F = Function;
        new F("");
        return true;
    }
    catch (_) {
        return false;
    }`;

/**
 * Zod probes `new Function("")` before it JIT-compiles object parsers. The
 * browser client builds schemas at import, so a page whose CSP omits
 * 'unsafe-eval' reports a violation on every load even though Zod catches it.
 * Answering the probe with `false` keeps eve's copy on Zod's interpreted
 * parser, the path it already takes under a strict CSP or on Cloudflare. The
 * app's own Zod and the shared `z.config()` are untouched.
 */
function createNoEvalPlugin() {
  let patched = false;

  return {
    name: "eve-zod-no-eval",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/zod/v4/core/util.js")) {
        return null;
      }
      if (!code.includes(EVAL_PROBE_SOURCE)) {
        throw new Error("Zod's allowsEval probe changed.");
      }
      patched = true;
      return { code: code.replace(EVAL_PROBE_SOURCE, "    return false;"), map: null };
    },
    buildEnd(error) {
      if (!error && !patched) {
        throw new Error("Zod's allowsEval probe was not patched.");
      }
    },
  };
}

/**
 * eve ships exactly one Zod. Other vendored bundles and eve's own build
 * (`build-rolldown.mjs`) import these entries instead of bundling their own
 * copy, because Zod schema objects only work with the copy that built them.
 *
 * Keep this a plain re-export: Zod shares configuration through `globalThis`
 * across every copy in a process, so a side-effect import such as
 * `zod/compile` would also rewrite the app's own schemas.
 */
export default {
  packageName: "zod",
  compiledPath: "zod",
  chunkGroup: "client",
  plugins: [createNoEvalPlugin()],
  entries: [
    { declaration: await loadDeclaration("zod.d.ts"), input: "zod", outputPath: "index" },
    { input: "zod/v4/core", outputPath: "v4/core" },
    { input: "zod/v3", outputPath: "v3" },
  ],
  platform: "neutral",
  sharedSpecifiers: { zod: "index", "zod/v3": "v3", "zod/v4": "index", "zod/v4/core": "v4/core" },
};
