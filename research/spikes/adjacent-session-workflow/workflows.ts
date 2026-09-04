import { createHook, getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";
import { getRun } from "#internal/workflow/runtime.js";

interface Handles {
  output: WritableStream<string>;
  checkpoint: WritableStream<number>;
}

export async function adjacentSpikeCompanion(
  token: string,
  existingStreamRunId?: string,
): Promise<void> {
  "use workflow";
  if (existingStreamRunId === undefined) {
    await adjacentSpikePublish({
      output: getWritable<string>(),
      checkpoint: getWritable<number>({ namespace: "checkpoint" }),
    });
  }
  await adjacentSpikePublishReference(existingStreamRunId ?? getWorkflowMetadata().workflowRunId);
  const control = createHook<{ alias?: string; close?: boolean }>({ token });
  const aliases = [];
  try {
    for await (const event of control) {
      if (event.close) return;
      if (event.alias) {
        const alias = createHook({ token: event.alias });
        if (await alias.getConflict()) throw new Error("Alias conflict");
        aliases.push(alias);
      }
    }
  } finally {
    for (const alias of aliases) alias.dispose();
    control.dispose();
  }
}

async function adjacentSpikePublishReference(streamRunId: string): Promise<void> {
  "use step";
  const writer = getWritable<{ sessionId: string; streamRunId: string }>({
    namespace: "session-reference",
  }).getWriter();
  await writer.write({ sessionId: streamRunId, streamRunId });
  await writer.close();
}

async function adjacentSpikePublish(handles: Handles): Promise<void> {
  "use step";
  const checkpoint = handles.checkpoint.getWriter();
  await checkpoint.write(0);
  checkpoint.releaseLock();
  const manifest = getWritable<Handles>({ namespace: "handles" }).getWriter();
  await manifest.write(handles);
  await manifest.close();
}

export async function adjacentSpikeTurn(sessionId: string, message: string): Promise<number> {
  "use workflow";
  const claim = createHook({ token: `adjacent-spike:turn:${sessionId}` });
  try {
    if (await claim.getConflict()) return -1;
    return await adjacentSpikeWrite(sessionId, message);
  } finally {
    claim.dispose();
  }
}

async function adjacentSpikeWrite(sessionId: string, message: string): Promise<number> {
  "use step";
  const manifest = getRun(sessionId).getReadable<Handles>({ namespace: "handles" }).getReader();
  const { value: handles } = await manifest.read();
  await manifest.cancel();
  if (!handles) throw new Error("Missing handles");
  const checkpoint = getRun(sessionId)
    .getReadable<number>({ namespace: "checkpoint", startIndex: -1 })
    .getReader();
  const { value: previous } = await checkpoint.read();
  await checkpoint.cancel();
  if (previous === undefined) throw new Error("Missing checkpoint");
  const output = handles.output.getWriter();
  await output.write(message);
  output.releaseLock();
  const next = previous + 1;
  const writer = handles.checkpoint.getWriter();
  await writer.write(next);
  writer.releaseLock();
  return next;
}

export async function adjacentSpikeClosingOwner(token: string): Promise<string[]> {
  "use workflow";
  const inbox = createHook<string>({ token });
  const iterator = inbox[Symbol.asyncIterator]();
  try {
    if (await inbox.getConflict()) throw new Error("Unexpected conflict");
    void iterator.next();
    const finish = createHook({ token: `${token}:finish` });
    try {
      await finish;
      return [];
    } finally {
      finish.dispose();
    }
  } finally {
    inbox.dispose();
  }
}
