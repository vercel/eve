export interface Crossing {
  readonly carried: unknown;
}

export interface StepBoundary {
  send(value: unknown): Promise<Crossing>;
  receive(crossing: Crossing): Promise<unknown>;
}

export const structuredCloneBoundary: StepBoundary = {
  send: async (value) => ({ carried: structuredClone(value) }),
  receive: async ({ carried }) => structuredClone(carried),
};

export async function received<T>(boundary: StepBoundary, crossing: Crossing): Promise<T> {
  return (await boundary.receive(crossing)) as T;
}

export async function acrossStepBoundary<T>(boundary: StepBoundary, value: T): Promise<T> {
  return await received<T>(boundary, await boundary.send(value));
}
