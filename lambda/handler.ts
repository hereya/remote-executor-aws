import {
  AutoScalingClient,
  SetDesiredCapacityCommand,
} from "@aws-sdk/client-auto-scaling";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

import { resolveEnvForJob } from "./resolve-env-adapter";
import { verifyBrokerJwt } from "./verify-jwt";

const HEREYA_CLOUD_URL = requireEnv("HEREYA_CLOUD_URL");
const JTI_CACHE_TABLE = requireEnv("JTI_CACHE_TABLE");
const ASG_NAME = requireEnv("ASG_NAME");
const EXPECTED_BROKER_AUD = requireEnv("EXPECTED_BROKER_AUD");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const asg = new AutoScalingClient({});

interface BrokerWebhookBody {
  jobId?: string;
  jobType?: string;
  payload?: Record<string, unknown>;
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  let jobIdForFailure: string | undefined;
  let tokenForFailure: string | undefined;
  try {
    const rawBody = readRawBody(event);
    const token = readBrokerToken(event);
    if (!token) {
      return jsonResponse(401, { error: "missing X-Hereya-Broker-Token" });
    }

    tokenForFailure = token;

    const claims = await verifyBrokerJwt(token, {
      jwksUrl: `${HEREYA_CLOUD_URL}/.well-known/jwks.json`,
      expectedAud: EXPECTED_BROKER_AUD,
      rawBody,
    });

    // Replay protection — Dynamo conditional write.
    const replayed = await tryRecordJti(claims.jti, claims.exp);
    if (replayed) {
      return jsonResponse(401, { error: "replay" });
    }

    let body: BrokerWebhookBody = {};
    try {
      body = rawBody ? (JSON.parse(rawBody) as BrokerWebhookBody) : {};
    } catch {
      return jsonResponse(400, { error: "invalid JSON body" });
    }

    const jobId = body.jobId ?? claims.jobId;
    const jobType = body.jobType ?? claims.jobType;
    if (!jobId || !jobType) {
      return jsonResponse(400, { error: "missing jobId/jobType" });
    }

    jobIdForFailure = jobId;

    if (jobType === "resolve-env") {
      return await handleResolveEnv({ jobId, body, token });
    }

    return await handleHeavyweight();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("jwt:")) {
      return jsonResponse(401, { error: message });
    }

    console.error("broker.handler.error", { message });
    if (jobIdForFailure && tokenForFailure) {
      await patchJobFailed(jobIdForFailure, message, tokenForFailure);
    }

    return jsonResponse(500, { error: "internal" });
  }
}

async function handleResolveEnv(input: {
  jobId: string;
  body: BrokerWebhookBody;
  token: string;
}): Promise<APIGatewayProxyStructuredResultV2> {
  // hereya-cloud must inline the resolve-env payload in the webhook body —
  // the Lambda has no workspace token to call back and fetch it.
  if (!input.body.payload) {
    await patchJobFailed(
      input.jobId,
      "resolve-env webhook missing payload (hereya-cloud must inline it)",
      input.token
    );
    return jsonResponse(400, {
      error: "resolve-env webhook missing payload",
    });
  }

  try {
    const env = await resolveEnvForJob({
      payload: input.body.payload,
      brokerToken: input.token,
      cloudUrl: HEREYA_CLOUD_URL,
      jobId: input.jobId,
    });
    await patchJobCompleted(input.jobId, { env }, input.token);
    return jsonResponse(200, { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    // Always log so the failure shows up in CloudWatch — patchJobFailed
    // also writes to the DB but having it in CW logs makes triage faster
    // (and survives if the PATCH itself errors).
    console.error("broker.resolve-env.error", { jobId: input.jobId, message, stack });
    await patchJobFailed(input.jobId, message, input.token);
    return jsonResponse(500, { error: message });
  }
}

async function handleHeavyweight(): Promise<APIGatewayProxyStructuredResultV2> {
  // Idempotent — concurrent webhooks all succeed; ASG launches at most one
  // instance because MaxSize=1. The long-lived EXECUTOR_TOKEN is already
  // baked into the ASG launch template via Secrets Manager (see CDK stack),
  // so no bootstrap-JWT plumbing is required on the wake path.
  await asg.send(
    new SetDesiredCapacityCommand({
      AutoScalingGroupName: ASG_NAME,
      DesiredCapacity: 1,
    })
  );

  return jsonResponse(202, { status: "starting" });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} environment variable is required`);
  }

  return v;
}

function readRawBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) return "";
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, "base64").toString("utf8");
  }

  return event.body;
}

function readBrokerToken(event: APIGatewayProxyEventV2): string | undefined {
  const headers = event.headers ?? {};
  // API Gateway HTTP API v2 events lower-case header keys.
  return (
    headers["x-hereya-broker-token"] ??
    headers["X-Hereya-Broker-Token"] ??
    undefined
  );
}

function jsonResponse(
  statusCode: number,
  body: unknown
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function tryRecordJti(jti: string, exp: number): Promise<boolean> {
  // returns true if it's a replay (already recorded), false if first-seen
  const expiresAt = exp + 60; // 60 s slack past JWT exp
  try {
    await ddb.send(
      new PutCommand({
        TableName: JTI_CACHE_TABLE,
        Item: { jti, expiresAt },
        ConditionExpression: "attribute_not_exists(jti)",
      })
    );
    return false;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "ConditionalCheckFailedException") {
      return true;
    }

    throw err;
  }
}

async function patchJobCompleted(
  jobId: string,
  result: Record<string, unknown>,
  token: string
): Promise<void> {
  const resp = await fetch(
    `${HEREYA_CLOUD_URL}/api/executor/jobs/${encodeURIComponent(jobId)}`,
    {
      method: "PATCH",
      headers: {
        "X-Hereya-Broker-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "completed", result }),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`patch completed failed (${resp.status}): ${text}`);
  }
}

async function patchJobFailed(
  jobId: string,
  message: string,
  token: string
): Promise<void> {
  try {
    await fetch(
      `${HEREYA_CLOUD_URL}/api/executor/jobs/${encodeURIComponent(jobId)}`,
      {
        method: "PATCH",
        headers: {
          "X-Hereya-Broker-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "failed", result: { error: message } }),
      }
    );
  } catch (err) {
    console.error("broker.patch_failed.error", err);
  }
}
