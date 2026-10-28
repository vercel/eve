import "./build-libraries.mjs";
import { execFileSync } from "node:child_process";
execFileSync(process.execPath, ["node_modules/eve/bin/eve.js", "build", "--skip-sandbox-prewarm"], {
  stdio: "inherit",
});
