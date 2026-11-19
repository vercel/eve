import { Query } from "pg";
import type { PoolClient } from "pg";

import type { AnalystQuery, AnalystQueryResult } from "#lib/analyst/postgres";

const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Runs a query with a 1 MiB wire-response budget before pg's protocol parser.
 *
 * @param client - Exclusively checked-out client, with TLS negotiation complete.
 * @param config - Query to execute.
 * @returns The driver's result, only when the entire response fits the budget.
 * @remarks Closing the socket cancels oversized responses, including a single
 * unfinished DataRow or EXPLAIN field. Never return this connection to the pool.
 */
export const queryBounded = (
  client: PoolClient,
  config: AnalystQuery
): Promise<AnalystQueryResult> => {
  const { values, ...rest } = config;
  const query = new Query({ ...rest, ...(values && { values: [...values] }) });
  const submit = query.submit.bind(query);
  query.submit = (connection) => {
    const { stream } = connection;
    // SAFETY: pg's negotiated binary stream emits Buffer chunks to data listeners.
    const consumers = stream.listeners("data") as ((chunk: Buffer) => void)[];
    let bytes = 0;
    // A row event is too late: pg-protocol buffers the whole DataRow first.
    // Wrap its data consumer on the negotiated (possibly TLS) stream instead.
    for (const consumer of consumers) {
      stream.removeListener("data", consumer);
    }
    const consume = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        stream.destroy(
          new Error(
            "Query response exceeds 1 MiB. Select fewer or smaller values."
          )
        );
        return;
      }
      for (const consumer of consumers) {
        consumer.call(stream, chunk);
      }
    };
    stream.on("data", consume);
    const restore = () => {
      stream.removeListener("data", consume);
      for (const consumer of consumers) {
        stream.on("data", consumer);
      }
    };
    query.once("end", restore);
    query.once("error", restore);
    return submit(connection);
  };
  const result = Promise.withResolvers<AnalystQueryResult>();
  // pg emits socket failures both on the active query and the checked-out
  // client. The pool's idle error listener is absent during this checkout.
  const onClientError = (error: Error) => result.reject(error);
  client.on("error", onClientError);
  const cleanup = () => client.removeListener("error", onClientError);
  query.once("end", cleanup);
  query.once("error", cleanup);
  query.once("end", result.resolve);
  query.once("error", result.reject);
  client.query(query);
  return result.promise;
};
