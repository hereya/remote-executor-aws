// Test-time stub for the published `hereya-cli` package. The real package is
// not bundled into the test environment — we only exercise the adapter
// boundary, not the resolver internals.
export const InfrastructureType = {
  aws: "aws",
  local: "local",
} as const;

export type InfrastructureTypeT = (typeof InfrastructureType)[keyof typeof InfrastructureType];

export const awsProviderFactory = () => ({});

export function registerInfrastructureProvider(
  _type: string,
  _factory: () => unknown
): void {}

export function resetInfrastructureProviders(): void {}

export function getInfrastructure(_input: { type: string }): {
  supported: false;
} {
  return { supported: false };
}

export type ResolveEnvValuesInput = {
  env: Record<string, string>;
  markSecret?: boolean;
  project?: string;
  workspace?: string;
};

export type ResolveEnvValuesOutput = Record<string, string>;

export type GetWorkspaceEnvFn = (input: {
  project: string;
  workspace: string;
}) => Promise<
  | { env: Record<string, string>; success: true }
  | { reason: string; success: false }
>;

export type MintInstallationTokenFn = (input: {
  appId: string;
  installationId: string;
  privateKey: string;
}) => Promise<string>;

export type ResolveSimpleEnvFn = (
  env: Record<string, string>
) => Promise<Record<string, string>>;

export type GetInfrastructureFn = (input: { type: string }) => {
  supported: false;
};

export interface ResolveEnvProviders {
  getInfrastructure: GetInfrastructureFn;
  getWorkspaceEnv?: GetWorkspaceEnvFn;
  mintInstallationToken?: MintInstallationTokenFn;
  resolveSimpleEnv?: ResolveSimpleEnvFn;
}

/**
 * Stub of the real resolver that's just rich enough to exercise the adapter:
 *   - `aws:foo` becomes `RESOLVED:foo` (no provider call — keeps the stub
 *     self-contained).
 *   - `github-app:<id?>` markers get resolved via the injected
 *     `getWorkspaceEnv` + `mintInstallationToken` + `resolveSimpleEnv`,
 *     mirroring the production code path. Markers are LEFT IN PLACE on any
 *     fetch failure — exactly matching `resolveGithubAppMarkers`'s
 *     warn-and-pass-through behaviour.
 */
export async function resolveEnvValues(
  input: ResolveEnvValuesInput,
  providers?: ResolveEnvProviders
): Promise<ResolveEnvValuesOutput> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env)) {
    out[k] = v.startsWith("aws:") ? `RESOLVED:${v.slice(4)}` : v;
  }

  // Mirror `resolveGithubAppMarkers` behaviour from the real resolver — only
  // attempt to resolve markers if all three github-app providers are wired
  // and the workspace/project are known.
  const needsToken = Object.values(out).some(
    (v) => typeof v === "string" && v.startsWith("github-app:")
  );
  if (!needsToken) return out;
  if (!providers) return out;
  if (!input.workspace || !input.project) return out;

  const { getWorkspaceEnv, mintInstallationToken, resolveSimpleEnv } =
    providers;
  if (!getWorkspaceEnv || !mintInstallationToken || !resolveSimpleEnv)
    return out;

  const wsEnv$ = await getWorkspaceEnv({
    project: input.project,
    workspace: input.workspace,
  });
  if (!wsEnv$.success) return out;

  const wsResolved = await resolveSimpleEnv(wsEnv$.env);
  const appId = wsResolved.hereyaGithubAppId;
  const installationIdFromEnv = wsResolved.hereyaGithubAppInstallationId;
  const privateKey = wsResolved.hereyaGithubAppPrivateKey;
  if (!appId || !privateKey) return out;

  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== "string" || !v.startsWith("github-app:")) continue;
    const installationId = v.slice("github-app:".length) || installationIdFromEnv;
    if (!installationId) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      out[k] = await mintInstallationToken({
        appId,
        installationId,
        privateKey,
      });
    } catch {
      // leave marker unresolved
    }
  }

  return out;
}

export async function resolveGithubAppMarkers<T>(resolved: T): Promise<T> {
  return resolved;
}

// ---------------------------------------------------------------------------
// mintInstallationToken stub
// ---------------------------------------------------------------------------
//
// The real implementation calls `@octokit/auth-app`; tests override the
// function via `setMintInstallationTokenStub` to return a fake token. State
// is held on `globalThis` so the module instance the adapter pulls in (via
// jest's `moduleNameMapper` rewrite of `hereya-cli`) and the module instance
// the test imports directly share the same backing stub — Jest may otherwise
// resolve them as separate instances depending on path keys.

export type MintInstallationTokenInput = {
  appId: string;
  installationId: string;
  privateKey: string;
};

type MintStubFn = (input: MintInstallationTokenInput) => Promise<string>;

const MINT_STUB_KEY = "__hereyaMintInstallationTokenStub";

const defaultMintStub: MintStubFn = async () => {
  throw new Error(
    "mintInstallationToken stub not configured — call setMintInstallationTokenStub() in your test"
  );
};

function getMintStub(): MintStubFn {
  return (
    ((globalThis as Record<string, unknown>)[MINT_STUB_KEY] as MintStubFn) ??
    defaultMintStub
  );
}

export function setMintInstallationTokenStub(fn: MintStubFn): void {
  (globalThis as Record<string, unknown>)[MINT_STUB_KEY] = fn;
}

export function resetMintInstallationTokenStub(): void {
  delete (globalThis as Record<string, unknown>)[MINT_STUB_KEY];
}

export async function mintInstallationToken(
  input: MintInstallationTokenInput
): Promise<string> {
  return getMintStub()(input);
}
