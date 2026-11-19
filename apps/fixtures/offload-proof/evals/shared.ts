import { readFileSync } from "node:fs";
import { join } from "node:path";

const issues = JSON.parse(
  readFileSync(join(process.cwd(), "server/issues.json"), "utf8"),
) as { number: number; state: string; comments: number }[];

export const openCount = issues.filter((issue) => issue.state === "open").length;
export const mostCommented = [...issues].sort((a, b) => b.comments - a.comments)[0]!.number;
export const question =
  "How many of the issues are open, and which issue number has the most comments? Reply as 'open=<n> top=<number>'.";
export const expected = new RegExp(`open=${openCount}\\b[\\s\\S]*top=#?${mostCommented}\\b`);
