import { isOpen, todoList, type TodoItem, type TodoStatus } from "./todos.ts";

type Block = Record<string, unknown>;

/** A Slack task card message: blocks plus notification text. */
export interface PlanCard {
  readonly blocks: readonly Block[];
  readonly text: string;
}

/** A Slack plan block holds at most 50 tasks. */
const MAX_PLAN_ROWS = 50;
/** A Slack message holds at most 50 blocks. */
const MAX_BLOCKS = 50;
const MAX_ROW_TITLE_LENGTH = 100;
const MAX_TEXT_LENGTH = 3_000;
const CLEARED = "Cleared the checklist.";

const SLACK_STATUS: Record<TodoStatus, string> = {
  // A dropped step is settled, not failed, as eve shows a task the model no longer needed.
  cancelled: "complete",
  completed: "complete",
  in_progress: "in_progress",
  pending: "pending",
};

/**
 * The checklist from the turn's latest write call, which may be empty, or `undefined` when the turn
 * wrote none or its input isn't a valid list. Only the latest call counts, so an older list never
 * shows as current.
 */
export function latestTodos(
  calls: readonly { readonly name: string; readonly input?: unknown }[],
  toolName: string,
): readonly TodoItem[] | undefined {
  const input = calls.findLast((call) => call.name === toolName)?.input;
  if (typeof input !== "object" || input === null || !("todos" in input)) return undefined;
  const parsed = todoList.safeParse(input.todos);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The checklist as a plan block. When the rest of the chain rendered eve's card, a single `plan` or
 * `task_card` block, its task rows join the plan after the steps; any other card keeps its blocks
 * after the plan. A cleared list shows the rest of the chain's card, or a line saying so, since
 * Slack keeps a card a renderer stops returning.
 */
export function planCard(
  items: readonly TodoItem[],
  rendered: PlanCard | null,
  blockId: string,
): PlanCard {
  if (items.length === 0) {
    return (
      rendered ?? {
        blocks: [{ elements: [{ text: CLEARED, type: "mrkdwn" }], type: "context" }],
        text: CLEARED,
      }
    );
  }
  const taskRows = rendered === null ? [] : eveTaskRows(rendered);
  const others = rendered === null || taskRows !== undefined ? [] : rendered.blocks;
  const steps = items.map((item, index) => ({
    status: SLACK_STATUS[item.status],
    task_id: `todo_${String(index)}`,
    title: stepTitle(item),
  }));
  const done = items.filter((item) => !isOpen(item)).length;
  const total = `${String(items.length)} ${items.length === 1 ? "step" : "steps"}`;
  const title = done === items.length ? `Finished ${total}` : `${String(done)} of ${total} done`;
  const text = `${title}: ${items.map((item) => item.content).join(", ")}`;
  return {
    blocks: [
      {
        block_id: blockId,
        tasks: [...steps, ...(taskRows ?? [])].slice(0, MAX_PLAN_ROWS),
        title,
        type: "plan",
      },
      ...others,
    ].slice(0, MAX_BLOCKS),
    text: text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text,
  };
}

/** The task rows of eve's card: one `plan` block, or one `task_card` block as a row. */
function eveTaskRows(card: PlanCard): Block[] | undefined {
  if (card.blocks.length !== 1) return undefined;
  const [block] = card.blocks;
  if (block?.type === "plan" && Array.isArray(block.tasks)) return block.tasks as Block[];
  if (block?.type !== "task_card") return undefined;
  const { block_id: _blockId, type: _type, ...row } = block;
  return [row];
}

function stepTitle(item: TodoItem): string {
  const title = item.status === "cancelled" ? `${item.content} (skipped)` : item.content;
  return title.length > MAX_ROW_TITLE_LENGTH
    ? `${title.slice(0, MAX_ROW_TITLE_LENGTH - 1)}…`
    : title;
}
