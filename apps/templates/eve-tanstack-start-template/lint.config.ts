import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { jsPluginSettings, selectJsPlugins } from "ultracite/oxlint/js-plugins";
import react from "ultracite/oxlint/react";
import shadcn from "ultracite/oxlint/shadcn";
import tanstack from "ultracite/oxlint/tanstack";
import tanstackJsPlugins from "ultracite/oxlint/tanstack/js-plugins";
import vitest from "ultracite/oxlint/vitest";

const jsPlugins = selectJsPlugins(["jsdoc-js", "tsdoc", "react-doctor"]);

/**
 * Registry code from `shadcn add` (shadcn/ui and AI Elements). Updates overwrite
 * these files, so they are not linted.
 */
const vendoredComponents = [
  "apps/web/components/ui/**",
  "apps/web/components/ai-elements/**",
];

export default defineConfig({
  extends: [
    core,
    react,
    tanstack,
    vitest,
    tanstackJsPlugins,
    shadcn,
    antiSlop,
    jsPlugins,
  ],
  ignorePatterns: [...(core.ignorePatterns ?? []), ...vendoredComponents],
  jsPlugins: [...jsPlugins.jsPlugins, ...shadcn.jsPlugins],
  options: { typeAware: true },
  settings: jsPluginSettings,
  rules: {
    "func-style": "off",
    "no-use-before-define": "off",
    "react/function-component-definition": "off",
    "shadcn/no-restyle": [
      "error",
      {
        allow: ["layout"],
        contracts: [
          { pattern: "^Questionnaire$", allow: ["layout", "spacing"] },
          {
            pattern: "^QuestionnaireTitle$",
            allow: ["layout", "spacing", "typography"],
          },
          { pattern: "^QuestionnaireChoices$", allow: ["layout", "spacing"] },
          { pattern: "^QuestionnaireChoice$", allow: ["layout", "spacing"] },
        ],
      },
    ],
    "shadcn/no-unknown-classes": [
      "error",
      { allow: ["is-user", "is-assistant", "not-prose"] },
    ],
    "typescript/only-throw-error": [
      "error",
      { allow: [{ from: "lib", name: "Response" }] },
    ],
  },
  overrides: [
    {
      files: ["agent/tools/**"],
      rules: { "unicorn/filename-case": "off" },
    },
  ],
});
