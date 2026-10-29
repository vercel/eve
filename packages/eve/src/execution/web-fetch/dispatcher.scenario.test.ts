import { constants } from "node:crypto";
import { createServer } from "node:http";
import {
  createServer as createTlsServer,
  getCACertificates,
  setDefaultCACertificates,
} from "node:tls";

import { Agent, Dispatcher1Wrapper } from "undici";
import { describe, expect, it } from "vitest";

import { createPublicDispatcher, fetchWithDispatcher } from "#execution/public-destination.js";

// Self-signed test certificates, valid until 2126.
const LOCALHOST = {
  cert: `-----BEGIN CERTIFICATE-----
MIIBlTCCATugAwIBAgIUKHacTUI1cxpPDk584AB8UX5DhcswCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyOTEzNDQyMFoYDzIxMjYxMDA1
MTM0NDIwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARYpSTxjPKVdfmHqeZcgPCq81+MCTM2CLeI9cytnzIoMQ9oRAF1jvSe
GJ8C6Q8EWNudU9y5HpCoCazTG8jvnBrEo2kwZzAdBgNVHQ4EFgQUuYID6YpoVRkW
ESriaj06C3kbaqAwHwYDVR0jBBgwFoAUuYID6YpoVRkWESriaj06C3kbaqAwDwYD
VR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3QwCgYIKoZIzj0EAwID
SAAwRQIgYel9VqzZFQajewTlrELRaDI89sa2deN+pJubcxotxBYCIQC/dW9a6YZo
5/6Vvu/4cF3CVdnLx3Z4leVZiepvaV4ueA==
-----END CERTIFICATE-----`,
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgRuvajLM9BiShCX1J
38fEnm2Q23+hBefMayFxposNE9yhRANCAARYpSTxjPKVdfmHqeZcgPCq81+MCTM2
CLeI9cytnzIoMQ9oRAF1jvSeGJ8C6Q8EWNudU9y5HpCoCazTG8jvnBrE
-----END PRIVATE KEY-----`,
};

const WRONG_HOST = {
  cert: `-----BEGIN CERTIFICATE-----
MIIBoDCCAUegAwIBAgIUGmGSv/jiToqcQU2XG6c91E6C+wQwCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNd3JvbmcuZXhhbXBsZTAgFw0yNjEwMjkxMzQ0MjBaGA8yMTI2
MTAwNTEzNDQyMFowGDEWMBQGA1UEAwwNd3JvbmcuZXhhbXBsZTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABC44NPi8+q8MDcFWSpfi/CskkvFJ2aiuLPvkReBuPdcZ
0Ur8RdJJ+nmtZLpuzriCFDt/mU76pwRr13j9SYAO5AyjbTBrMB0GA1UdDgQWBBRp
qRdVql+1wZnmiRTiRe0yoDvfGzAfBgNVHSMEGDAWgBRpqRdVql+1wZnmiRTiRe0y
oDvfGzAPBgNVHRMBAf8EBTADAQH/MBgGA1UdEQQRMA+CDXdyb25nLmV4YW1wbGUw
CgYIKoZIzj0EAwIDRwAwRAIgYGj7X/QhWVPTFqvqPtXgoD91bvcTd7X35YFJ/RfJ
p6oCIBbUouSQpM7d1z+mE86sl5/DlS8ch0ilzNHC7gOl6vbk
-----END CERTIFICATE-----`,
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgZamvBDqPSqpi/6mY
BZHleq8M5spWm3pCSBr85lv2NvGhRANCAAQuODT4vPqvDA3BVkqX4vwrJJLxSdmo
riz75EXgbj3XGdFK/EXSSfp5rWS6bs64ghQ7f5lO+qcEa9d4/UmADuQM
-----END PRIVATE KEY-----`,
};

describe("undici dispatcher compatibility", () => {
  it("bridges an undici 8 agent to Node fetch", async () => {
    const server = createServer((_request, response) => {
      response.end("wrapped response");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP listener.");
    }

    const dispatcher = new Dispatcher1Wrapper(new Agent());

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        dispatcher,
      } as RequestInit & { dispatcher: Dispatcher1Wrapper });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("wrapped response");
    } finally {
      await dispatcher.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  // GHSA-qrxm-fqhp-jwvm: a TLS 1.2 server that renegotiates to a certificate
  // for another host must fail the request, not crash the process.
  it.fails("rejects a renegotiated certificate for another host without crashing", async () => {
    const defaultCertificates = getCACertificates("default");
    setDefaultCACertificates([...defaultCertificates, LOCALHOST.cert, WRONG_HOST.cert]);
    const uncaught: unknown[] = [];
    process.setUncaughtExceptionCaptureCallback((error) => uncaught.push(error));

    const server = createTlsServer(
      {
        ...LOCALHOST,
        maxVersion: "TLSv1.2",
        minVersion: "TLSv1.2",
        secureOptions: constants.SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION,
      },
      (socket) => {
        socket.on("error", () => {});
        socket.once("data", () => {
          socket.setKeyCert(WRONG_HOST);
          socket.renegotiate({ rejectUnauthorized: false }, () => {});
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP listener.");
    }

    const dispatcher = await createPublicDispatcher({ allowLoopback: true });

    try {
      const error = await fetchWithDispatcher(`https://localhost:${address.port}`, {
        dispatcher,
      }).catch((error: unknown) => error);

      expect(uncaught).toEqual([]);
      expect(error).toMatchObject({ cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } });
    } finally {
      await dispatcher.destroy();
      server.close();
      process.setUncaughtExceptionCaptureCallback(null);
      setDefaultCACertificates(defaultCertificates);
    }
  });
});
