#!/usr/bin/env bash
set -euo pipefail
stage="$1"
folder=/tmp/eve-start-storage
if node "$stage/server.mjs" --probe "$stage/config.json"; then
	exit 0
fi
mkdir -p "$folder"
chmod 700 "$folder"
if [ -f "$folder/config.json" ] && ! node "$stage/server.mjs" --same-key "$folder/config.json" "$stage/config.json"; then
	echo 'The database credential does not match. Restore the original EVE_START_AGENT_TOKEN; existing data has not been changed.' >&2
	exit 1
fi
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" /data/eve-start
install -m 600 "$stage/server.mjs" "$folder/server.mjs"
install -m 600 "$stage/config.json" "$folder/config.json"
echo 'Starting the persistent SQLite database…'
nohup flock -n /tmp/eve-start-storage-server.lock node "$folder/server.mjs" --serve "$folder/config.json" >"$folder/server.log" 2>&1 </dev/null &
for ((i = 0; i < 200; i++)); do
	if node "$stage/server.mjs" --probe "$stage/config.json"; then
		echo 'Database ready.'
		exit 0
	fi
	sleep 0.1
done
tail -n 5 "$folder/server.log" >&2
echo 'Database did not become ready. Existing data has been preserved.' >&2
exit 1
