export default {
  ignorePatterns: ["tools/oxlint/anti-slop/**"],
  printWidth: 80,
  semi: true,
  singleQuote: false,
  sortPackageJson: false,
  sortTailwindcss: { stylesheet: "./app/globals.css" },
  tabWidth: 2,
  trailingComma: "es5",
  overrides: [
    {
      files: ["*.jsonc"],
      options: { trailingComma: "none" },
    },
  ],
};
