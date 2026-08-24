import { EVE_TASK_INPUT_ROUTE_PATTERN } from "#protocol/routes.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import { handleTaskInputResponseRequest } from "#runtime/task-input-response-route.js";

export default () =>
  defineChannel({
    routes: [POST(EVE_TASK_INPUT_ROUTE_PATTERN, handleTaskInputResponseRequest)],
  });
