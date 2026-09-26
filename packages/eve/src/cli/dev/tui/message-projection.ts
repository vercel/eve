import type { EveDynamicToolPart, EveMessageData } from "#client/message-reducer.js";
import type { AgentTUIStreamEvent } from "./runner.js";
import { isTerminalToolCallPart } from "./terminal-tool-part.js";

/** Reconciles announced tool calls with the conversation's tool parts. */
export class TerminalToolProjection {
  #tools = new Map<string, EveDynamicToolPart>();
  #announcedTools = new Set<string>();

  announceTool(callId: string): void {
    this.#announcedTools.add(callId);
  }

  hasTool(callId: string): boolean {
    return this.#tools.has(callId);
  }

  restore(data: EveMessageData): void {
    for (const message of data.messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (isTerminalToolCallPart(part)) this.announceTool(part.toolCallId);
      }
    }
    for (const _ of this.transitions(data)) {
      // Previously rendered tool rows belong to an earlier stream pass.
    }
  }

  *transitions(data: EveMessageData): Generator<AgentTUIStreamEvent> {
    for (const message of data.messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (!isTerminalToolCallPart(part)) continue;
        if (part.toolMetadata?.eve?.inputRequest?.kind === "session-limit") continue;
        const old = this.#tools.get(part.toolCallId);
        if (!this.#announcedTools.has(part.toolCallId)) continue;
        if (old === part) continue;
        this.#tools.set(part.toolCallId, part);
        if (!old) {
          yield {
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          };
        }
        if (part.state === "approval-requested" && old?.approval?.id !== part.approval.id) {
          yield {
            type: "tool-approval-request",
            approvalId: part.approval.id,
            toolCallId: part.toolCallId,
          };
        }
        if (
          part.state === "output-available" &&
          !part.partial &&
          (old?.state !== "output-available" || old.partial === true)
        ) {
          yield { type: "tool-result", toolCallId: part.toolCallId, output: part.output };
        } else if (part.state === "output-error" && old?.state !== "output-error") {
          yield { type: "tool-error", toolCallId: part.toolCallId, errorText: part.errorText };
        } else if (part.state === "output-denied" && old?.state !== "output-denied") {
          yield {
            type: "tool-rejected",
            toolCallId: part.toolCallId,
            reason: part.approval.reason ?? "Tool execution was cancelled.",
          };
        }
      }
    }
  }
}
