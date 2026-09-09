import vercelSandboxDrives from "./sandbox-drives.mjs";

/** Vendor stable Sandbox for public types and orphan-snapshot deletion. */
export default {
  ...vercelSandboxDrives,
  packageName: "@vercel/sandbox",
  compiledPath: "@vercel/sandbox",
};
