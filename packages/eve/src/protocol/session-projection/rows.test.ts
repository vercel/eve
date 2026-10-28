import { describe, expectTypeOf, it } from "vitest";

import type { FactOf } from "#protocol/session-events/facts.js";
import type { TableName } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

/**
 * The fields of a lifecycle fact its row doesn't declare, besides those the fold renames or omits:
 * any left, the fold would copy onto the row without its type saying so.
 */
type Undeclared<T extends FactOf<any>["type"], K extends TableName, Renamed = never> = Exclude<
  keyof FactOf<T>["data"],
  keyof SessionView[K][keyof SessionView[K]] | Renamed
>;

describe("rows", () => {
  it("declare every field the fold copies onto them", () => {
    expectTypeOf<Undeclared<"turn.started", "turns", "trace">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"turn.settled", "turns", "cause">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"delivery.admitted", "deliveries">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"delivery.consumed", "deliveries", "history">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"delivery.settled", "deliveries">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"model.requested", "runs">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"model.started", "runs">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"model.settled", "runs">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"content.completed", "parts">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"call.requested", "calls">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"call.started", "calls">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"call.settled", "calls">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"task.started", "tasks">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"task.ended", "tasks">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"interaction.opened", "interactions">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"interaction.settled", "interactions">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"response.submitted", "responses">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"response.admitted", "responses">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"response.settled", "responses">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"child.opened", "children">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"context.started", "changes">>().toEqualTypeOf<never>();
    expectTypeOf<Undeclared<"context.settled", "changes">>().toEqualTypeOf<never>();
  });
});
