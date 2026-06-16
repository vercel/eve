// Static "use step" stub required by `WorkflowBundleBuilder` so vitest-side
// workflow bundles always have at least one discoverable step. Referenced
// from `workflow-global-setup.ts`; nothing imports it at runtime.
export async function __eveInstallCompiledArtifactsStep() {
  "use step";
  return null;
}
