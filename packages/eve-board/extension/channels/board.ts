import { createBoardChannel } from "../lib/board-channel.ts";
import extension from "../extension.ts";

export default createBoardChannel(() => extension.config);
