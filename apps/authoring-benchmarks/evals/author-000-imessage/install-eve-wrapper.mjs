import { chmodSync, writeFileSync } from "node:fs";

const path = "node_modules/.bin/eve";
writeFileSync(
  path,
  [
    "#!/bin/sh",
    'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'EVE_DEV_OFFICIAL_REGISTRY_URL=http://127.0.0.1:4173 EVE_AUTHORING_PHONE_NUMBER=+15551234567 exec node "$SCRIPT_DIR/../eve/bin/eve.js" "$@"',
    "",
  ].join("\n"),
);
chmodSync(path, 0o755);
