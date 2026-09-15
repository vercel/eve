const CONNECT_LITERAL = /\bconnect\(\s*(["'`])([^"'`]+)\1\s*\)/u;
const PROJECT_ID = /^prj_[A-Za-z0-9]+$/u;
const CONNECTOR_PART = /^[A-Za-z0-9._-]+$/u;
const CONNECTION_TARGET = /^agent\/connections\/[a-z][a-z0-9-]{0,63}\.ts$/u;

export interface SelfModificationLazyConnect {
  readonly canonicalName: string;
  readonly service: string;
}

export function isSelfModificationLazyConnectTarget(target: string): boolean {
  return CONNECTION_TARGET.test(target);
}

/** Builds the stable connector UID used only by self-modification registry installs. */
export function selfModificationConnectorUid(name: string, projectId: string): string {
  if (!CONNECTOR_PART.test(name)) throw new Error("Invalid Vercel Connect connector name.");
  if (!PROJECT_ID.test(projectId)) throw new Error("Invalid Vercel project identifier.");
  return `${name}-${projectId}`;
}

/** Rewrites the registry-authored connector placeholder to a lazy project-scoped connector. */
export function applySelfModificationLazyConnect(
  source: string,
  input: SelfModificationLazyConnect & { readonly projectId: string },
): string | undefined {
  const match = CONNECT_LITERAL.exec(source);
  if (match?.[2] !== input.canonicalName) return undefined;
  if (!CONNECTOR_PART.test(input.service)) {
    throw new Error("Invalid Vercel Connect service identifier.");
  }
  const connector = selfModificationConnectorUid(input.canonicalName, input.projectId);
  return source.replace(
    CONNECT_LITERAL,
    `connect({ connector: ${JSON.stringify(connector)}, autoProvision: true })`,
  );
}
