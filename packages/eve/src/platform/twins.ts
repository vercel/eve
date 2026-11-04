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
// - platform primitives, with no eve imports: posix-path, sha256, uuid;
// - host features with a browser default, which import upward into eve: development-sandboxes,
//   package-info.

import type * as DevelopmentSandboxes from "./development-sandboxes.js";
import type * as DevelopmentSandboxesWeb from "./development-sandboxes.web.js";
import type * as PackageInfo from "./package-info.js";
import type * as PackageInfoWeb from "./package-info.web.js";
import type * as PosixPath from "./posix-path.js";
import type * as PosixPathWeb from "./posix-path.web.js";
import type * as Sha256 from "./sha256.js";
import type * as Sha256Web from "./sha256.web.js";
import type * as Uuid from "./uuid.js";
import type * as UuidWeb from "./uuid.web.js";

/** `Web` offers everything `Node` does, as `Node`'s callers use it. */
type Twin<Web extends Node, Node> = [Web, Node];

export type PlatformTwins = [
  Twin<typeof DevelopmentSandboxesWeb, typeof DevelopmentSandboxes>,
  Twin<typeof PackageInfoWeb, typeof PackageInfo>,
  Twin<typeof PosixPathWeb, typeof PosixPath>,
  Twin<typeof Sha256Web, typeof Sha256>,
  Twin<typeof UuidWeb, typeof Uuid>,
];
