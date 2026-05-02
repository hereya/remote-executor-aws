import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { HereyaRemoteExecutorAwsStack } from '../lib/hereya-remote-executor-aws-stack';

function clearEnv(): void {
  delete process.env.mode;
  delete process.env.workspaceId;
  delete process.env.brokerConcurrency;
  delete process.env.idleTimeoutSeconds;
  delete process.env.HEREYA_CLOUD_URL;
  delete process.env.WORKSPACE;
  delete process.env.EXECUTOR_TOKEN;
  delete process.env.instanceType;
  delete process.env.instanceCount;
  delete process.env.vpcId;
}

// Render the ASG LaunchConfiguration's UserData (Fn::Base64-wrapped Fn::Join)
// into a single inspectable string. Any Ref/Fn within the join gets replaced
// with a sentinel so substring assertions still work.
function getUserDataString(template: Template): string {
  const lcs = template.findResources('AWS::AutoScaling::LaunchConfiguration');
  const lcKeys = Object.keys(lcs);
  if (lcKeys.length !== 1) {
    throw new Error(`expected exactly 1 LaunchConfiguration, got ${lcKeys.length}`);
  }
  const ud = lcs[lcKeys[0]].Properties.UserData;
  // UserData is { 'Fn::Base64': { 'Fn::Join': ['', [...parts]] } } or
  // { 'Fn::Base64': '<plain string>' }.
  const inner = ud['Fn::Base64'];
  if (typeof inner === 'string') return inner;
  const parts: unknown[] = inner['Fn::Join'][1];
  return parts.map((p) => (typeof p === 'string' ? p : '<<TOKEN>>')).join('');
}

function synthesise(env: Record<string, string>): Template {
  clearEnv();
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }

  const app = new cdk.App({
    context: {
      // Pre-seed the VPC lookup so synth doesn't need a live AWS account.
      'vpc-provider:account=123456789012:filter.isDefault=true:region=us-east-1:returnAsymmetricSubnets=true':
        {
          vpcId: 'vpc-12345',
          vpcCidrBlock: '10.0.0.0/16',
          ownerAccountId: '123456789012',
          availabilityZones: [],
          subnetGroups: [
            {
              name: 'Public',
              type: 'Public',
              subnets: [
                {
                  subnetId: 'subnet-1',
                  cidr: '10.0.0.0/24',
                  availabilityZone: 'us-east-1a',
                  routeTableId: 'rtb-1',
                },
                {
                  subnetId: 'subnet-2',
                  cidr: '10.0.1.0/24',
                  availabilityZone: 'us-east-1b',
                  routeTableId: 'rtb-1',
                },
              ],
            },
          ],
        },
    },
  });
  const stack = new HereyaRemoteExecutorAwsStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('HereyaRemoteExecutorAwsStack — always-on mode (default)', () => {
  it('synths an ASG with min=max=desired=instanceCount and no Lambda/OIDC/Jti', () => {
    const t = synthesise({
      WORKSPACE: 'test',
      EXECUTOR_TOKEN: 'tkn',
      instanceCount: '2',
    });

    t.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '2',
      MaxSize: '2',
      DesiredCapacity: '2',
    });

    // No broker resources in always-on mode
    t.resourceCountIs('AWS::Lambda::Function', 0);
    t.resourceCountIs('AWS::DynamoDB::Table', 0);
    t.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
  });

  it('emits only the always-on outputs', () => {
    const t = synthesise({ WORKSPACE: 'test', EXECUTOR_TOKEN: 'tkn' });
    t.hasOutput('executorAsgName', {});
    t.hasOutput('executorSecurityGroupId', {});
    expect(() => t.hasOutput('brokerWebhookUrl', {})).toThrow();
    expect(() => t.hasOutput('invokerRoleArn', {})).toThrow();
  });

  it('UserData contains NO drain plumbing (drain is ephemeral-only)', () => {
    const t = synthesise({ WORKSPACE: 'test', EXECUTOR_TOKEN: 'tkn' });
    const ud = getUserDataString(t);
    expect(ud).not.toContain('hereya-drain-asg.sh');
    expect(ud).not.toContain('OnFailure=hereya-drain.service');
    expect(ud).not.toContain('terminate-instance-in-auto-scaling-group');
    expect(ud).not.toContain('--should-decrement-desired-capacity');
  });
});

