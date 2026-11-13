// Tests drive the workspace's first-party channel packages, which import eve by its public
// paths, against eve's own source, so both share one copy of eve. tsconfig.channel-packages.json maps the same.
const source = (path: string) => new URL(path, import.meta.url).pathname;

export const workspaceChannelPackages = [
  { find: /^@eve\/recall$/, replacement: source("../../../eve-recall/src/index.ts") },
  { find: /^eve\/(channels|context|events)$/, replacement: source("../../src/public/$1/index.ts") },
  { find: /^eve\/internal\/channels$/, replacement: source("../../src/internal/channels.ts") },
];
