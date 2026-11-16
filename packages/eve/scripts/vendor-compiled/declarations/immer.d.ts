/** The parts of immer eve uses: drafts are writable views of a frozen value. */
export type Draft<T> = T extends readonly (infer E)[]
  ? Draft<E>[]
  : T extends object
    ? { -readonly [K in keyof T]: Draft<T[K]> }
    : T;

export function produce<T>(base: T, recipe: (draft: Draft<T>) => void): T;
export function freeze<T>(value: T, deep?: boolean): T;
export function isDraftable(value: unknown): boolean;
