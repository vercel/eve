import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintBaselayerCredential } from "../server/baselayer.ts";

let directory;
try {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("Usage: pnpm baselayer:mint <merchant-url>");
  const minted = await mintBaselayerCredential(args[0]);
  directory = await mkdtemp(join(tmpdir(), "bell-baselayer-"));
  await writeFile(join(directory, "credential.txt"), minted.credential, {
    mode: 0o600,
  });
  await writeFile(join(directory, "agent-private.jwk.json"), JSON.stringify(minted.privateJwk), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      directory,
      audience: minted.audience,
      expiresAt: minted.expiresAt,
    }),
  );
} catch (error) {
  if (directory) await rm(directory, { recursive: true, force: true });
  console.error(error instanceof Error ? error.message : "Credential mint failed.");
  process.exitCode = 1;
}
