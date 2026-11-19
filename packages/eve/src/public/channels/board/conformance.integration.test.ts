import { afterAll } from "vitest";

import { disposeTestBoards } from "#internal/testing/board-server.js";
import { describeChannelConformance } from "#internal/testing/channel-conformance/conformance.js";

afterAll(disposeTestBoards);

describeChannelConformance("board");
