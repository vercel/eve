import { createDeclarationCopier, createOptionalNativeStubPlugin } from "../_shared.mjs";

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

export default {
  packageName: "@chat-adapter/slack",
  compiledPath: "@chat-adapter/slack",
  entries: [
    {
      outputPath: "index",
    },
    {
      input: "@chat-adapter/slack/blocks",
      outputPath: "blocks",
    },
    {
      input: "@chat-adapter/slack/webhook",
      outputPath: "webhook",
    },
    {
      input: "@chat-adapter/slack/format",
      outputPath: "format",
    },
    {
      input: "@chat-adapter/slack/api",
      outputPath: "api",
    },
  ],
  plugins: [createOptionalNativeStubPlugin(["bufferutil", "utf-8-validate"])],
  copyDeclarations: createDeclarationCopier({
    discoverExtraFiles: (distEntries) =>
      distEntries.filter((entry) => /^types-.*\.d\.ts$/u.test(entry)),
    files: [
      { source: "index.d.ts", output: "index.d.ts" },
      { source: "blocks.d.ts", output: "blocks.d.ts" },
      { source: "webhook.d.ts", output: "webhook.d.ts" },
      { source: "format.d.ts", output: "format.d.ts" },
      { source: "api.d.ts", output: "api.d.ts" },
    ],
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
