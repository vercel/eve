import { noReply } from "eve/tools/no_reply";

// Every message in a thread the bot joined reaches the agent, including ones
// people send each other. This lets it stay quiet instead of answering them all.
export default noReply();
