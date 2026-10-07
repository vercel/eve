import type { AlsContext } from "#context/container.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";
import type { EveAttributeValue } from "#runtime/attributes/normalize.js";

export interface StepAttributeWriter {
  enqueue(attributes: Record<string, EveAttributeValue>): void;
  flush(): Promise<void>;
  write(attributes: Record<string, EveAttributeValue>): Promise<void>;
}

const writers = new WeakMap<AlsContext, StepAttributeWriter>();

export function createStepAttributeWriter(): StepAttributeWriter {
  let pending = Promise.resolve();
  const write = (attributes: Record<string, EveAttributeValue>): Promise<void> => {
    pending = pending.then(async () => {
      await setEveAttributes(attributes);
    });
    return pending;
  };
  return {
    enqueue(attributes): void {
      void write(attributes).catch(() => {});
    },
    async flush(): Promise<void> {
      await pending;
    },
    write,
  };
}

export function bindStepAttributeWriter(ctx: AlsContext, writer: StepAttributeWriter): void {
  writers.set(ctx, writer);
}

export function stepAttributeWriter(ctx: AlsContext): StepAttributeWriter | undefined {
  return writers.get(ctx);
}
