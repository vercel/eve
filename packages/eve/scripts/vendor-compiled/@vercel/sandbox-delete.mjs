import vercelSandbox from "./sandbox.mjs";

/** Vendor the stable SDK version that owns orphan-snapshot deletion. */
export default {
  ...vercelSandbox,
  packageName: "@vercel/sandbox-delete",
  compiledPath: "@vercel/sandbox-delete",
};
