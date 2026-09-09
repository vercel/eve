export type SqlParameter = string | number | bigint | boolean | Date | Uint8Array | null;

export interface ComputeQueryResult<Row extends Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export interface ComputeQueryExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: readonly SqlParameter[],
  ): Promise<ComputeQueryResult<Row>>;
}

export interface ComputeStorage extends ComputeQueryExecutor {
  transaction<T>(operation: (transaction: ComputeQueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
