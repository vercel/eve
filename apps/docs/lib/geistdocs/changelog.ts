import { changelogSource } from "./changelog-source";
import { config } from "./config";

export const changelogOptions = {
  config,
  source: changelogSource,
  path: "/changelog",
  markdownPath: "/changelog.md",
  pageSize: 5,
  title: "Changelog",
  description: "New features, breaking changes, and fixes in eve, release by release.",
};
