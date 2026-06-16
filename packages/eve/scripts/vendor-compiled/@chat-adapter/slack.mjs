import { createDeclarationCopier, createOptionalNativeStubPlugin } from "../_shared.mjs";

/**
 * Stub for `@chat-adapter/shared`. The slack adapter re-exports two names
 * (`EncryptedTokenData`, `decodeKey`) from this package but eve never
 * touches them, so we only need declarations precise enough for the
 * upstream `.d.ts` to satisfy `verbatimModuleSyntax`.
 *
 * If a future chat-adapter version starts re-exporting additional names
 * from `@chat-adapter/shared`, this builder needs to learn about them or
 * the stub becomes incomplete — the `unknown` fallback at the bottom
 * keeps the vendor step succeeding so the gap is noticed without
 * breaking the build.
 */
function buildChatAdapterSharedStub(names, moduleName) {
  const declarations = {
    EncryptedTokenData: `export interface EncryptedTokenData {
  data: string;
  iv: string;
  tag: string;
}`,
    decodeKey: `export declare function decodeKey(rawKey: string): Buffer;`,
  };

  const lines = [
    `// Auto-generated stub for \`${moduleName}\` types referenced by a vendored .d.ts.`,
    `// Emitted by scripts/vendor-compiled/@chat-adapter/slack.mjs.`,
    ``,
  ];
  for (const name of [...names].sort()) {
    if (Object.prototype.hasOwnProperty.call(declarations, name)) {
      lines.push(declarations[name]);
    } else {
      lines.push(`export type ${name} = unknown;`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function buildSlackWebApiStub(names, moduleName) {
  const lines = [
    `// Auto-generated stub for \`${moduleName}\` types referenced by a vendored .d.ts.`,
    `// Emitted by scripts/vendor-compiled/@chat-adapter/slack.mjs.`,
    ``,
  ];
  for (const name of [...names].sort()) {
    if (name === "WebClient") {
      lines.push(`export declare class WebClient {
  constructor(...args: any[]);
  [key: string]: any;
}`);
    } else {
      lines.push(`export type ${name} = unknown;`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Type declarations are copied verbatim from the installed
 * @chat-adapter/slack version so eve's `SlackAdapter` tracks the real
 * package shape. The chat-typed methods on `SlackAdapter` (post / edit /
 * delete / …) feed directly into the `Thread` interface consumers see
 * via `ctx.thread`.
 */
export default {
  packageName: "@chat-adapter/slack",
  compiledPath: "@chat-adapter/slack",
  plugins: [createOptionalNativeStubPlugin(["bufferutil", "utf-8-validate"])],
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      chat: { kind: "vendored", compiledPath: "chat" },
      "@chat-adapter/shared": {
        kind: "stub",
        stubBaseName: "_chat-adapter-shared",
        build: buildChatAdapterSharedStub,
      },
      "@slack/web-api": {
        kind: "stub",
        stubBaseName: "_slack-web-api",
        build: buildSlackWebApiStub,
      },
    },
  }),
};
