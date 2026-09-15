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
  | { readonly kind: "cannot-install"; readonly message: string }
  | { readonly kind: "install-with-transform"; readonly transform: RegistrySourceTransform };

/** Whether planning this item requires resolving the consuming Vercel project. */
export function selfModificationRegistryInstallNeedsProject(entry: CatalogEntry): boolean {
  return entry.selfModification?.lazyConnect === true;
}

/** Chooses how self-modification may install one registry item without performing mutations. */
export function planSelfModificationRegistryInstall(input: {
  readonly entry: CatalogEntry;
  readonly missingProject: "cannot-install" | "requires-user-setup";
  readonly projectId?: string;
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
  const projectId = input.projectId;
  if (projectId === undefined) {
    return missingProject(input.entry, fallback, input.missingProject);
  }

  try {
    selfModificationConnectorUid(name, projectId);
  } catch {
    return missingProject(input.entry, fallback, input.missingProject);
  }

  return {
    kind: "install-with-transform",
    transform: {
      target,
      apply: (source) => applySelfModificationLazyConnect(source, { name, projectId }),
    },
  };
}

function missingProject(
  entry: CatalogEntry,
  fallback: SelfModificationRegistryInstallPlan,
  behavior: "cannot-install" | "requires-user-setup",
): SelfModificationRegistryInstallPlan {
  if (behavior === "requires-user-setup" && fallback.kind === "requires-user-setup") {
    return fallback;
  }
  return {
    kind: "cannot-install",
    message: `${entry.title} requires a verified Vercel project before self-modification can configure lazy Connect provisioning.`,
  };
}
