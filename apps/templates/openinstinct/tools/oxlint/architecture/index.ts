import { definePlugin } from "@oxlint/plugins";

import { noForbiddenLayerImportsRule } from "./rules/no-forbidden-layer-imports.ts";

const plugin = definePlugin({
  meta: {
    name: "local-architecture",
  },
  rules: {
    "no-forbidden-layer-imports": noForbiddenLayerImportsRule,
  },
});

export default plugin;
