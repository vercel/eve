const EVE_NAMESPACE = "eve";

export function eveNamespaceReservation(name: string): string | undefined {
  return name === EVE_NAMESPACE || name.startsWith(`${EVE_NAMESPACE}__`)
    ? `eve reserves the "${EVE_NAMESPACE}" namespace for its built-in tools`
    : undefined;
}
