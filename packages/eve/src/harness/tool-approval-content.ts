import type { ToolApprovalContent } from "#public/tools/approval/content.js";
import { toolApprovalContentSchema } from "#shared/tool-approval-content-schema.js";

const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

/** Per-model-attempt storage joining authored approval results to SDK approval requests. */
export class ToolApprovalContentCollector {
  readonly #contents = new Map<string, ToolApprovalContent>();

  get(callId: string): ToolApprovalContent | undefined {
    return this.#contents.get(callId);
  }

  set(callId: string, value: unknown): void {
    const content = toolApprovalContentSchema.parse(value) as ToolApprovalContent;
    const bytes = new TextEncoder().encode(JSON.stringify(content)).byteLength;
    if (bytes > MAX_CONTENT_BYTES) {
      throw new Error(`Tool approval content exceeds the ${MAX_CONTENT_BYTES}-byte payload limit.`);
    }
    this.#contents.set(callId, content);
  }
}
