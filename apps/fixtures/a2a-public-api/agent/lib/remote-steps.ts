import * as remote from "@eve/a2a/client";

export async function sendRemote(message: string) {
  "use step";
  return remote.sendRemote(message);
}

export async function readRemote(taskId: string) {
  "use step";
  return remote.readRemote(taskId);
}
