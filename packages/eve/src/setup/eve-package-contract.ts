import { resolveVersionToken } from "./scaffold/version-tokens.js";

/** The eve package metadata that generated projects and local diagnostics consume together. */
export interface EvePackageContract {
  /** eve dependency version or npm specifier written to the generated package. */
  version: string;
  /** The matching eve release's authored `package.json` `engines.node` value. */
  nodeEngine: string;
}

export const DEFAULT_EVE_PACKAGE_CONTRACT: EvePackageContract = {
  version: "__EVE_PACKAGE_DEPENDENCY_VERSION__",
  nodeEngine: "__NODE_ENGINE__",
};

/** Resolves a stamped or explicitly supplied eve package contract. */
export function resolveEvePackageContract(
  contract: EvePackageContract = DEFAULT_EVE_PACKAGE_CONTRACT,
): EvePackageContract {
  return {
    version: resolveVersionToken("evePackage.version", contract.version),
    nodeEngine: resolveVersionToken("evePackage.nodeEngine", contract.nodeEngine),
  };
}
