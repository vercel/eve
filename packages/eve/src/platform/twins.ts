// The platform twins, and the check that keeps them twins.
//
// Each module here is a pair: `x.ts` for Node and `x.web.ts` for a browser or Web Worker. The
// package's `#platform/*` imports pick one by the `node` condition, at build time and in every
// consumer's bundler; nothing probes the runtime. TypeScript resolves `#platform/x.js` to the Node
// twin (`customConditions: ["eve-source"]`), so callers are checked against `x.ts` only. This
// module is the check for the other side: each web twin must export everything its Node twin does,
// with types the Node twin's callers accept. A twin that drifts fails `tsc` here.
//
// Two kinds of module share this mechanism, because it's the only place the condition applies:
// - platform primitives, with no eve imports: async-storage, deep-equal, delay, env, host-bytes,
//   host-path, inflate, inspect, posix-path, sha256, uuid;
// - host features with a browser default, which import upward into eve: compiled-agents,
//   default-sandbox, development-sandboxes, local-gateway, package-info, public-fetch,
//   sandbox-cache.

import type * as AsyncStorage from "./async-storage.js";
import type * as AsyncStorageWeb from "./async-storage.web.js";
import type * as CompiledAgents from "./compiled-agents.js";
import type * as CompiledAgentsWeb from "./compiled-agents.web.js";
import type * as DeepEqual from "./deep-equal.js";
import type * as DeepEqualWeb from "./deep-equal.web.js";
import type * as DefaultSandbox from "./default-sandbox.js";
import type * as DefaultSandboxWeb from "./default-sandbox.web.js";
import type * as Delay from "./delay.js";
import type * as DelayWeb from "./delay.web.js";
import type * as DevelopmentSandboxes from "./development-sandboxes.js";
import type * as DevelopmentSandboxesWeb from "./development-sandboxes.web.js";
import type * as Env from "./env.js";
import type * as EnvWeb from "./env.web.js";
import type * as HostBytes from "./host-bytes.js";
import type * as HostBytesWeb from "./host-bytes.web.js";
import type * as HostPath from "./host-path.js";
import type * as HostPathWeb from "./host-path.web.js";
import type * as Inflate from "./inflate.js";
import type * as InflateWeb from "./inflate.web.js";
import type * as Inspect from "./inspect.js";
import type * as InspectWeb from "./inspect.web.js";
import type * as LocalGateway from "./local-gateway.js";
import type * as LocalGatewayWeb from "./local-gateway.web.js";
import type * as PackageInfo from "./package-info.js";
import type * as PackageInfoWeb from "./package-info.web.js";
import type * as PosixPath from "./posix-path.js";
import type * as PosixPathWeb from "./posix-path.web.js";
import type * as PublicFetch from "./public-fetch.js";
import type * as PublicFetchWeb from "./public-fetch.web.js";
import type * as SandboxCache from "./sandbox-cache.js";
import type * as SandboxCacheWeb from "./sandbox-cache.web.js";
import type * as Sha256 from "./sha256.js";
import type * as Sha256Web from "./sha256.web.js";
import type * as Uuid from "./uuid.js";
import type * as UuidWeb from "./uuid.web.js";

/** `Web` offers everything `Node` does, as `Node`'s callers use it. */
type Twin<Web extends Node, Node> = [Web, Node];

export type PlatformTwins = [
  Twin<typeof AsyncStorageWeb, typeof AsyncStorage>,
  Twin<typeof CompiledAgentsWeb, typeof CompiledAgents>,
  Twin<typeof DeepEqualWeb, typeof DeepEqual>,
  Twin<typeof DefaultSandboxWeb, typeof DefaultSandbox>,
  Twin<typeof DelayWeb, typeof Delay>,
  Twin<typeof DevelopmentSandboxesWeb, typeof DevelopmentSandboxes>,
  Twin<typeof EnvWeb, typeof Env>,
  Twin<typeof HostBytesWeb, typeof HostBytes>,
  Twin<typeof HostPathWeb, typeof HostPath>,
  Twin<typeof InflateWeb, typeof Inflate>,
  Twin<typeof InspectWeb, typeof Inspect>,
  Twin<typeof LocalGatewayWeb, typeof LocalGateway>,
  Twin<typeof PackageInfoWeb, typeof PackageInfo>,
  Twin<typeof PosixPathWeb, typeof PosixPath>,
  Twin<typeof PublicFetchWeb, typeof PublicFetch>,
  Twin<typeof SandboxCacheWeb, typeof SandboxCache>,
  Twin<typeof Sha256Web, typeof Sha256>,
  Twin<typeof UuidWeb, typeof Uuid>,
];
