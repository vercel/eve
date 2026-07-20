import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@ai-sdk/provider-utils",
  compiledPath: "@ai-sdk/provider-utils",
  typeOnly: true,
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      "@ai-sdk/provider": { kind: "vendored", compiledPath: "@ai-sdk/provider" },
      "@standard-schema/spec": {
        kind: "vendored",
        compiledPath: "@standard-schema/spec",
      },
      "@workflow/serde": { kind: "vendored", compiledPath: "@workflow/serde" },
      "eventsource-parser/stream": {
        kind: "vendored",
        compiledPath: "eventsource-parser/stream",
      },
      "zod/v3": { kind: "vendored", compiledPath: "zod" },
      "zod/v4": { kind: "vendored", compiledPath: "zod" },
    },
  }),
};
