import { createDeclarationCopier } from "../_shared.mjs";

/**
 * Type declarations are copied verbatim from the installed
 * @chat-adapter/state-memory version. The exported `StateAdapter` surface
 * has to satisfy the real chat `StateAdapter` interface, which is
 * impossible to keep accurate via hand-written stubs as it evolves.
 */
export default {
  packageName: "@chat-adapter/state-memory",
  compiledPath: "@chat-adapter/state-memory",
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      chat: { kind: "vendored", compiledPath: "chat" },
    },
  }),
};
