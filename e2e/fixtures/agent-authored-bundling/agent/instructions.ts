import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineInstructions } from "eve/instructions";

import prompt from "../authored-assets/prompt.md?raw";
import { SHARED_MODULE_MARKER } from "../authored-assets/shared";

// This source-only read is a cold-start tripwire: static instructions may run
// during compilation, but a deployed runtime entry could not resolve this file.
const compileOnlyMarker = readFileSync(
  resolve(process.cwd(), "authored-assets/compile-only.txt"),
  "utf8",
).trim();

export default defineInstructions({
  content: [prompt.trim(), SHARED_MODULE_MARKER, compileOnlyMarker].join("\n"),
});
