export default {
  includeLocked: true,
  maturityPeriodExclude: ["@onkernel/*", "@vercel/*", "eve"],
  mode: "major",
  packageMode: {
    "@types/node": "minor",
    typescript: "minor",
  },
  recursive: true,
};
