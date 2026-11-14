import assert from "node:assert/strict";
import { mock, test } from "node:test";
// Exercise eve's real JSON memo and definition validation, not a pass-through memo mock.
import { openMemos } from "../../node_modules/eve/dist/src/definitions/memos.js";
import { namedEntries } from "../../node_modules/eve/dist/src/definitions/named.js";
import {
  type DynamicContext,
  dynamicEvaluate,
} from "../../node_modules/eve/dist/src/dynamic/definition.js";
import { isBrandedSkillEntry } from "../../node_modules/eve/dist/src/shared/skill-definition.js";

const SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const store = await import("../lib/skills/store.ts");
let globalUnavailable = false;
const reads = { global: 0, user: 0 };
mock.module("#lib/skills/store.ts", {
  namedExports: {
    ...store,
    getCustomSkillStore: () => ({
      list(auth: { principalType?: string } | null, scope: "global" | "user") {
        reads[scope] += 1;
        if (scope === "user" && auth?.principalType !== "user") {
          return Promise.resolve([]);
        }
        if (scope === "global" && globalUnavailable) {
          throw new Error("storage unavailable");
        }
        return Promise.resolve([
          {
            description: "Use during an investigation.",
            markdown: `# ${scope} runbook`,
            name: scope,
            scope,
            updatedAt: "2026-08-03T12:00:00.000Z",
          },
        ]);
      },
    }),
  },
});
const { default: custom } = await import("./custom.ts");

test("dynamic custom skills survive memo replay and retry only a failed scope", async () => {
  let kept: Parameters<typeof openMemos>[0]["kept"];
  const evaluate = async (turnId: string, principalType = "user") => {
    const run = openMemos({
      abortSignal: new AbortController().signal,
      kept,
      label: "skills/custom.ts",
      scope: "skill:custom",
      sessionId: "session-1",
    });
    try {
      const value = await dynamicEvaluate(custom)({
        memo: run.memo,
        session: {
          auth: {
            current: { principalId: "slack:T1:U1", principalType },
          },
          id: "session-1",
        },
        turn: { id: turnId },
      } as DynamicContext);
      const entries = namedEntries(
        { logicalPath: "skills/custom.ts", slug: "custom" },
        value,
        {
          is: isBrandedSkillEntry,
          made: "defineSkill()",
          noun: "skill",
          pattern: SKILL_NAME,
          rule: "Use a valid skill name.",
        }
      );
      kept = run.used();
      return entries.map(({ name }) => name);
    } finally {
      run.close();
    }
  };

  assert.deepEqual(await evaluate("turn-1"), ["custom-global", "custom-user"]);
  assert.deepEqual(await evaluate("turn-1"), ["custom-global", "custom-user"]);
  assert.deepEqual(reads, { global: 1, user: 1 });

  globalUnavailable = true;
  assert.deepEqual(await evaluate("turn-2"), ["custom-user"]);
  globalUnavailable = false;
  assert.deepEqual(await evaluate("turn-2"), ["custom-global", "custom-user"]);
  assert.deepEqual(reads, { global: 3, user: 2 });
  assert.deepEqual(await evaluate("turn-3", "service"), ["custom-global"]);
  assert.deepEqual(await evaluate("turn-3", "service"), ["custom-global"]);
});
