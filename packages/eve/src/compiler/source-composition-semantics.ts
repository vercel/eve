import { assertCompiledSourceBackingSemantics } from "#compiler/module-binding-semantics.js";
import type { AgentSourceDescriptor } from "#compiler/source-composition.js";

/** Validates provenance relationships carried by one retained source descriptor. */
export function assertAgentSourceDescriptorSemantics(input: {
  readonly descriptor: AgentSourceDescriptor;
  readonly nodeId: string;
}): void {
  const { descriptor } = input;
  const expectedOwnerKind =
    descriptor.layer === "framework-default"
      ? "framework"
      : descriptor.layer === "extension-package"
        ? "extension"
        : "application";

  if (descriptor.owner.kind !== expectedOwnerKind) {
    throw new Error(
      `Compiled node "${input.nodeId}" source "${descriptor.sourceId}" records layer "${descriptor.layer}" with owner kind "${descriptor.owner.kind}" instead of "${expectedOwnerKind}".`,
    );
  }

  if ("backing" in descriptor) {
    assertCompiledSourceBackingSemantics({
      backing: descriptor.backing,
      nodeId: input.nodeId,
      owner: descriptor.owner,
      sourceId: descriptor.sourceId,
    });
  }
}
