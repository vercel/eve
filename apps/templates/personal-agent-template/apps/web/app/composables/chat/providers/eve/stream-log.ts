const STREAM_LOG_MAX = 50;

export type StreamLogEntry = {
  type: string;
  at: number;
};

const streamLog = ref<StreamLogEntry[]>([]);
const turnEventCounts = ref<Record<string, number>>({});

export function recordStreamEvent(type: string) {
  streamLog.value = [{ type, at: Date.now() }, ...streamLog.value].slice(0, STREAM_LOG_MAX);

  turnEventCounts.value = {
    ...turnEventCounts.value,
    [type]: (turnEventCounts.value[type] ?? 0) + 1,
  };
}

export function resetTurnEventCounts() {
  turnEventCounts.value = {};
}

export function resetStreamLog() {
  streamLog.value = [];
  resetTurnEventCounts();
}

export function useStreamLog() {
  return {
    streamLog: readonly(streamLog),
    turnEventCounts: readonly(turnEventCounts),
    resetStreamLog,
    resetTurnEventCounts,
  };
}
