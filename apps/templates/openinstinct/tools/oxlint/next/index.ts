import { definePlugin } from "@oxlint/plugins";

import { noRoutePrivateImportsRule } from "./rules/no-route-private-imports.ts";
import { preferNearestRoutePrivateOwnerRule } from "./rules/prefer-nearest-route-private-owner.ts";
import { requireGeneratedRoutePropsRule } from "./rules/require-generated-route-props.ts";
import { requirePageRouteGroupRule } from "./rules/require-page-route-group.ts";

const plugin = definePlugin({
  meta: {
    name: "local-next",
  },
  rules: {
    "no-route-private-imports": noRoutePrivateImportsRule,
    "prefer-nearest-route-private-owner": preferNearestRoutePrivateOwnerRule,
    "require-generated-route-props": requireGeneratedRoutePropsRule,
    "require-page-route-group": requirePageRouteGroupRule,
  },
});

export default plugin;
