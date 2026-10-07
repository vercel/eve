/**
 * The namespace of the tools eve adds to sessions itself, such as
 * `eve__search` and `eve__task_wait`.
 */
const EVE_NAMESPACE = "eve";

/**
 * Why `name` is taken, for errors to quote; undefined when the name is free.
 * Nothing authored or dynamic may be named `eve` or start with `eve__`: a
 * connection or extension named `eve` would own every `eve__` name.
 */
export function eveNamespaceReservation(name: string): string | undefined {
  return name === EVE_NAMESPACE || name.startsWith(`${EVE_NAMESPACE}__`)
    ? `eve reserves the "${EVE_NAMESPACE}" namespace for its built-in tools`
    : undefined;
}
