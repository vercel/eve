import type { InputRequest, InputResponse } from "#shared/input.js";

export type InputVariant = "approval" | "limit" | "question";

export interface InputRow {
  readonly groupId: string;
  readonly id: string;
  readonly request: InputRequest;
  readonly variant: InputVariant;
}

export interface InputGroup {
  readonly id: string;
  readonly kind: InputVariant;
  readonly rows: readonly InputRow[];
}

export type RowInput =
  | { readonly kind: "message" }
  | { readonly kind: "response"; readonly response: InputResponse };

export type ApprovalOutcome = "approved" | "cancelled" | "denied" | "invalid";
export type QuestionOutcome = {
  readonly optionId?: string;
  readonly status: "answered";
  readonly text?: string;
};
export type LimitOutcome = "continued" | "stopped";

export type Verdict =
  | "ignore"
  | { readonly dismiss: "superseded" }
  | { readonly settle: ApprovalOutcome | LimitOutcome | QuestionOutcome };

export type RowEffect =
  | { readonly kind: "dismissed"; readonly row: InputRow; readonly reason: "superseded" }
  | {
      readonly kind: "settled";
      readonly outcome: ApprovalOutcome | LimitOutcome | QuestionOutcome;
      readonly response: InputResponse;
      readonly row: InputRow;
    };

export type InputEffect = RowEffect | { readonly group: InputGroup; readonly kind: "claim-group" };

export interface InputReducer {
  resolve(row: InputRow, input: RowInput): Verdict;
}

export type InputReducerRegistry = Readonly<Record<InputVariant, InputReducer>>;

/** Interprets one delivery row by row, then claims terminal groups in durable order. */
export function interpretInput(input: {
  readonly groups: readonly InputGroup[];
  readonly message: boolean;
  readonly reducers: InputReducerRegistry;
  readonly responses: readonly InputResponse[];
}): readonly InputEffect[] {
  const rowEffects: RowEffect[] = [];
  const rows = input.groups.flatMap((group) => group.rows);
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  for (const response of input.responses) {
    const row = rowsById.get(response.requestId);
    if (row === undefined) continue;
    applyVerdict(
      rowEffects,
      row,
      input.reducers[row.variant].resolve(row, { kind: "response", response }),
      response,
    );
  }

  if (input.message) {
    const settled = new Set(rowEffects.map((effect) => effect.row.id));
    for (const row of rows) {
      if (settled.has(row.id)) continue;
      applyVerdict(rowEffects, row, input.reducers[row.variant].resolve(row, { kind: "message" }));
    }
  }

  return [...rowEffects, ...claimGroups(input.groups, rowEffects)];
}

function claimGroups(
  groups: readonly InputGroup[],
  rowEffects: readonly RowEffect[],
): readonly InputEffect[] {
  const settledIds = new Set(
    rowEffects.filter((effect) => effect.kind === "settled").map((effect) => effect.row.id),
  );
  const dismissedIds = new Set(
    rowEffects.filter((effect) => effect.kind === "dismissed").map((effect) => effect.row.id),
  );
  const limitGroup = groups.find((group) => group.kind === "limit");

  // A session-limit prompt owns the delivery while it is open.
  if (limitGroup !== undefined) {
    return limitGroup.rows.every((row) => settledIds.has(row.id))
      ? [{ group: limitGroup, kind: "claim-group" }]
      : [];
  }

  if (groups.some((group) => group.kind === "approval")) {
    const claimable = groups.filter((group) =>
      group.kind === "approval"
        ? group.rows
            .filter((row) => row.variant === "approval")
            .every((row) => settledIds.has(row.id))
        : group.rows.some((row) => settledIds.has(row.id)),
    );
    const firstApprovalIndex = claimable.findIndex((group) => group.kind === "approval");
    const claimed = firstApprovalIndex < 0 ? claimable : claimable.slice(0, firstApprovalIndex + 1);
    return claimed.map((group) => ({ group, kind: "claim-group" }));
  }

  const answered = groups.filter((group) => group.rows.some((row) => settledIds.has(row.id)));
  if (answered.length > 0) {
    return answered.map((group) => ({ group, kind: "claim-group" }));
  }

  const sole = groups.length === 1 ? groups[0] : undefined;
  return sole !== undefined && sole.rows.every((row) => dismissedIds.has(row.id))
    ? [{ group: sole, kind: "claim-group" }]
    : [];
}

function applyVerdict(
  effects: RowEffect[],
  row: InputRow,
  verdict: Verdict,
  response?: InputResponse,
): void {
  if (verdict === "ignore") return;
  if ("dismiss" in verdict) {
    effects.push({ kind: "dismissed", reason: verdict.dismiss, row });
    return;
  }
  if (response === undefined) {
    throw new TypeError("A settled input row must have a response.");
  }
  effects.push({ kind: "settled", outcome: verdict.settle, response, row });
}

export const approvalReducer: InputReducer = {
  resolve(_row, input) {
    if (input.kind !== "response") return "ignore";
    switch (input.response.optionId) {
      case "approve":
        return { settle: "approved" };
      case "cancel":
        return { settle: "cancelled" };
      case "deny":
        return { settle: "denied" };
      default:
        return { settle: "invalid" };
    }
  },
};

export const questionReducer: InputReducer = {
  resolve(_row, input) {
    if (input.kind === "message") return { dismiss: "superseded" };
    return {
      settle: {
        optionId: input.response.optionId,
        status: "answered",
        text: input.response.text,
      },
    };
  },
};

export const limitReducer: InputReducer = {
  resolve(_row, input) {
    if (input.kind !== "response") return "ignore";
    return { settle: input.response.optionId === "continue" ? "continued" : "stopped" };
  },
};

export const inputReducers: InputReducerRegistry = {
  approval: approvalReducer,
  limit: limitReducer,
  question: questionReducer,
};
