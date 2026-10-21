/**
 * Returns a view of `session` where `overrides` take precedence and every
 * other member still reaches `session`: reads, assignments, and its
 * prototype, so `instanceof` against a provider's session class holds.
 *
 * A proxy rather than an object spread, because a spread copies only own
 * properties and drops methods a provider session defines on its class.
 */
export function overrideSandboxSession<Session extends object, Overrides extends object>(
  session: Session,
  overrides: Overrides,
): Session & Overrides {
  const isOverridden = (property: PropertyKey) => Object.hasOwn(overrides, property);
  return new Proxy(Object.create(null) as object, {
    get(_proxyTarget, property) {
      if (isOverridden(property)) return Reflect.get(overrides, property);
      const value = Reflect.get(session, property, session);
      return typeof value === "function" ? value.bind(session) : value;
    },
    set(_proxyTarget, property, value) {
      return !isOverridden(property) && Reflect.set(session, property, value, session);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(session);
    },
    getOwnPropertyDescriptor(_proxyTarget, property) {
      if (isOverridden(property)) {
        const value: unknown = Reflect.get(overrides, property);
        return { configurable: true, enumerable: true, value, writable: false };
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(session, property);
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
    },
    has(_proxyTarget, property) {
      return isOverridden(property) || Reflect.has(session, property);
    },
    ownKeys() {
      return [...new Set([...Reflect.ownKeys(session), ...Reflect.ownKeys(overrides)])];
    },
  }) as Session & Overrides;
}
