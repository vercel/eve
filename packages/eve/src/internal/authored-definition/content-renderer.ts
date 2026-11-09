import {
  assertContentRendererForm,
  type ContentRendererDefinition,
} from "#public/definitions/content-renderer.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

/** A content renderer export, checked: its media type and the functions it renders with. */
export function normalizeContentRenderer(
  value: unknown,
  source: Pick<ModuleSourceRef, "exportName" | "logicalPath">,
): ContentRendererDefinition {
  assertContentRendererForm(
    value,
    `The content renderer export "${source.exportName ?? "default"}" from "${source.logicalPath}"`,
  );
  return value;
}
