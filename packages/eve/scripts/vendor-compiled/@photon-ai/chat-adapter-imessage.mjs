import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@photon-ai/chat-adapter-imessage",
  compiledPath: "@photon-ai/chat-adapter-imessage",
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      chat: { kind: "vendored", compiledPath: "chat" },
      "@chat-adapter/shared": {
        kind: "stub",
        stubBaseName: "_chat-adapter-shared",
        build: () => "export {};\n",
      },
      "@spectrum-ts/core": {
        kind: "stub",
        stubBaseName: "_spectrum-core",
        build: () =>
          "export type AppUrl = unknown;\nexport type ContentBuilder = unknown;\nexport type SpectrumInstance = unknown;\n",
      },
      "@spectrum-ts/imessage": {
        kind: "stub",
        stubBaseName: "_spectrum-imessage",
        build: () =>
          "export type CustomizedMiniAppInput = unknown;\nexport type IMessageMessageEffect = string;\n",
      },
    },
  }),
};
