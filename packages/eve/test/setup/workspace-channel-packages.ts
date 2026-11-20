const source = (path: string) => new URL(path, import.meta.url).pathname;

export const workspaceChannelPackages = [
  { find: /^@eve\/recall$/, replacement: source("../../../eve-recall/src/index.ts") },
  { find: /^eve\/(channels|context|events)$/, replacement: source("../../src/public/$1/index.ts") },
  { find: /^eve\/internal\/channels$/, replacement: source("../../src/internal/channels.ts") },
];
