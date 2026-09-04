import type { ContextContainer } from "#context/container.js";
import { dispatchBeforeResponseReleaseHooks } from "#context/hook-lifecycle.js";
import type { ToolLoopHarnessConfig } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeHookRegistry } from "#runtime/hooks/registry.js";

/** Holds terminal content while authored hooks inspect the settling turn. */
export class ResponseReleaseEventGate {
  private readonly ctx: ContextContainer;
  private readonly registry: RuntimeHookRegistry;
  private readonly supported: boolean;
  private releasing = false;
  private terminalEvent: UnstampedMessageStreamEvent | undefined;

  constructor(ctx: ContextContainer, registry: RuntimeHookRegistry, supported = true) {
    this.ctx = ctx;
    this.registry = registry;
    this.supported = supported;
  }

  get enabled(): boolean {
    return this.supported && this.registry.beforeResponseRelease.length > 0;
  }

  /** Returns true when the terminal event was withheld from ordinary delivery. */
  intercept(event: UnstampedMessageStreamEvent): boolean {
    if (
      this.releasing ||
      !this.enabled ||
      event.type !== "message.completed" ||
      event.data.finishReason === "tool-calls"
    ) {
      return false;
    }
    this.terminalEvent = event;
    return true;
  }

  beforeRelease(
    release: (event: UnstampedMessageStreamEvent) => Promise<void>,
  ): NonNullable<ToolLoopHarnessConfig["beforeResponseRelease"]> | undefined {
    if (!this.enabled) return undefined;
    return async (candidate) => {
      const decision = await dispatchBeforeResponseReleaseHooks({
        candidate: {
          history: candidate.history,
          output: candidate.output,
          turnId: candidate.turnId,
        },
        ctx: this.ctx,
        registry: this.registry,
      });
      if (decision === "skip") {
        this.terminalEvent = undefined;
        return "skip";
      }
      if (this.terminalEvent !== undefined) {
        const terminalEvent = this.terminalEvent;
        this.terminalEvent = undefined;
        this.releasing = true;
        try {
          await release(terminalEvent);
        } finally {
          this.releasing = false;
        }
      }
      return undefined;
    };
  }
}
