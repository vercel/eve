import { askQuestion } from "eve/tools/ask_question";

/**
 * Lets the model ask the user one question and wait for the answer.
 *
 * @remarks
 * `ask_question` is opt-in, so this file is what gives the specialist the tool. A specialist's
 * reply goes to the lead, not to the person, so plain text can't reach them mid-task: this tool
 * relays the question to the person on the root channel and waits. Slack renders the options as a
 * native select, and the person can always type their own answer instead.
 *
 * eve exports the tool as a ready definition. It is bound to a local name before the export
 * because the lint rules reject exporting an import directly.
 *
 * @see {@link https://eve.dev/docs/concepts/built-in-tools | Built-in tools}
 */
const askQuestionTool = askQuestion;

export default askQuestionTool;
