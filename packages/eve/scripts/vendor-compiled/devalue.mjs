import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "devalue",
  compiledPath: "devalue",
  declaration: await loadDeclaration("devalue.d.ts"),
  entry: "index.js",
  platform: "neutral",
};
