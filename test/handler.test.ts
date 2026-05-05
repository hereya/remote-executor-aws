/**
 * Unit tests for the broker Lambda handler.
 *
 * The handler is fully mocked at the AWS SDK and JWT-verify boundaries — we
 * verify the handler's branching, replay protection, and that the heavyweight
 * branch invokes SetDesiredCapacity exactly once.
 */

// Set required env vars before importing the handler.
process.env.HEREYA_CLOUD_URL = "https://cloud.hereya.test";
process.env.JTI_CACHE_TABLE = "JtiCache";
process.env.ASG_NAME = "hereya-executor-test";
process.env.EXPECTED_BROKER_AUD = "broker:ws-1";

const mockFetch = jest.fn();
(global as unknown as { fetch: jest.Mock }).fetch = mockFetch;

// --- Mock AWS SDK clients ---------------------------------------------------

const mockDdbSend = jest.fn();
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockDdbSend }) },
  PutCommand: jest.fn().mockImplementation((args: unknown) => ({
    __type: "PutCommand",
    args,
  })),
}));

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

const mockAsgSend = jest.fn();
jest.mock("@aws-sdk/client-auto-scaling", () => ({
  AutoScalingClient: jest.fn().mockImplementation(() => ({ send: mockAsgSend })),
  SetDesiredCapacityCommand: jest.fn().mockImplementation((args: unknown) => ({
    __type: "SetDesiredCapacity",
    args,
  })),
}));

// --- Mock JWT verify --------------------------------------------------------

const mockVerify = jest.fn();
jest.mock("../lambda/verify-jwt", () => ({
  verifyBrokerJwt: (...args: unknown[]) => mockVerify(...args),
}));

import { handler } from "../lambda/handler";
import {
  setMintInstallationTokenStub,
  resetMintInstallationTokenStub,
} from "./stubs/hereya-cli-github-app";
import type { LambdaFunctionURLEvent } from "aws-lambda";

function makeEvent(opts: {
  body: unknown;
  token?: string;
}): LambdaFunctionURLEvent {
  const bodyStr =
    typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    headers: {
      "x-hereya-broker-token": opts.token ?? "tkn",
      "content-type": "application/json",
    },
    requestContext: {
      accountId: "123",
      apiId: "api",
      domainName: "x",
      domainPrefix: "x",
      http: {
        method: "POST",
        path: "/",
        protocol: "HTTP/1.1",
        sourceIp: "1.2.3.4",
        userAgent: "test",
      },
      requestId: "req",
      routeKey: "$default",
      stage: "$default",
      time: "now",
      timeEpoch: 0,
    } as LambdaFunctionURLEvent["requestContext"],
    body: bodyStr,
    isBase64Encoded: false,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetMintInstallationTokenStub();
});

describe("broker handler — resolve-env happy path", () => {
  it("resolves env via adapter and PATCHes job completed", async () => {
    mockVerify.mockResolvedValue({
      jti: "jti-1",
      exp: Math.floor(Date.now() / 1000) + 60,
      jobId: "job-1",
      jobType: "resolve-env",
    });
    mockDdbSend.mockResolvedValue({});
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const event = makeEvent({
      body: {
        jobId: "job-1",
        jobType: "resolve-env",
        payload: { env: { DB_URL: "aws:db_url", PLAIN: "x" } },
      },
    });
    const res = await handler(event);

    expect((res as { statusCode: number }).statusCode).toBe(200);
    const callArgs = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes("/api/executor/jobs/job-1")
    );
    expect(callArgs).toBeDefined();
    const patchedBody = JSON.parse(callArgs![1].body as string);
    expect(patchedBody.status).toBe("completed");
    expect(patchedBody.result.env.DB_URL).toBe("RESOLVED:db_url");
    expect(patchedBody.result.env.PLAIN).toBe("x");

    // Heavyweight branch must NOT have fired
    expect(mockAsgSend).not.toHaveBeenCalled();
  });
});

