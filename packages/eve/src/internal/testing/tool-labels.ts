/** A tool's label callbacks, or `undefined` when it defines none or sets `label: false`. */
export function labelCallbacks<T extends object>(label: T | false | undefined): T | undefined {
  return label === false ? undefined : label;
}
