import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";

const jsPlugins = selectJsPlugins(["jsdoc-js", "tsdoc"]);

export default defineConfig({
  extends: [core, antiSlop, jsPlugins],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: jsPlugins.jsPlugins,
  overrides: [
    { files: ["agent/tools/*.ts"], rules: { "unicorn/filename-case": "off" } },
    // Setup scripts run statements in order inside one transaction or connection.
    { files: ["scripts/**/*.ts"], rules: { "no-await-in-loop": "off" } },
  ],
});
