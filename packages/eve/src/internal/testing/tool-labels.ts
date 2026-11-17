export function labelCallbacks<T extends object>(label: T | false | undefined): T | undefined {
  return label === false ? undefined : label;
}
