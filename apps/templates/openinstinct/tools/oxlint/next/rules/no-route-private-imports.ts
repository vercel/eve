import path from "node:path";

import { defineRule } from "@oxlint/plugins";

import {
  findSourceDirectory,
  isWithin,
  normalizePath,
  PRIVATE_ROUTE_DIRECTORIES,
  resolveLocalImport,
  visitLocalImports,
} from "../helpers/next-app-router.ts";

export const noRoutePrivateImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep underscored App Router directories private to their route subtree.",
    },
    messages: {
      privateImport:
        "This route-private file belongs to '{{owner}}'. Promote it before importing it outside that subtree.",
    },
    schema: [],
  },
  createOnce(context) {
    let filename = "";
    let sourceDirectory = "";
    let appDirectory = "";

    return {
      before() {
        filename = normalizePath(context.filename);
        sourceDirectory = findSourceDirectory(filename, context.cwd);
        appDirectory = path.join(sourceDirectory, "app");
      },
      ...visitLocalImports((node, source) => {
        const target = resolveLocalImport(filename, source, sourceDirectory);
        if (!target || !isWithin(target, appDirectory)) return;

        const segments = path.relative(appDirectory, target).split(path.sep);
        const privateIndex = segments.findIndex((segment) =>
          PRIVATE_ROUTE_DIRECTORIES.has(segment)
        );

        if (privateIndex < 0) return;

        const owner = path.join(
          appDirectory,
          ...segments.slice(0, privateIndex)
        );
        if (!isWithin(filename, owner)) {
          context.report({
            node,
            messageId: "privateImport",
            data: {
              owner: path.relative(path.dirname(sourceDirectory), owner),
            },
          });
        }
      }),
    };
  },
});
