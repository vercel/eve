import { classifyCatalogEntry } from "./classify-registry-item.js";
import {
  applySelfModificationLazyConnect,
  selfModificationConnectorUid,
  selfModificationLazyConnectName,
} from "./lazy-connect-registry.js";
import type { CatalogEntry } from "./tools/search_registry.js";

export interface RegistrySourceTransform {
  readonly target: string;
  apply(source: string): string | undefined;
}

export type SelfModificationRegistryInstallPlan =
  | { readonly kind: "install" }
  | { readonly kind: "requires-user-setup"; readonly reason: string }
  | { readonly kind: "install-with-transform"; readonly transform: RegistrySourceTransform };

/** Chooses how self-modification may install one registry item without performing mutations. */
export function planSelfModificationRegistryInstall(input: {
  readonly createConnectorUid?: (name: string) => string;
  readonly entry: CatalogEntry;
  readonly setupHandling: "execute" | "requires-user-setup";
}): SelfModificationRegistryInstallPlan {
  const classification = classifyCatalogEntry(input.entry);
  const fallback: SelfModificationRegistryInstallPlan =
    classification.kind === "installable" || input.setupHandling === "execute"
      ? { kind: "install" }
      : { kind: "requires-user-setup", reason: classification.reason };
  if (input.entry.selfModification?.lazyConnect !== true) return fallback;

  const target = input.entry.authoredTarget;
  const name = target === undefined ? undefined : selfModificationLazyConnectName(target);
  if (target === undefined || name === undefined) return fallback;

  const connectorUid = (input.createConnectorUid ?? selfModificationConnectorUid)(name);
  return {
    kind: "install-with-transform",
    transform: {
      target,
      apply: (source) => applySelfModificationLazyConnect(source, { connectorUid, name }),
    },
  };
}
