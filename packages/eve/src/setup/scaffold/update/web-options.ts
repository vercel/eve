import { DEFAULT_EVE_PACKAGE_CONTRACT, type EvePackageContract } from "../create/project.js";

const DEFAULT_AI_PACKAGE_VERSION = "__AI_SDK_VERSION__";
const DEFAULT_BETTER_AUTH_PACKAGE_VERSION = "__BETTER_AUTH_VERSION__";
const DEFAULT_NEXT_PACKAGE_VERSION = "__NEXT_VERSION__";
const DEFAULT_SIGN_IN_WITH_VERCEL_NEXT_PACKAGE_VERSION = "16.3.0";
const DEFAULT_REACT_PACKAGE_VERSION = "__REACT_VERSION__";
const DEFAULT_REACT_DOM_PACKAGE_VERSION = "__REACT_DOM_VERSION__";
const DEFAULT_STREAMDOWN_PACKAGE_VERSION = "__STREAMDOWN_VERSION__";
const DEFAULT_ZOD_PACKAGE_VERSION = "__ZOD_VERSION__";
const DEFAULT_TYPES_REACT_PACKAGE_VERSION = "__TYPES_REACT_VERSION__";
const DEFAULT_TYPES_REACT_DOM_PACKAGE_VERSION = "__TYPES_REACT_DOM_VERSION__";

export type WebAuthentication = "sign-in-with-vercel";

export interface WebPackageVersions {
  evePackage?: EvePackageContract;
  aiPackageVersion?: string;
  betterAuthPackageVersion?: string;
  nextPackageVersion?: string;
  reactPackageVersion?: string;
  reactDomPackageVersion?: string;
  streamdownPackageVersion?: string;
  zodPackageVersion?: string;
  typesReactPackageVersion?: string;
  typesReactDomPackageVersion?: string;
}

export function resolveWebPackageVersions(
  input: WebPackageVersions | undefined,
  authentication?: WebAuthentication,
): Required<WebPackageVersions> {
  return {
    evePackage: input?.evePackage ?? DEFAULT_EVE_PACKAGE_CONTRACT,
    aiPackageVersion: input?.aiPackageVersion ?? DEFAULT_AI_PACKAGE_VERSION,
    betterAuthPackageVersion:
      input?.betterAuthPackageVersion ?? DEFAULT_BETTER_AUTH_PACKAGE_VERSION,
    nextPackageVersion:
      input?.nextPackageVersion ??
      (authentication === "sign-in-with-vercel"
        ? DEFAULT_SIGN_IN_WITH_VERCEL_NEXT_PACKAGE_VERSION
        : DEFAULT_NEXT_PACKAGE_VERSION),
    reactPackageVersion: input?.reactPackageVersion ?? DEFAULT_REACT_PACKAGE_VERSION,
    reactDomPackageVersion: input?.reactDomPackageVersion ?? DEFAULT_REACT_DOM_PACKAGE_VERSION,
    streamdownPackageVersion: input?.streamdownPackageVersion ?? DEFAULT_STREAMDOWN_PACKAGE_VERSION,
    zodPackageVersion: input?.zodPackageVersion ?? DEFAULT_ZOD_PACKAGE_VERSION,
    typesReactPackageVersion:
      input?.typesReactPackageVersion ?? DEFAULT_TYPES_REACT_PACKAGE_VERSION,
    typesReactDomPackageVersion:
      input?.typesReactDomPackageVersion ?? DEFAULT_TYPES_REACT_DOM_PACKAGE_VERSION,
  };
}
