import type {
  EveDynamicToolPart,
  EveMessageData,
  EveMessagePart,
} from "#client/message-reducer.js";
import type { AgentTUIStreamEvent } from "./runner.js";

type ContentPart = Extract<EveMessagePart, { type: "text" | "reasoning" }>;
type Block = { part: ContentPart; turnId: string; id: string };

/** Adapts the default reducer's ordered runs to terminal block updates. */
export class TerminalMessageProjection {
  #blocks: Block[] = [];
  #generations = new Map<string, number>();
  #tools = new Map<string, EveDynamicToolPart>();
  #announcedTools = new Set<string>();

  announceTool(callId: string): void {
    this.#announcedTools.add(callId);
  }

  hasTool(callId: string): boolean {
    return this.#tools.has(callId);
  }

  /** Restores terminal identity after the stream translator is recreated. */
  restore(data: EveMessageData): void {
    for (const message of data.messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (part.type === "dynamic-tool" && part.toolMetadata?.eve?.kind === "tool-call") {
          this.announceTool(part.toolCallId);
        }
      }
    }
    // The adapter's own identity state is restored without replaying prior rows.
    for (const _ of this.transition(data)) {
      /* consume */
    }
    for (const _ of this.toolTransitions(data)) {
      /* consume */
    }
  }

  *transition(data: EveMessageData): Generator<AgentTUIStreamEvent> {
    const parts = data.messages.flatMap((message) =>
      message.role === "assistant"
        ? message.parts.flatMap((part) =>
            part.type === "text" || part.type === "reasoning"
              ? [{ part, turnId: message.metadata?.turnId ?? "" }]
              : [],
          )
        : [],
    );
    const next: Block[] = [];
    const removed = new Set(this.#blocks);
    for (const [index, { part, turnId }] of parts.entries()) {
      // Reference equality preserves identity when a null completion removes an
      // earlier run and shifts later runs to a different array position.
      const unchanged = this.#blocks.find(
        (block) => removed.has(block) && block.part === part && block.turnId === turnId,
      );
      const key = `${part.type}:${turnId}:${part.stepIndex}`;
      const atIndex = this.#blocks[index];
      const sameKey = (block: Block) =>
        block.part.type === part.type &&
        block.turnId === turnId &&
        block.part.stepIndex === part.stepIndex;
      const old =
        unchanged ??
        (atIndex && removed.has(atIndex) && sameKey(atIndex) ? atIndex : undefined) ??
        this.#blocks.findLast((block) => removed.has(block) && sameKey(block));
      const id = old
        ? old.id
        : (() => {
            const generation = this.#generations.get(key) ?? 0;
            this.#generations.set(key, generation + 1);
            return generation === 0 ? key : `${key}#${generation}`;
          })();
      next.push({ part, turnId, id });
      if (old) removed.delete(old);
      if (unchanged) continue;
      const deltaType = part.type === "text" ? "assistant-delta" : "reasoning-delta";
      const completeType = part.type === "text" ? "assistant-complete" : "reasoning-complete";
      if (!old || old.id !== id) {
        if (part.state === "done") yield { type: completeType, id, text: part.text };
        else if (part.text) yield { type: deltaType, id, delta: part.text };
        continue;
      }
      const replaced = part.text !== old.part.text && !part.text.startsWith(old.part.text);
      if (part.text !== old.part.text) {
        if (part.text.startsWith(old.part.text) && old.part.state !== "done") {
          const delta = part.text.slice(old.part.text.length);
          if (delta) yield { type: deltaType, id, delta };
        } else {
          yield { type: completeType, id, text: part.text };
        }
      }
      if (part.state === "done" && old.part.state !== "done" && !replaced) {
        yield { type: completeType, id };
      }
    }
    for (const old of removed) {
      if (old.part.type === "text") yield { type: "assistant-remove", id: old.id };
    }
    this.#blocks = next;
  }

  *finish(): Generator<AgentTUIStreamEvent> {
    for (const block of this.#blocks) {
      if (block.part.state === "done" || block.part.text.length === 0) continue;
      yield block.part.type === "text"
        ? { type: "assistant-complete", id: block.id }
        : { type: "reasoning-complete", id: block.id };
    }
  }

  *toolTransitions(data: EveMessageData): Generator<AgentTUIStreamEvent> {
    for (const message of data.messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (part.type !== "dynamic-tool" || part.toolMetadata?.eve?.kind !== "tool-call") continue;
        if (part.toolMetadata.eve.inputRequest?.kind === "session-limit") continue;
        const old = this.#tools.get(part.toolCallId);
        // Tool results without an announced call do not have a terminal block.
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
