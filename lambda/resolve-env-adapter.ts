import {
  awsProviderFactory,
  registerInfrastructureProvider,
  resetInfrastructureProviders,
  resolveEnvValues,
  getInfrastructure,
  InfrastructureType,
  mintInstallationToken,
  type ResolveEnvValuesInput,
  type ResolveEnvValuesOutput,
} from "hereya-cli";

let registered = false;

/**
 * Lazily wire only the AWS infrastructure provider into the registry — we do
 * NOT want the `local` provider (filesystem, exec) inside a Lambda. Idempotent
 * across warm invocations.
 */
function ensureProvidersRegistered(): void {
  if (registered) return;
  resetInfrastructureProviders();
  registerInfrastructureProvider(InfrastructureType.aws, awsProviderFactory);
  registered = true;
}

/**
 * Adapter between the broker webhook payload and the published `resolveEnvValues`
 * helper from `hereya-cli`. Webhook payload shape:
 *   { env: {[k]: string}, project?: string, workspace?: string, markSecret?: boolean }
 *
 * Wires all four resolver providers:
 *   - `getInfrastructure`: AWS-only registry (no `local`)
 *   - `getWorkspaceEnv`: callback to hereya-cloud's
 *     `/api/executor/jobs/:id/github-app-config` endpoint to fetch the
 *     workspace's GitHub App config (broker-token authenticated).
 *   - `mintInstallationToken`: directly from `hereya-cli`'s github-app helper,
 *     mints a fresh `ghs_…` installation token via @octokit/auth-app.
 *   - `resolveSimpleEnv`: recursive AWS-only pass with no github-app
 *     providers (avoids infinite recursion since `resolveSimpleEnv` is what
 *     dereferences `aws:` markers inside the workspace env config — the env
 *     map that contains `hereyaGithubAppPrivateKey`).
 */
export async function resolveEnvForJob(input: {
  payload: Record<string, unknown>;
  brokerToken: string;
  cloudUrl: string;
  jobId: string;
}): Promise<ResolveEnvValuesOutput> {
  ensureProvidersRegistered();

  const { payload, brokerToken, cloudUrl, jobId } = input;
  const env = (payload.env ?? {}) as Record<string, string>;
  if (typeof env !== "object" || env === null) {
    throw new Error("payload.env must be an object");
  }

  const resolveInput: ResolveEnvValuesInput = {
    env,
    markSecret: Boolean(payload.markSecret),
    project:
      typeof payload.project === "string" ? payload.project : undefined,
    workspace:
      typeof payload.workspace === "string" ? payload.workspace : undefined,
  };

  return resolveEnvValues(resolveInput, {
    getInfrastructure,
    getWorkspaceEnv: async () => {
      const url = `${cloudUrl}/api/executor/jobs/${encodeURIComponent(
        jobId
      )}/github-app-config`;
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          "X-Hereya-Broker-Token": brokerToken,
        },
      });
      if (!resp.ok) {
        return {
          success: false,
          reason: `github-app-config fetch failed: ${resp.status}`,
        };
      }
      const data = (await resp.json()) as {
        appId?: string | null;
        installationId?: string | null;
        privateKey?: string | null;
      };
      const out: Record<string, string> = {};
      if (data.appId) out.hereyaGithubAppId = data.appId;
      if (data.installationId)
        out.hereyaGithubAppInstallationId = data.installationId;
      if (data.privateKey) out.hereyaGithubAppPrivateKey = data.privateKey;
      return { success: true, env: out };
    },
    mintInstallationToken,
    // Recursive AWS-only pass — no github-app providers wired so there's no
    // infinite recursion (resolveSimpleEnv is itself called by the github-app
    // marker resolver to dereference `aws:` markers in the workspace env, e.g.
    // when `hereyaGithubAppPrivateKey = "aws:<arn>"`).
    resolveSimpleEnv: async (e: Record<string, string>) =>
      resolveEnvValues({ env: e }, { getInfrastructure }),
  });
}