describe("broker handler — heavyweight wake", () => {
  it("calls SetDesiredCapacity(1) exactly once", async () => {
    mockVerify.mockResolvedValue({
      jti: "jti-2",
      exp: Math.floor(Date.now() / 1000) + 60,
      jobId: "job-2",
      jobType: "provision",
    });
    mockDdbSend.mockResolvedValue({});
    mockAsgSend.mockResolvedValue({});

    const res = await handler(
      makeEvent({ body: { jobId: "job-2", jobType: "provision" } })
    );

    expect((res as { statusCode: number }).statusCode).toBe(202);
    expect(mockAsgSend).toHaveBeenCalledTimes(1);
    const cmd = mockAsgSend.mock.calls[0][0];
    expect(cmd.__type).toBe("SetDesiredCapacity");
    expect(cmd.args).toEqual({
      AutoScalingGroupName: "hereya-executor-test",
      DesiredCapacity: 1,
    });
  });

  it("is idempotent across concurrent webhooks", async () => {
    mockVerify
      .mockResolvedValueOnce({
        jti: "jti-3a",
        exp: Math.floor(Date.now() / 1000) + 60,
        jobId: "job-3a",
        jobType: "provision",
      })
      .mockResolvedValueOnce({
        jti: "jti-3b",
        exp: Math.floor(Date.now() / 1000) + 60,
        jobId: "job-3b",
        jobType: "deploy",
      });
    mockDdbSend.mockResolvedValue({});
    mockAsgSend.mockResolvedValue({});

    const [r1, r2] = await Promise.all([
      handler(makeEvent({ body: { jobId: "job-3a", jobType: "provision" } })),
      handler(makeEvent({ body: { jobId: "job-3b", jobType: "deploy" } })),
    ]);

    expect((r1 as { statusCode: number }).statusCode).toBe(202);
    expect((r2 as { statusCode: number }).statusCode).toBe(202);
    // Both webhooks call SetDesiredCapacity — that's fine; ASG MaxSize=1
    // ensures only one instance launches.
    expect(mockAsgSend).toHaveBeenCalledTimes(2);
  });
});

describe("broker handler — replay rejection", () => {
  it("returns 401 on duplicate jti", async () => {
    mockVerify.mockResolvedValue({
      jti: "jti-dup",
      exp: Math.floor(Date.now() / 1000) + 60,
      jobId: "job-x",
      jobType: "resolve-env",
    });
    mockDdbSend.mockImplementation(async () => {
      const err = new Error("conditional check failed") as Error & {
        name: string;
      };
      err.name = "ConditionalCheckFailedException";
      throw err;
    });

    const res = await handler(
      makeEvent({ body: { jobId: "job-x", jobType: "resolve-env" } })
    );
    expect((res as { statusCode: number }).statusCode).toBe(401);
    expect(mockAsgSend).not.toHaveBeenCalled();
  });
});

describe("broker handler — signature failure", () => {
  it("returns 401 when JWT verify throws jwt: error", async () => {
    mockVerify.mockRejectedValue(
      new Error("jwt: signature/verification failed")
    );
    const res = await handler(
      makeEvent({ body: { jobId: "j", jobType: "resolve-env" } })
    );
    expect((res as { statusCode: number }).statusCode).toBe(401);
  });

  it("returns 401 when no token header", async () => {
    const event = makeEvent({ body: { jobId: "j", jobType: "resolve-env" } });
    delete (event.headers as Record<string, string>)["x-hereya-broker-token"];
    const res = await handler(event);
    expect((res as { statusCode: number }).statusCode).toBe(401);
  });
});

describe("broker handler — resolve-env without payload", () => {
  it("returns 400 when payload missing", async () => {
    mockVerify.mockResolvedValue({
      jti: "jti-np",
      exp: Math.floor(Date.now() / 1000) + 60,
      jobId: "j",
      jobType: "resolve-env",
    });
    mockDdbSend.mockResolvedValue({});
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));

    const res = await handler(
      makeEvent({ body: { jobId: "j", jobType: "resolve-env" } })
    );
    expect((res as { statusCode: number }).statusCode).toBe(400);
  });
});

