import { createDeclarationCopier } from "./_shared.mjs";

export default {
  packageName: "chat-adapter-sendblue",
  compiledPath: "chat-adapter-sendblue",
  copyDeclarations: createDeclarationCopier({
    rewrites: { chat: { kind: "vendored", compiledPath: "chat" } },
  }),
};
