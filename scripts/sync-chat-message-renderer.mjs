#!/usr/bin/env node
import { cpSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const canonical = resolve(root, "apps/docs/registry/channel/web/components/chat");
const consumers = [resolve(root, "apps/templates/eve-chat-template/components/chat")];
const files = ["message.tsx", "markdown.tsx"];
const mode = process.argv[2] ?? "--check";
if (mode !== "--check" && mode !== "--write") {
  throw new Error("Usage: node scripts/sync-chat-message-renderer.mjs [--write|--check]");
}

let stale = false;
for (const consumer of consumers) {
  for (const file of files) {
    const source = resolve(canonical, file);
    const destination = resolve(consumer, file);
    if (mode === "--check") {
      if (readFileSync(source, "utf8") !== readFileSync(destination, "utf8")) {
        process.stderr.write(
          `${relative(root, destination)} is stale; run pnpm sync:chat-message-renderer.\n`,
        );
        stale = true;
      }
    } else {
      cpSync(source, destination);
    }
  }
}
if (stale) process.exitCode = 1;
