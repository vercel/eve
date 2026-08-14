export interface BlobCommandOptions {
  readonly abortSignal?: AbortSignal;
  readonly oidcToken?: string;
  readonly storeId?: string;
  readonly token?: string;
}

export interface GetCommandOptions extends BlobCommandOptions {
  readonly access: "private" | "public";
  readonly useCache?: boolean;
}

export interface GetBlobResult {
  readonly blob: {
    readonly etag: string;
  };
  readonly statusCode: 200 | 304;
  readonly stream: ReadableStream<Uint8Array> | null;
}

export interface PutCommandOptions extends BlobCommandOptions {
  readonly access: "private" | "public";
  readonly addRandomSuffix?: boolean;
  readonly allowOverwrite?: boolean;
  readonly cacheControlMaxAge?: number;
  readonly contentType?: string;
  readonly ifMatch?: string;
}

export interface PutBlobResult {
  readonly etag: string;
}

export declare class BlobPreconditionFailedError extends Error {}

export declare function get(
  pathname: string,
  options: GetCommandOptions,
): Promise<GetBlobResult | null>;

export declare function put(
  pathname: string,
  body: string,
  options: PutCommandOptions,
): Promise<PutBlobResult>;
