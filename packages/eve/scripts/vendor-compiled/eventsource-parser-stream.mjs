import { createDeclarationCopier } from "./_shared.mjs";

export default {
  packageName: "eventsource-parser",
  compiledPath: "eventsource-parser/stream",
  typeOnly: true,
  copyDeclarations: createDeclarationCopier({
    files: [{ source: "stream.d.ts", output: "index.d.ts" }],
  }),
};
