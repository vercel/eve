export interface QueryResult<Row extends Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface PoolConfig {
  application_name?: string;
  connectionString?: string;
  max?: number;
  ssl?: boolean | { ca?: string; rejectUnauthorized: boolean };
}

export interface PoolClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    parameters?: unknown[],
  ): Promise<QueryResult<Row> | QueryResult<Row>[]>;
  release(): void;
}

export declare class Pool {
  constructor(config?: PoolConfig);
  query<Row extends Record<string, unknown>>(
    text: string,
    parameters?: unknown[],
  ): Promise<QueryResult<Row> | QueryResult<Row>[]>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}
