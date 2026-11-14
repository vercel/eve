import path from "node:path";

import { defineRule } from "@oxlint/plugins";

import {
  findSourceDirectory,
  getAppImportGraph,
  getCommonDirectory,
  getConsumerRouteOwners,
  isWithin,
  normalizePath,
  PRIVATE_ROUTE_DIRECTORIES,
} from "../helpers/next-app-router.ts";

export const preferNearestRoutePrivateOwnerRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Colocate App Router private files with their nearest shared route owner.",
    },
    messages: {
      broadOwner:
        "This route-private file is only consumed by '{{consumer}}'. Move it from '{{owner}}' to that route subtree.",
    },
    schema: [],
  },
  createOnce(context) {
    let filename = "";
    let sourceDirectory = "";
    let appDirectory = "";
    let relativeSegments: string[] = [];
    let privateIndex = -1;

    return {
      before() {
        filename = normalizePath(context.filename);
        sourceDirectory = findSourceDirectory(filename, context.cwd);
        appDirectory = path.join(sourceDirectory, "app");
        if (!isWithin(filename, appDirectory)) return false;

        relativeSegments = path
          .relative(appDirectory, filename)
          .split(path.sep);
        privateIndex = relativeSegments.findIndex((segment) =>
          PRIVATE_ROUTE_DIRECTORIES.has(segment)
        );
        return privateIndex >= 0;
      },
      Program(node) {
        const importGraph = getAppImportGraph(appDirectory, sourceDirectory);
        const consumerOwners = getConsumerRouteOwners(
          filename,
          importGraph,
          appDirectory
        );
        if (!consumerOwners.length) return;

        const owner = path.join(
          appDirectory,
          ...relativeSegments.slice(0, privateIndex)
        );
        const consumer = getCommonDirectory(consumerOwners);
        if (!consumer || normalizePath(consumer) === normalizePath(owner))
          return;
        if (!isWithin(consumer, owner)) return;

        context.report({
          node,
          messageId: "broadOwner",
          data: {
            consumer: path.relative(appDirectory, consumer) || "app",
            owner: path.relative(appDirectory, owner) || "app",
          },
        });
      },
    };
  },
});
