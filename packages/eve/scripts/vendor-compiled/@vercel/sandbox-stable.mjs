import vercelSandbox from "./sandbox.mjs";

/** Preserve extension contract declarations while Drives uses the beta runtime. */
export default {
  ...vercelSandbox,
  packageName: "@vercel/sandbox",
  compiledPath: "@vercel/sandbox-stable",
  typeOnly: true,
};
