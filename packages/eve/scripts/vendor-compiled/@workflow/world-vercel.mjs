export default {
  packageName: "@workflow/world-vercel",
  compiledPath: "@workflow/world-vercel",
  chunkGroup: "workflow",
  declaration: `import type { World } from "#compiled/@workflow/world/index.js";
export declare function createQueue(): Pick<World,
  "queue" | "queueBatch" | "createQueueHandler" | "getDeploymentId" | "isDeploymentUnavailableError"
>;
`,
};
