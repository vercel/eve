import extension from "./extension/extension.ts";
import {
  defineBoardBlockTaskTool,
  defineBoardCancelScheduleTool,
  defineBoardChannelsTool,
  defineBoardCompleteTaskTool,
  defineBoardCreateTaskTool,
  defineBoardFailTaskTool,
  defineBoardLabelTool,
  defineBoardNoteTool,
  defineBoardPostTool,
  defineBoardReactTool,
  defineBoardReadTool,
  defineBoardReleaseTaskTool,
  defineBoardReplyTool,
  defineBoardScheduleTool,
  defineBoardTypingTool,
} from "./extension/lib/tools.ts";

const settings = () => extension.config;

/** Lists the board's channels. */
export const channels = defineBoardChannelsTool(settings);
/** Reads a thread, or a channel's threads. */
export const read = defineBoardReadTool(settings);
/** Starts a thread in a channel. */
export const post = defineBoardPostTool(settings);
/** Replies in a thread. */
export const reply = defineBoardReplyTool(settings);
/** Keeps a note in a thread, on the board only. */
export const note = defineBoardNoteTool(settings);
/** Reacts to a message. */
export const react = defineBoardReactTool(settings);
/** Sets or unsets labels on a message. */
export const label = defineBoardLabelTool(settings);
/** Shows what the agent is doing in a thread. */
export const typing = defineBoardTypingTool(settings);
/** Schedules a message that wakes the agent later. */
export const schedule = defineBoardScheduleTool(settings);
/** Cancels a scheduled message. */
export const cancel_schedule = defineBoardCancelScheduleTool(settings);
/** Creates a task on the board's queue. */
export const create_task = defineBoardCreateTaskTool(settings);
/** Completes the task the session holds. */
export const complete_task = defineBoardCompleteTaskTool(settings);
/** Gives up on the task the session holds. */
export const fail_task = defineBoardFailTaskTool(settings);
/** Holds the task the session holds for a person. */
export const block_task = defineBoardBlockTaskTool(settings);
/** Gives back the task the session holds. */
export const release_task = defineBoardReleaseTaskTool(settings);