describe('HereyaRemoteExecutorAwsStack — ephemeral mode', () => {
  it('synths an ASG at min=0/max=1/desired=0', () => {
    const t = synthesise({
      mode: 'ephemeral',
      WORKSPACE: 'test',
      workspaceId: 'ws-1',
      EXECUTOR_TOKEN: 'tkn',
      HEREYA_CLOUD_URL: 'https://cloud.hereya.dev',
    });
    t.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '0',
      MaxSize: '1',
      DesiredCapacity: '0',
    });
  });

  it('provisions the broker Lambda with reserved concurrency, behind an HTTP API + Lambda authorizer (no Function URL)', () => {
    const t = synthesise({
      mode: 'ephemeral',
      WORKSPACE: 'test',
      workspaceId: 'ws-1',
      brokerConcurrency: '7',
      EXECUTOR_TOKEN: 'tkn',
      HEREYA_CLOUD_URL: 'https://cloud.hereya.dev',
    });

    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Timeout: 25,
      MemorySize: 512,
      ReservedConcurrentExecutions: 7,
      Environment: {
        Variables: Match.objectLike({
          HEREYA_CLOUD_URL: 'https://cloud.hereya.dev',
          WORKSPACE_ID: 'ws-1',
          WORKSPACE_NAME: 'test',
          EXPECTED_BROKER_AUD: 'broker:ws-1',
        }),
      },
    });

    // Two Lambdas: broker + authorizer.
    t.resourceCountIs('AWS::Lambda::Function', 2);
    // No Function URL — replaced by API Gateway HTTP API.
    t.resourceCountIs('AWS::Lambda::Url', 0);

    // API Gateway HTTP API + REQUEST authorizer + CUSTOM-auth route.
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'REQUEST',
      IdentitySource: ['$request.header.X-Hereya-Broker-Token'],
      AuthorizerResultTtlInSeconds: 0,
    });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      AuthorizationType: 'CUSTOM',
      RouteKey: 'POST /',
    });
  });

  it('provisions the BrokerJtiCache table with TTL', () => {
    const t = synthesise({
      mode: 'ephemeral',
      WORKSPACE: 'test',
      workspaceId: 'ws-1',
      EXECUTOR_TOKEN: 'tkn',
      HEREYA_CLOUD_URL: 'https://cloud.hereya.dev',
    });
    t.resourceCountIs('AWS::DynamoDB::Table', 1);
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'jti', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  it('does NOT provision OIDC provider or BrokerInvoker role (auth=NONE)', () => {
    const t = synthesise({
      mode: 'ephemeral',
      WORKSPACE: 'test',
      workspaceId: 'ws-1',
      EXECUTOR_TOKEN: 'tkn',
      HEREYA_CLOUD_URL: 'https://cloud.hereya.dev',
    });
    t.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    // No HereyaBrokerInvoker role exists either. Other IAM::Role resources
    // (executor instance role, Lambda execution role) may still be present.
    expect(() =>
      t.hasResourceProperties(
        'AWS::IAM::Role',
        Match.objectLike({ RoleName: 'HereyaBrokerInvoker-ws-1' }),
      ),
    ).toThrow();
  });

  it('emits all the install-time outputs', () => {
    const t = synthesise({
      mode: 'ephemeral',
      WORKSPACE: 'test',
      workspaceId: 'ws-1',
      EXECUTOR_TOKEN: 'tkn',
      HEREYA_CLOUD_URL: 'https://cloud.hereya.dev',
    });
    t.hasOutput('executorAsgName', {});
    t.hasOutput('executorSecurityGroupId', {});
    t.hasOutput('brokerWebhookUrl', {});
    t.hasOutput('brokerVersion', {});
    t.hasOutput('awsAccountId', {});
    t.hasOutput('region', {});
    t.hasOutput('brokerLambdaArn', {});
    // invokerRoleArn intentionally absent — see "does NOT provision OIDC ..."
    expect(() => t.hasOutput('invokerRoleArn', {})).toThrow();
  });

  it('throws when workspaceId is missing in ephemeral mode', () => {
    expect(() =>
      synthesise({
        mode: 'ephemeral',
        WORKSPACE: 'test',
        EXECUTOR_TOKEN: 'tkn',
        HEREYA_CLOUD_URL: 'https://cloud.hereya.dev',
      }),
    ).toThrow(/workspaceId is required/);
  });

  it('UserData wires the drain script + OnFailure unit + atomic terminate-and-decrement', () => {
    const t = synthesise({
      mode: 'ephemeral',
      WORKSPACE: 'test',
      workspaceId: 'ws-1',
      EXECUTOR_TOKEN: 'tkn',
      HEREYA_CLOUD_URL: 'https://cloud.hereya.dev',
    });
    const ud = getUserDataString(t);
    expect(ud).toContain('hereya-drain-asg.sh');
    expect(ud).toContain('OnFailure=hereya-drain.service');
    expect(ud).toContain('terminate-instance-in-auto-scaling-group');
    expect(ud).toContain('--should-decrement-desired-capacity');
  });
});
