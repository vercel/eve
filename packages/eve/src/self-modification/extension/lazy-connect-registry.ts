import { replaceConnectionConnectorUid } from "#setup/scaffold/update/update-connection-connector.js";

const PROJECT_ID = /^prj_[A-Za-z0-9]+$/u;
const CONNECTOR_PART = /^[A-Za-z0-9._-]+$/u;
const CONNECTION_TARGET = /^agent\/connections\/([a-z][a-z0-9-]{0,63})\.ts$/u;

export function selfModificationLazyConnectName(target: string): string | undefined {
  return CONNECTION_TARGET.exec(target)?.[1];
}

/** Builds the stable connector UID used only by self-modification registry installs. */
export function selfModificationConnectorUid(name: string, projectId: string): string {
  if (!CONNECTOR_PART.test(name)) throw new Error("Invalid Vercel Connect connector name.");
  if (!PROJECT_ID.test(projectId)) throw new Error("Invalid Vercel project identifier.");
  return `${name}-${projectId}`;
}

/** Rewrites an authored connector placeholder to its lazy project-scoped connector. */
export function applySelfModificationLazyConnect(
  source: string,
  input: { readonly name: string; readonly projectId: string },
): string | undefined {
  return replaceConnectionConnectorUid(
    source,
    selfModificationConnectorUid(input.name, input.projectId),
    input.name,
  );
}
