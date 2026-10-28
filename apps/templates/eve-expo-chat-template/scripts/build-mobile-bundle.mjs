// Export the Expo client so each deployment can serve it to Expo Go from /start/mobile.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const mobile = join(root, "apps/mobile");
const output = join(root, ".eve/mobile-export");
const env = { ...process.env, EXPO_OFFLINE: "1", EXPO_NO_TELEMETRY: "1", CI: "1" };
const expo = (args, options = {}) =>
  execFileSync("pnpm", ["exec", "expo", ...args], {
    cwd: mobile,
    env,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });

await rm(output, { recursive: true, force: true });
expo(["export", "--platform", "ios", "--platform", "android", "--output-dir", output], {
  stdio: "inherit",
});
const config = JSON.parse(expo(["config", "--type", "public", "--json"], { encoding: "utf8" }));
const metadata = JSON.parse(await readFile(join(output, "metadata.json"), "utf8"));
const types = {
  ttf: "font/ttf",
  otf: "font/otf",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
};
const files = {};
const add = async (path, contentType) => {
  const body = await readFile(join(output, path));
  const file = createHash("sha256").update(body).digest("hex");
  files[file] = { contentType, body: body.toString("base64") };
  return { file, hash: createHash("sha256").update(body).digest("base64url") };
};
const platforms = {};
for (const platform of ["ios", "android"]) {
  const entry = metadata.fileMetadata?.[platform];
  if (!entry?.bundle) throw Error("Expo export did not produce a " + platform + " bundle.");
  platforms[platform] = {
    bundle: await add(entry.bundle, "application/javascript"),
    assets: await Promise.all(
      entry.assets.map(async (asset) => ({
        ...(await add(asset.path, types[asset.ext] || "application/octet-stream")),
        // Expo resolves bundled assets by the export's content name.
        key: asset.path.split("/").pop(),
        fileExtension: "." + asset.ext,
        contentType: types[asset.ext] || "application/octet-stream",
      })),
    ),
  };
}
const bundle = {
  id: randomUUID(),
  createdAt: new Date().toISOString(),
  sdkVersion: config.sdkVersion,
  config,
  platforms,
  files,
};
await mkdir(output, { recursive: true });
await writeFile(join(output, "bundle.json"), JSON.stringify(bundle));
console.log("Exported the Expo Go client for iOS and Android (SDK " + config.sdkVersion + ").");
