import path from "node:path";

import { defineRule } from "@oxlint/plugins";

import {
  hasDescendantPage,
  normalizePath,
} from "../helpers/next-app-router.ts";

export const requirePageRouteGroupRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Give index pages in nested routers an explicit pathless route-group owner.",
    },
    messages: {
      missingRouteGroup:
        "This route also has child pages. Move this page and its private folders into a pathless route group such as '(overview)' so their ownership is explicit.",
    },
    schema: [],
  },
  createOnce(context) {
    let owner = "";

    return {
      before() {
        const filename = normalizePath(context.filename);
        if (!/^page\.[jt]sx?$/.test(path.basename(filename))) return false;

        owner = path.dirname(filename);
        return !/^\(.+\)$/.test(path.basename(owner));
      },
      Program(node) {
        if (hasDescendantPage(owner)) {
          context.report({ node, messageId: "missingRouteGroup" });
        }
      },
    };
  },
});
