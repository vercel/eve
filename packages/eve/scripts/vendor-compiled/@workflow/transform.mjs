import { applySwcTransform, detectWorkflowPatterns } from "@workflow/builders";

/** Compile SDK classes before vendoring so both runtimes share native step and serde IDs. */
export function transformWorkflowSdk(mode) {
  return {
    name: `eve:compile-workflow-sdk-${mode}`,
    async transform(source, id) {
      const normalized = id.replaceAll("\\", "/");
      const marker = "/@workflow/core/";
      const offset = normalized.lastIndexOf(marker);
      if (offset < 0 || !normalized.endsWith(".js")) return null;
      const patterns = detectWorkflowPatterns(source);
      if (!patterns.hasUseStep && !patterns.hasUseWorkflow && !patterns.hasSerde) return null;
      const filename = `@workflow/core/${normalized.slice(offset + marker.length)}`;
      const result = await applySwcTransform(filename, source, mode, id);
      return { code: result.code, map: null };
    },
  };
}
