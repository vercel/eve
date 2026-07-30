/** Builds a project- and type-qualified name for a Vercel Connect connector. */
export function connectConnectorName(
  projectSlug: string,
  service: string,
  connectionSlug?: string,
): string {
  const type = service.split(".", 1)[0];
  if (type === undefined || type.length === 0) {
    throw new Error(`Invalid Connect service "${service}".`);
  }
  return connectionSlug === undefined
    ? `${projectSlug}-${type}`
    : `${projectSlug}-${connectionSlug}-${type}`;
}
