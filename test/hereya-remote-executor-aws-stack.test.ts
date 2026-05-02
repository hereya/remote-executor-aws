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
  delete process.env.useSpot;
}

// Render the ASG's UserData (Fn::Base64-wrapped Fn::Join) into a single
// inspectable string. Any Ref/Fn within the join gets replaced with a sentinel
// so substring assertions still work. Looks at LaunchConfiguration (on-demand
// path) OR LaunchTemplate (Spot path — UserData lives in LaunchTemplateData).
function getUserDataString(template: Template): string {
  const lcs = template.findResources('AWS::AutoScaling::LaunchConfiguration');
  const lcKeys = Object.keys(lcs);
  let ud: any;
  if (lcKeys.length === 1) {
    ud = lcs[lcKeys[0]].Properties.UserData;
  } else if (lcKeys.length === 0) {
    const lts = template.findResources('AWS::EC2::LaunchTemplate');
    const ltKeys = Object.keys(lts);
    if (ltKeys.length !== 1) {
      throw new Error(
        `expected exactly 1 LaunchConfiguration or LaunchTemplate, got ${lcKeys.length} LC / ${ltKeys.length} LT`,
      );
    }
    ud = lts[ltKeys[0]].Properties.LaunchTemplateData.UserData;
  } else {
    throw new Error(`expected exactly 1 LaunchConfiguration, got ${lcKeys.length}`);
  }
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

  it('emits the always-on outputs (incl. executorLogGroupName + executorPurchaseOption)', () => {
    const t = synthesise({ WORKSPACE: 'test', EXECUTOR_TOKEN: 'tkn' });
    t.hasOutput('executorAsgName', {});
    t.hasOutput('executorSecurityGroupId', {});
    t.hasOutput('executorLogGroupName', {});
    t.hasOutput('executorPurchaseOption', { Value: 'spot' });
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

  it('provisions a CloudWatch Log Group with 7-day retention', () => {
    const t = synthesise({ WORKSPACE: 'test', EXECUTOR_TOKEN: 'tkn' });
    t.resourceCountIs('AWS::Logs::LogGroup', 1);
    t.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 7,
    });
  });

  it('UserData installs the CloudWatch agent and switches the systemd unit to file logging', () => {
    const t = synthesise({ WORKSPACE: 'test', EXECUTOR_TOKEN: 'tkn' });
    const ud = getUserDataString(t);
    expect(ud).toContain('amazon-cloudwatch-agent');
    expect(ud).toContain('StandardOutput=append:/var/log/hereya-executor.log');
    expect(ud).toContain('StandardError=append:/var/log/hereya-executor.log');
  });

  it('attaches CloudWatchAgentServerPolicy to the executor instance role', () => {
    const t = synthesise({ WORKSPACE: 'test', EXECUTOR_TOKEN: 'tkn' });
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'ec2.amazonaws.com' },
          }),
        ]),
      }),
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp('CloudWatchAgentServerPolicy')]),
          ]),
        }),
      ]),
    });
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
    t.hasOutput('executorLogGroupName', {});
    t.hasOutput('executorPurchaseOption', { Value: 'spot' });
    t.hasOutput('brokerWebhookUrl', {});
    t.hasOutput('brokerVersion', {});
    t.hasOutput('awsAccountId', {});
    t.hasOutput('region', {});
    t.hasOutput('brokerLambdaArn', {});
    // invokerRoleArn intentionally absent — see "does NOT provision OIDC ..."
    expect(() => t.hasOutput('invokerRoleArn', {})).toThrow();
  });

  it('provisions a CloudWatch Log Group + CloudWatch agent in UserData (ephemeral too)', () => {
    const t = synthesise({
      mode: 'ephemeral',
      WORKSPACE: 'test',
      workspaceId: 'ws-1',
      EXECUTOR_TOKEN: 'tkn',
      HEREYA_CLOUD_URL: 'https://cloud.hereya.dev',
    });
    t.resourceCountIs('AWS::Logs::LogGroup', 1);
    t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });

    const ud = getUserDataString(t);
    expect(ud).toContain('amazon-cloudwatch-agent');
    expect(ud).toContain('StandardOutput=append:/var/log/hereya-executor.log');
    expect(ud).toContain('StandardError=append:/var/log/hereya-executor.log');
  });

  it('attaches CloudWatchAgentServerPolicy to the executor instance role (ephemeral)', () => {
    const t = synthesise({
      mode: 'ephemeral',
      WORKSPACE: 'test',
      workspaceId: 'ws-1',
      EXECUTOR_TOKEN: 'tkn',
      HEREYA_CLOUD_URL: 'https://cloud.hereya.dev',
    });
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'ec2.amazonaws.com' },
          }),
        ]),
      }),
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp('CloudWatchAgentServerPolicy')]),
          ]),
        }),
      ]),
    });
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

