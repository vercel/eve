import type { ProgrammaticModuleLoadContext } from "#compiler/source-graph.js";
import { createScheduleCollectionToolDynamicDefinition } from "#context/schedule-collection-tools.js";
import {
  getAuthoredModuleExport,
  materializeAuthoredModuleExport,
} from "#internal/authored-module.js";
import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import { defineDynamic } from "#dynamic/definition.js";
import { isScheduleCollectionDefinition } from "#shared/schedule-collection-definition.js";

export async function loadScheduleCollectionWrapperNamespace(
  context: ProgrammaticModuleLoadContext,
): Promise<Readonly<Record<string, unknown>>> {
  const application = context.parameters.application;
  const collection = context.parameters.collection;
  const logicalPath = context.parameters.collectionLogicalPath;
  const exportName = context.parameters.collectionExportName;
  const dependency = context.dependencies.collection;
  if (
    typeof application !== "string" ||
    typeof collection !== "string" ||
    typeof logicalPath !== "string" ||
    typeof exportName !== "string" ||
    dependency === undefined
  ) {
    throw new Error(
      "The compiled schedule collection wrapper is missing its selected collection source.",
    );
  }
  const value = await materializeAuthoredModuleExport(
    getAuthoredModuleExport(dependency, { exportName, logicalPath }),
  );
  if (!isScheduleCollectionDefinition(value)) {
    return { default: defineDynamic({ events: { "turn.started": () => null } }) };
  }
  const definition = normalizeScheduleCollectionDefinition(
    value,
    `Expected the schedule collection export "${exportName}" from "${logicalPath}" to be created with defineScheduleCollection().`,
  );
  return {
    default: createScheduleCollectionToolDynamicDefinition(definition, {
      application,
      collection,
    }),
  };
}
