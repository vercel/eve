import { writeFileSync } from "node:fs";

const headers = { accept: "application/vnd.github+json", "user-agent": "offload-proof" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const response = await fetch(
  "https://api.github.com/repos/vercel/eve/issues?state=all&per_page=100",
  { headers },
);
if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
const text = await response.text();
writeFileSync(new URL("./issues.json", import.meta.url), text);
console.log(`wrote ${Buffer.byteLength(text)} bytes, about ${Math.round(Buffer.byteLength(text) / 4)} tokens`);
