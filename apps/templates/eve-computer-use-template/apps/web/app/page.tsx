import { headers } from "next/headers";
import { connection } from "next/server";

import { getViewer } from "../lib/session";
import { getAuthMode, unconfiguredReason } from "../lib/setup";
import { App } from "./app";
import { NotConfigured, SignIn } from "./sign-in";

export default async function Page() {
  // The auth mode and the viewer come from runtime env and cookies, never the build.
  await connection();
  const mode = getAuthMode();
  if (mode === "unconfigured") return <NotConfigured reason={unconfiguredReason()} />;
  if (getViewer(await headers()) === null) return <SignIn />;
  return <App canSignOut={mode === "password"} />;
}
