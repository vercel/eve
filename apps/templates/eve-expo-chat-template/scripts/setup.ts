import { initialize } from "../apps/cli/src/init.ts";
const args = process.argv.slice(2);
let scope: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--scope" && args[i + 1]) scope = args[++i];
  else throw Error("Usage: ./scripts/setup.sh [--scope TEAM]");
}
await initialize({ scope });
