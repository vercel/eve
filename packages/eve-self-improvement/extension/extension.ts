import { defineExtension } from "eve/extension";
import { configSchema } from "./lib/config.js";

/** Adds scheduled, evidence-backed self-improvement with private storage and independently verified PRs. */
export default defineExtension({ config: configSchema });