describe("broker handler — resolve-env with github-app marker", () => {
  it("mints an installation token, replaces the github-app: marker, and PATCHes completed", async () => {
    mockVerify.mockResolvedValue({
      jti: "jti-gh-1",
      exp: Math.floor(Date.now() / 1000) + 60,
      jobId: "job-gh-1",
      jobType: "resolve-env",
    });
    mockDdbSend.mockResolvedValue({});

    setMintInstallationTokenStub(async (input) => {
      expect(input.appId).toBe("12345");
      expect(input.installationId).toBe("67890");
      expect(input.privateKey).toBe("PEM_FAKE");
      return "ghs_FAKE_INSTALLATION_TOKEN";
    });

    // First fetch: GET github-app-config
    // Second fetch: PATCH job completed
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        String(url).includes("/github-app-config") &&
        (init?.method ?? "GET") === "GET"
      ) {
        return new Response(
          JSON.stringify({
            appId: "12345",
            installationId: "67890",
            privateKey: "PEM_FAKE",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      // PATCH job completed
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const event = makeEvent({
      body: {
        jobId: "job-gh-1",
        jobType: "resolve-env",
        payload: {
          env: {
            hereyaGitPassword: "github-app:67890",
            hereyaGitUsername: "x-access-token",
            hereyaGitRemoteUrl: "https://github.com/foo/bar.git",
          },
          project: "foo/bar",
          workspace: "default",
        },
      },
    });

    const res = await handler(event);
    expect((res as { statusCode: number }).statusCode).toBe(200);

    // Confirm the github-app-config endpoint was called with the broker token
    const cfgCall = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes("/github-app-config")
    );
    expect(cfgCall).toBeDefined();
    expect(String(cfgCall![0])).toBe(
      "https://cloud.hereya.test/api/executor/jobs/job-gh-1/github-app-config"
    );
    expect((cfgCall![1] as RequestInit).headers).toMatchObject({
      "X-Hereya-Broker-Token": "tkn",
    });

    // Confirm the PATCH (completed) carried the resolved env with the minted token
    const patchCall = mockFetch.mock.calls.find(
      (c) =>
        String(c[0]).includes("/api/executor/jobs/job-gh-1") &&
        !String(c[0]).includes("/github-app-config")
    );
    expect(patchCall).toBeDefined();
    const patchedBody = JSON.parse(
      (patchCall![1] as RequestInit).body as string
    );
    expect(patchedBody.status).toBe("completed");
    expect(patchedBody.result.env.hereyaGitPassword).toBe(
      "ghs_FAKE_INSTALLATION_TOKEN"
    );
    // The marker should be GONE — never `github-app:67890`
    expect(patchedBody.result.env.hereyaGitPassword).not.toBe(
      "github-app:67890"
    );
    // Other fields untouched
    expect(patchedBody.result.env.hereyaGitUsername).toBe("x-access-token");
    expect(patchedBody.result.env.hereyaGitRemoteUrl).toBe(
      "https://github.com/foo/bar.git"
    );
  });

  it("leaves the github-app: marker unresolved (still PATCHes completed) when the cloud endpoint returns 401", async () => {
    mockVerify.mockResolvedValue({
      jti: "jti-gh-2",
      exp: Math.floor(Date.now() / 1000) + 60,
      jobId: "job-gh-2",
      jobType: "resolve-env",
    });
    mockDdbSend.mockResolvedValue({});

    let mintCalled = false;
    setMintInstallationTokenStub(async () => {
      mintCalled = true;
      return "should_not_be_called";
    });

    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("/github-app-config")) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const event = makeEvent({
      body: {
        jobId: "job-gh-2",
        jobType: "resolve-env",
        payload: {
          env: {
            hereyaGitPassword: "github-app:67890",
            hereyaGitUsername: "x-access-token",
          },
          project: "foo/bar",
          workspace: "default",
        },
      },
    });

    const res = await handler(event);
    // Resolver doesn't throw — it just leaves the marker in place.
    expect((res as { statusCode: number }).statusCode).toBe(200);
    expect(mintCalled).toBe(false);

    const patchCall = mockFetch.mock.calls.find(
      (c) =>
        String(c[0]).includes("/api/executor/jobs/job-gh-2") &&
        !String(c[0]).includes("/github-app-config")
    );
    expect(patchCall).toBeDefined();
    const patchedBody = JSON.parse(
      (patchCall![1] as RequestInit).body as string
    );
    // Status is still completed — the resolver returns success with markers
    // left in place, mirroring CLI behaviour.
    expect(patchedBody.status).toBe("completed");
    expect(patchedBody.result.env.hereyaGitPassword).toBe("github-app:67890");
  });
});
