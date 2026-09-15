import { randomUUID } from "node:crypto";

import { replaceConnectionConnectorUid } from "#setup/scaffold/update/update-connection-connector.js";

const CONNECTOR_PART = /^[A-Za-z0-9._-]+$/u;
const CONNECTION_TARGET = /^agent\/connections\/([a-z][a-z0-9-]{0,63})\.ts$/u;

export function selfModificationLazyConnectName(target: string): string | undefined {
  return CONNECTION_TARGET.exec(target)?.[1];
}

/** Builds a stable-in-source, collision-resistant UID without binding to a project. */
export function selfModificationConnectorUid(
  name: string,
  createId: () => string = randomUUID,
): string {
  if (!CONNECTOR_PART.test(name)) throw new Error("Invalid Vercel Connect connector name.");
  const id = createId();
  if (!CONNECTOR_PART.test(id)) throw new Error("Invalid Vercel Connect connector identifier.");
  return `${name}-${id}`;
}

/** Rewrites an authored connector placeholder to its lazy connector UID. */
export function applySelfModificationLazyConnect(
  source: string,
  input: { readonly connectorUid: string; readonly name: string },
): string | undefined {
  return replaceConnectionConnectorUid(source, input.connectorUid, input.name);
}
