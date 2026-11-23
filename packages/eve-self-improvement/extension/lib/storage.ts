import type { Active, Experiment, Lease, Observation } from "./types.js";

export interface Storage {
  readonly scope: string;
  hasRecord(key: string): Promise<boolean>;
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, days?: number): Promise<void>;
  observe(observation: Observation): Promise<void>;
  list<T>(prefix: string, limit?: number): Promise<T[]>;
  observations(from: number, to: number): Promise<{ values: Observation[]; complete: boolean }>;
  acquire(owner: string, leaseMs?: number): Promise<Active | null>;
  save(lease: Lease, experiment: Experiment | null): Promise<void>;
  renew(lease: Lease, leaseMs?: number): Promise<void>;
  bindSession(
    lease: Lease,
    field: "coordinatorSession" | "writerSession",
    session: string,
  ): Promise<Experiment>;
  release(lease: Lease): Promise<void>;
  active(): Promise<Active | null>;
  purge(): Promise<number>;
}
