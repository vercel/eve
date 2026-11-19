import { loadDeclaration } from "./_shared.mjs";

const EVAL_PROBE_SOURCE = `    try {
        const F = Function;
        new F("");
        return true;
    }
    catch (_) {
        return false;
    }`;

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

export default {
  packageName: "zod",
  compiledPath: "zod",
  chunkGroup: "client",
  plugins: [createNoEvalPlugin()],
  entries: [
    { declaration: await loadDeclaration("zod.d.ts"), input: "zod", outputPath: "index" },
    { input: "zod/v4/core", outputPath: "v4/core" },
    { input: "zod/v3", outputPath: "v3" },
    { input: "zod/v4/locales/en.js", outputPath: "v4/locales/en" },
  ],
  platform: "neutral",
  sharedSpecifiers: {
    zod: "index",
    "zod/v3": "v3",
    "zod/v4": "index",
    "zod/v4/core": "v4/core",
    "zod/v4/locales/en.js": "v4/locales/en",
  },
};
