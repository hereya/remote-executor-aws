import { createRemoteJWKSet, jwtVerify } from "jose";

const HEREYA_CLOUD_URL = requireEnv("HEREYA_CLOUD_URL");
const EXPECTED_BROKER_AUD = requireEnv("EXPECTED_BROKER_AUD");

// Module-scope JWKS — survives across warm invocations of the same container.
const jwks = createRemoteJWKSet(
  new URL("/.well-known/jwks.json", HEREYA_CLOUD_URL),
  { cooldownDuration: 30_000 },
);

interface AuthorizerEvent {
  headers?: Record<string, string | undefined>;
  // HTTP API v2 authorizer event — only `headers` is used here.
}

interface AuthorizerResponse {
  isAuthorized: boolean;
  context?: Record<string, unknown>;
}

export const handler = async (
  event: AuthorizerEvent,
): Promise<AuthorizerResponse> => {
  try {
    const headers = event.headers ?? {};
    // HTTP API v2 lower-cases header names, but accept both spellings to be
    // resilient to API GW shape changes.
    const token =
      headers["x-hereya-broker-token"] ?? headers["X-Hereya-Broker-Token"];
    if (!token) {
      console.warn("authorizer: no X-Hereya-Broker-Token header");
      return { isAuthorized: false };
    }

    const { payload } = await jwtVerify(token, jwks, {
      audience: EXPECTED_BROKER_AUD,
      // exp + signature checked by jose automatically.
    });

    // Pass useful claims through to the broker handler so it doesn't have to
    // re-decode (it still verifies bh + jti).
    return {
      isAuthorized: true,
      context: {
        jobId: String(payload.jobId ?? ""),
        jobType: String(payload.jobType ?? ""),
        workspaceId: String(payload.workspaceId ?? ""),
        jti: String(payload.jti ?? ""),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("authorizer: jwt verify failed", message);
    return { isAuthorized: false };
  }
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} environment variable is required`);
  }

  return v;
}
