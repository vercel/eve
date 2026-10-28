import { readFile } from "node:fs/promises";
const c = JSON.parse(await readFile(new URL("./config.json", import.meta.url), "utf8"));
const action = process.argv[2] || "ticket";
let data = action === "ticket" && process.argv[3] ? { origin: process.argv[3] } : {};
if (action === "execute") {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  data = JSON.parse(text);
}
const r = await fetch(`http://127.0.0.1:6080/control/${action}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${c.controlKey}`, "Content-Type": "application/json" },
  body: JSON.stringify(data),
  signal: AbortSignal.timeout(50000),
});
const result = await r.json();
if (!r.ok) throw new Error(result.error);
console.log(JSON.stringify(result));
