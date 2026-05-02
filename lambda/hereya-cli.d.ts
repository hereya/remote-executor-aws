// Local ambient typings for the published `hereya-cli` package's broker-facing
// exports. The real types live in `hereya-cli`'s `src/index.ts`. Once a
// `hereya-cli` version with these exports is reliably resolvable via npm in
// every dev/test environment, this file becomes redundant.

declare module "hereya-cli" {
  export const InfrastructureType: {
    readonly aws: "aws";
    readonly local: "local";
  };

  export type ResolveEnvValuesInput = {
    env: Record<string, string>;
    markSecret?: boolean;
    project?: string;
    workspace?: string;
  };

  export type ResolveEnvValuesOutput = Record<string, string>;

  export type GetInfrastructureFn = (input: { type: string }) => unknown;

  export interface ResolveEnvProviders {
    getInfrastructure: GetInfrastructureFn;
    [k: string]: unknown;
  }

  export function resolveEnvValues(
    input: ResolveEnvValuesInput,
    providers: ResolveEnvProviders
  ): Promise<ResolveEnvValuesOutput>;

  export function getInfrastructure(input: { type: string }): unknown;

  export const awsProviderFactory: () => unknown;

  export function registerInfrastructureProvider(
    type: string,
    factory: () => unknown
  ): void;

  export function resetInfrastructureProviders(): void;
}
