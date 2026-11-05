import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const fflateBrowser = join(dirname(require.resolve("fflate/package.json")), "esm", "browser.js");

const ZLIB_ID = "\0eve-just-bash-zlib";

// just-bash's browser bundle imports `node:zlib` for its gzip, gunzip, zcat and `rg -z` commands,
// which webpack and esbuild refuse in a browser build and Vite stubs out. Here it gets the same
// synchronous API from fflate (pure JS): eve's memory sandbox gzips in a page as it does in Node.
// `maxOutputLength` is checked after inflating, as Node's RangeError reports it.
const zlibFromFflate = {
  name: "eve-just-bash-zlib",
  resolveId(source) {
    return source === "node:zlib" || source === "zlib" ? ZLIB_ID : null;
  },
  load(id) {
    if (id !== ZLIB_ID) return null;
    return `
import { gunzipSync as gunzip, gzipSync as gzip } from ${JSON.stringify(fflateBrowser)};
export const constants = { Z_BEST_COMPRESSION: 9, Z_BEST_SPEED: 1, Z_DEFAULT_COMPRESSION: -1 };
function bounded(output, options) {
  const max = options?.maxOutputLength;
  if (max !== undefined && output.length > max) {
    throw new RangeError("Cannot create a Buffer larger than " + max + " bytes");
  }
  return output;
}
export function gunzipSync(data, options) {
  return bounded(gunzip(data), options);
}
export function gzipSync(data, options) {
  const level = options?.level;
  return bounded(gzip(data, level === undefined || level < 0 ? {} : { level }), options);
}
`;
  },
};

/**
 * just-bash's browser bundle for eve's in-memory sandbox (`eve/browser`'s `memorySandbox()`),
 * platform-neutral with no Node built-ins, so a page needs neither the optional `just-bash` peer
 * nor a bundler polyfill. Node hosts keep importing `just-bash` itself.
 */
export default {
  packageName: "just-bash",
  compiledPath: "just-bash/browser",
  bundling: "standalone",
  entry: "dist/bundle/browser.js",
  platform: "neutral",
  plugins: [zlibFromFflate],
  declaration: 'export * from "just-bash/browser";\n',
};
