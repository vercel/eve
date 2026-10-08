import { defineTool } from "eve/tools";
import { CATALOG_TOOLS, referenceOf } from "./catalog";
export const mode = process.env.EVE_ARMS_MODE ?? "direct";
export const size = process.env.EVE_ARMS_SIZE ?? "moderate";
if (!["direct", "deferred", "subagents"].includes(mode)) throw new Error("Invalid EVE_ARMS_MODE");
if (!["moderate", "large"].includes(size)) throw new Error("Invalid EVE_ARMS_SIZE");
export const groups = ["sre", "d0", "index", "support", "office"];
export const groupOf = (name: string) => (name.includes("__") ? name.split("__")[0]! : "office");
const selected = CATALOG_TOOLS.filter((t) =>
  [
    "sre__status_page_incidents_list",
    "sre__oncall_schedule_get",
    "d0__query_cost",
    "d0__usage_summary",
    "index__resolve_account",
    "index__list_opportunities",
    "support__search_cases",
    "support__support_billing",
    "release_train_schedule",
    "expense_policy_lookup",
  ].includes(t.name),
);
const others = CATALOG_TOOLS.filter((t) => !selected.includes(t));
export const tools = [...selected, ...others.slice(0, 20)];
if (size === "large") {
  tools.push(...others.slice(20));
  for (let i = tools.length; i < 200; i++) {
    const group = groups[i % groups.length]!;
    const subject = [
      "audit",
      "archive",
      "configuration",
      "retention",
      "permissions",
      "regional_capacity",
      "subscriptions",
    ][Math.floor(i / 5) % 7]!;
    tools.push({
      name: `${group}__${subject}_snapshot_${i}`,
      description: `Retrieve ${group} ${subject.replaceAll("_", " ")} snapshot for reporting period ${i}. Returns the current revision and reporting state.`,
      inputs: { subjectId: "Subject identifier", period: "Reporting period" },
      result: { revision: i, state: "current" },
    });
  }
}
export function definitions(group?: string) {
  return Object.fromEntries(
    tools
      .filter((t) => !group || groupOf(t.name) === group)
      .map(({ name, description, inputs = {}, result }) => [
        name,
        defineTool({
          deferred: !group && mode === "deferred",
          description,
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(
              Object.entries(inputs).map(([key, description]) => [
                key,
                { type: "string", description },
              ]),
            ),
          },
          execute: () => ({ reference: referenceOf(name), ...result }),
        }),
      ]),
  );
}