describe('HereyaRemoteExecutorAwsStack — Spot purchase mode (default)', () => {
  it('synth with default params produces ASG with MixedInstancesPolicy (price-capacity-optimized, 0% on-demand)', () => {
    const t = synthesise({ WORKSPACE: 'test', EXECUTOR_TOKEN: 'tkn' });

    t.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MixedInstancesPolicy: Match.objectLike({
        InstancesDistribution: Match.objectLike({
          OnDemandBaseCapacity: 0,
          OnDemandPercentageAboveBaseCapacity: 0,
          SpotAllocationStrategy: 'price-capacity-optimized',
        }),
        LaunchTemplate: Match.objectLike({
          Overrides: Match.arrayWith([Match.objectLike({ InstanceType: 't3.medium' })]),
        }),
      }),
    });

    // Spot path uses an EC2 LaunchTemplate, not an inline LaunchConfiguration.
    t.resourceCountIs('AWS::EC2::LaunchTemplate', 1);
    t.resourceCountIs('AWS::AutoScaling::LaunchConfiguration', 0);

    // Output reflects the chosen mode.
    t.hasOutput('executorPurchaseOption', { Value: 'spot' });
  });

  it('Spot ASG includes a t3a alternate when base instance class is t3', () => {
    const t = synthesise({ WORKSPACE: 'test', EXECUTOR_TOKEN: 'tkn' });
    t.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MixedInstancesPolicy: Match.objectLike({
        LaunchTemplate: Match.objectLike({
          Overrides: Match.arrayWith([
            Match.objectLike({ InstanceType: 't3.medium' }),
            Match.objectLike({ InstanceType: 't3a.medium' }),
          ]),
        }),
      }),
    });
  });

  it('synth with useSpot=false falls back to on-demand (LaunchConfiguration, no MixedInstancesPolicy)', () => {
    const t = synthesise({
      WORKSPACE: 'test',
      EXECUTOR_TOKEN: 'tkn',
      useSpot: 'false',
    });

    t.resourceCountIs('AWS::AutoScaling::LaunchConfiguration', 1);
    t.resourceCountIs('AWS::EC2::LaunchTemplate', 0);

    // Assert MixedInstancesPolicy is absent.
    const asgs = t.findResources('AWS::AutoScaling::AutoScalingGroup');
    const asgKeys = Object.keys(asgs);
    expect(asgKeys.length).toBe(1);
    expect(asgs[asgKeys[0]].Properties.MixedInstancesPolicy).toBeUndefined();

    t.hasOutput('executorPurchaseOption', { Value: 'on-demand' });
  });

  it('Spot mode works with ephemeral too (MixedInstancesPolicy + min=0/max=1/desired=0)', () => {
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
      MixedInstancesPolicy: Match.objectLike({
        InstancesDistribution: Match.objectLike({
          OnDemandPercentageAboveBaseCapacity: 0,
          SpotAllocationStrategy: 'price-capacity-optimized',
        }),
      }),
    });
    t.hasOutput('executorPurchaseOption', { Value: 'spot' });
  });

  it('useSpot=false in ephemeral mode also drops MixedInstancesPolicy', () => {
    const t = synthesise({
      mode: 'ephemeral',
      WORKSPACE: 'test',
      workspaceId: 'ws-1',
      useSpot: 'false',
      EXECUTOR_TOKEN: 'tkn',
      HEREYA_CLOUD_URL: 'https://cloud.hereya.dev',
    });
    t.resourceCountIs('AWS::AutoScaling::LaunchConfiguration', 1);
    t.resourceCountIs('AWS::EC2::LaunchTemplate', 0);
    t.hasOutput('executorPurchaseOption', { Value: 'on-demand' });
  });
});
