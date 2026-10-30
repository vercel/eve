import { createBoardChannel } from "eve/internal/board";

import extension from "../extension.ts";

export default createBoardChannel({}, () => extension.config);
