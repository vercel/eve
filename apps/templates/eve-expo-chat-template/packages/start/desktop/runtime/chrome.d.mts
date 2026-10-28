import type { ChildProcess } from "node:child_process";
export class CloudChrome {
  constructor(options: {
    launch: () => ChildProcess;
    health: () => Promise<void>;
    attach: () => Promise<void>;
    detach: () => Promise<unknown>;
    onReady: (ready: boolean) => void;
    retryMs?: number;
    monitorMs?: number;
  });
  start(): Promise<void>;
  ensure(): Promise<void>;
  stop(): Promise<void>;
}
