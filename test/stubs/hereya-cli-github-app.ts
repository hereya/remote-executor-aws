// Test-time stub for `hereya-cli/dist/lib/github-app.js`. The real
// implementation calls `@octokit/auth-app`; tests override the function via
// `setMintInstallationTokenStub` to return a fake token.
//
// State is held on `globalThis` so the module instance the adapter pulls in
// (via the `moduleNameMapper` rewrite of `hereya-cli/dist/lib/github-app.js`)
// and the module instance the test imports directly share the same backing
// stub — Jest may otherwise resolve them as separate instances depending on
// path keys.

export type MintInstallationTokenInput = {
  appId: string;
  installationId: string;
  privateKey: string;
};

type StubFn = (input: MintInstallationTokenInput) => Promise<string>;

const STUB_KEY = "__hereyaMintInstallationTokenStub";

const defaultStub: StubFn = async () => {
  throw new Error(
    "mintInstallationToken stub not configured — call setMintInstallationTokenStub() in your test"
  );
};

function getStub(): StubFn {
  return (
    ((globalThis as Record<string, unknown>)[STUB_KEY] as StubFn) ?? defaultStub
  );
}

export function setMintInstallationTokenStub(fn: StubFn): void {
  (globalThis as Record<string, unknown>)[STUB_KEY] = fn;
}

export function resetMintInstallationTokenStub(): void {
  delete (globalThis as Record<string, unknown>)[STUB_KEY];
}

export async function mintInstallationToken(
  input: MintInstallationTokenInput
): Promise<string> {
  return getStub()(input);
}
