import { defineState } from "eve/context";

export const REVIEW_REFERENCE = "reviews/storefront/repository";
export const HANDOFF_REFERENCE = "handoffs/storefront/repository";

export interface ReleaseRecord {
  readonly reportId: string;
  readonly status: "completed";
  readonly findings: readonly string[];
}

export const releaseRecords = defineState<Record<string, ReleaseRecord>>(
  "storefront.release-records",
  () => ({}),
);

export function saveReleaseRecord(record: ReleaseRecord): void {
  releaseRecords.update((records) => ({ ...records, [record.reportId]: record }));
}
