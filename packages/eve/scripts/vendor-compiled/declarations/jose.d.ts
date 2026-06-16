import type { KeyObject } from "node:crypto";

export interface JWTPayload {
  aud?: string | readonly string[] | undefined;
  exp?: number | undefined;
  iat?: number | undefined;
  iss?: string | undefined;
  jti?: string | undefined;
  nbf?: number | undefined;
  sub?: string | undefined;
  [claim: string]: unknown;
}

export interface JWTVerifyOptions {
  algorithms?: readonly string[] | undefined;
  audience?: string | readonly string[] | undefined;
  clockTolerance?: number | string | undefined;
  issuer?: string | readonly string[] | undefined;
}

export interface JWTVerifyResult {
  payload: JWTPayload;
  protectedHeader: Record<string, unknown>;
}

export type KeyLike = CryptoKey | KeyObject | Uint8Array;
export type GetKeyFunction = (
  protectedHeader: Record<string, unknown>,
  token?: unknown,
) => KeyLike | Promise<KeyLike>;

export declare function createRemoteJWKSet(url: URL): GetKeyFunction;
export declare function decodeJwt(jwt: string): JWTPayload;
export declare function importJWK(jwk: unknown, alg?: string): Promise<KeyLike>;
export declare function importSPKI(spki: string, alg: string): Promise<KeyLike>;
export declare function jwtVerify(
  jwt: string,
  key: KeyLike | GetKeyFunction,
  options?: JWTVerifyOptions,
): Promise<JWTVerifyResult>;
