export type Reducer = (value: unknown) => unknown;
export type Reviver = (value: unknown) => unknown;

export function stringify(value: unknown, reducers?: Record<string, Reducer>): string;
export function parse(serialized: string, revivers?: Record<string, Reviver>): unknown;
