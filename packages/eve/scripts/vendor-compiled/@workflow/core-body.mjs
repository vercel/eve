import { transformWorkflowSdk } from "./transform.mjs";

export default {
  packageName: "@workflow/core",
  compiledPath: "@workflow/core-body",
  entry: "dist/workflow/index.js",
  bundling: "standalone",
  platform: "neutral",
  resolve: { conditionNames: ["workflow"], mainFields: ["module", "main"] },
  plugins: [transformWorkflowSdk("workflow")],
  declaration: 'export * from "../core/workflow/index.js";\n',
};
