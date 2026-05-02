import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

const BROKER_VERSION = '0.6.5';

export class HereyaRemoteExecutorAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Required parameters (passed by hereya workspace executor install)
    // EXECUTOR_TOKEN uses a placeholder default to allow `cdk destroy` without env vars
    const executorToken = process.env['EXECUTOR_TOKEN'] || 'placeholder';

    const workspace = process.env['WORKSPACE'] || 'placeholder';

    // Optional parameters
    const hereyaCloudUrlRaw = process.env['HEREYA_CLOUD_URL'] || 'https://cloud.hereya.dev';
    const hereyaCloudUrl = hereyaCloudUrlRaw.replace(/\/+$/, '');
    const instanceType = process.env['instanceType'] || 't3.medium';
    const vpcId: string | undefined = process.env['vpcId'];
    const instanceCount = parseInt(process.env['instanceCount'] || '1', 10);

    // Mode: 'always-on' (default) or 'ephemeral'
    const mode = (process.env['mode'] || 'always-on') as 'always-on' | 'ephemeral';
    if (mode !== 'always-on' && mode !== 'ephemeral') {
      throw new Error(`Invalid mode: ${mode} (must be 'always-on' or 'ephemeral')`);
    }

    const isEphemeral = mode === 'ephemeral';

    // Ephemeral-only parameters
    const workspaceId = process.env['workspaceId'] || '';
    const brokerConcurrency = parseInt(process.env['brokerConcurrency'] || '50', 10);
    const idleTimeoutSeconds = parseInt(process.env['idleTimeoutSeconds'] || '600', 10);

    if (isEphemeral && !workspaceId) {
      throw new Error('workspaceId is required when mode=ephemeral');
    }

    // VPC
    const vpc = vpcId
      ? ec2.Vpc.fromLookup(this, 'Vpc', { vpcId })
      : ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: true });

    // Security group — outbound only, no inbound ports needed
    const sg = new ec2.SecurityGroup(this, 'ExecutorSG', {
      vpc,
      description: 'Hereya remote executor - outbound only',
      allowAllOutbound: true,
    });

    // IAM role with AdministratorAccess (executor provisions arbitrary infrastructure).
    // AdministratorAccess covers `autoscaling:SetDesiredCapacity` used by the
    // ephemeral systemd ExecStopPost — no extra grant needed.
    const role = new iam.Role(this, 'ExecutorRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Store executor token in Secrets Manager (works the same in both modes —
    // the ephemeral path explicitly reuses the long-lived token instead of
    // bootstrapping a redeem flow on each wake).
    const tokenSecret = new secretsmanager.Secret(this, 'ExecutorTokenSecret', {
      secretName: `/hereya/executor/${workspace}/token`,
      secretStringValue: cdk.SecretValue.unsafePlainText(executorToken),
    });

    // ASG name is referenced by the systemd ExecStopPost (ephemeral mode) and
    // by the broker Lambda env. We construct a stable, deterministic name and
    // pass it as the ASG's autoScalingGroupName so we can interpolate it into
    // UserData without circular Token issues.
    const asgName = `hereya-executor-${workspace}-${this.stackName}`.slice(0, 255);

    // UserData script
    const userData = ec2.UserData.forLinux();

    // Ephemeral-mode systemd extras
    const ephemeralStartArgs = isEphemeral
      ? ` --idle-timeout=${idleTimeoutSeconds} --concurrency=20`
      : '';
    const ephemeralAsgEnv = isEphemeral
      ? `Environment=ASG_NAME=${asgName}\n`
      : '';
    // Restart=always for always-on (a crash should restart). Restart=no for
    // ephemeral so a clean idle exit (rc=0) doesn't get auto-restarted —
    // ExecStopPost then drains the ASG to 0.
    const restartLine = isEphemeral ? 'Restart=no' : 'Restart=always';
    // Ephemeral drain: ExecStopPost runs on every stop (including clean rc=0
    // idle exit). OnFailure= triggers the drain unit on non-zero exits where
    // ExecStopPost may not run reliably. Both invoke the same drain script,
    // which does an atomic terminate-and-decrement (idempotent vs concurrent
    // SetDesiredCapacity(1) from the broker) and falls back to `shutdown -h`
    // so the OS halts even if the AWS API call fails.
    const execStopPost = isEphemeral
      ? 'ExecStopPost=/usr/local/bin/hereya-drain-asg.sh\n'
      : '';
    const onFailureLine = isEphemeral ? 'OnFailure=hereya-drain.service\n' : '';
    const timeoutStopLine = isEphemeral ? 'TimeoutStopSec=120\n' : '';

    userData.addCommands(
      'set -ex',

      // Log all output for debugging
      'exec > >(tee /var/log/hereya-userdata.log) 2>&1',

      // Install Node.js 22 via NodeSource
      'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -',
      'dnf install -y nodejs git cronie',

      // Install OpenTofu
      'curl -fsSL https://get.opentofu.org/install-opentofu.sh -o /tmp/install-opentofu.sh',
      'chmod +x /tmp/install-opentofu.sh',
      '/tmp/install-opentofu.sh --install-method rpm',
      'rm -f /tmp/install-opentofu.sh',

      // Install AWS CDK globally
      'npm install -g aws-cdk',

      // Install hereya-cli globally
      'npm install -g hereya-cli',

      // Verify all installations
      'node --version',
      'npm --version',
      'tofu --version',
      'cdk --version',

      // Get region from instance metadata
      'IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
      'EC2_REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)',

      // Read executor token from Secrets Manager
      `EXECUTOR_TOKEN=$(aws secretsmanager get-secret-value --secret-id "${tokenSecret.secretName}" --region $EC2_REGION --query 'SecretString' --output text)`,

      // Create systemd service for hereya executor
      `cat > /etc/systemd/system/hereya-executor.service << SERVICEEOF`,
      '[Unit]',
      'Description=Hereya Remote Executor',
      'After=network-online.target',
      'Wants=network-online.target',
      ...(onFailureLine ? [onFailureLine.trimEnd()] : []),
      '',
      '[Service]',
      'Type=simple',
      'User=ec2-user',
      'Environment=HEREYA_TOKEN=$EXECUTOR_TOKEN',
      `Environment=HEREYA_CLOUD_URL=${hereyaCloudUrl}`,
      'Environment=AWS_REGION=$EC2_REGION',
      'Environment=AWS_DEFAULT_REGION=$EC2_REGION',
      'Environment=HOME=/home/ec2-user',
      'Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'Environment=HEREYA_SKIP_TERRAFORM_DOWNLOAD=true',
      'Environment=HEREYA_TERRAFORM_BIN_PATH=tofu',
      ...(ephemeralAsgEnv ? [ephemeralAsgEnv.trimEnd()] : []),
      'ExecStartPre=/usr/bin/npx hereya login --token $EXECUTOR_TOKEN',
      `ExecStart=/usr/bin/npx hereya executor start -w ${workspace}${ephemeralStartArgs}`,
      ...(execStopPost ? [execStopPost.trimEnd()] : []),
      restartLine,
      'RestartSec=10',
      'TimeoutStopSec=3600',
      ...(timeoutStopLine ? [timeoutStopLine.trimEnd()] : []),
      'StandardOutput=journal',
      'StandardError=journal',
      'SyslogIdentifier=hereya-executor',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'SERVICEEOF',

      // Restrict service file permissions (contains token)
      'chmod 600 /etc/systemd/system/hereya-executor.service',

      // Ephemeral mode: drain script + drain unit (OnFailure target).
      // Both are written unconditionally inside the ephemeral branch only —
      // see the conditional below.
      ...(isEphemeral
        ? [
            // Drain script: terminate-and-decrement is atomic; even if a
            // concurrent SetDesiredCapacity(1) from the broker races us,
            // this instance still dies (a fresh one will launch for the new
            // wake). `set +e` so individual failures don't bypass shutdown.
            "cat > /usr/local/bin/hereya-drain-asg.sh << 'DRAINEOF'",
            '#!/bin/bash',
            'set +e',
            'logger -t hereya-drain "drain start"',
            'TOKEN=$(curl -sS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")',
            'INSTANCE_ID=$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)',
            'REGION=$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)',
            'logger -t hereya-drain "instance=$INSTANCE_ID region=$REGION"',
            '/usr/bin/aws autoscaling terminate-instance-in-auto-scaling-group \\',
            '  --instance-id "$INSTANCE_ID" \\',
            '  --should-decrement-desired-capacity \\',
            '  --region "$REGION" 2>&1 | logger -t hereya-drain',
            'logger -t hereya-drain "terminate-instance-in-auto-scaling-group rc=$?"',
            '# Belt-and-braces: halt the OS even if the AWS API call failed.',
            '# ASG will eventually mark this instance unhealthy and replace it.',
            'logger -t hereya-drain "scheduling shutdown -h now in 5s"',
            'sleep 5',
            '/sbin/shutdown -h now',
            'DRAINEOF',
            'chmod +x /usr/local/bin/hereya-drain-asg.sh',

            // Drain unit: oneshot target for OnFailure=. Runs the same script
            // so non-zero ExecStart exits also drain reliably.
            'cat > /etc/systemd/system/hereya-drain.service << DRAINSVCEOF',
            '[Unit]',
            'Description=Hereya Drain ASG (terminate-and-decrement + shutdown fallback)',
            '',
            '[Service]',
            'Type=oneshot',
            'ExecStart=/usr/local/bin/hereya-drain-asg.sh',
            'DRAINSVCEOF',
          ]
        : []),

      // Daily cleanup of stale Terraform provider caches and temp files
      "cat > /etc/cron.daily/hereya-cleanup << 'CLEANUPEOF'",
      '#!/bin/bash',
      'find /tmp -name "terraform-provider*" -mtime +2 -delete 2>/dev/null',
      'find /home/ec2-user/.hereya -name ".terraform" -type d -mtime +7 -exec rm -rf {} + 2>/dev/null',
      'CLEANUPEOF',
      'chmod +x /etc/cron.daily/hereya-cleanup',

      // Hereya CLI + CDK auto-update: hourly cron with graceful service restart
      'mkdir -p /opt/hereya',
      "cat > /opt/hereya/update-hereya.sh << 'UPDATEEOF'",
      '#!/bin/bash',
      'exec 200>/var/lock/hereya-update.lock',
      'flock -n 200 || exit 0',
      'LOG_TAG="hereya-update"',
      'log() {',
      '  echo "$(date \'+%Y-%m-%d %H:%M:%S\') $1" | tee -a /var/log/hereya-update.log',
      '  logger -t "$LOG_TAG" "$1"',
      '}',
      'HEREYA_UPDATED=false',
      '',
      '# --- Update hereya-cli ---',
      "CURRENT=$(hereya --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' || echo '0.0.0')",
      "LATEST=$(npm view hereya-cli version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+')",
      'if [ -z "$LATEST" ]; then',
      '  log "ERROR: Failed to fetch latest hereya-cli version from npm"',
      'elif [ "$CURRENT" = "$LATEST" ]; then',
      '  log "hereya-cli is up to date ($CURRENT)"',
      'else',
      '  log "Updating hereya-cli from $CURRENT to $LATEST"',
      '  if npm install -g hereya-cli@latest 2>&1 | tee -a /var/log/hereya-update.log; then',
      "    INSTALLED=$(hereya --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+')",
      '    log "hereya-cli update successful: now running $INSTALLED"',
      '    HEREYA_UPDATED=true',
      '  else',
      '    log "ERROR: hereya-cli npm install failed"',
      '  fi',
      'fi',
      '',
      '# --- Update aws-cdk ---',
      "CDK_CURRENT=$(cdk --version 2>/dev/null | grep -oE '^[0-9]+\\.[0-9]+\\.[0-9]+' || echo '0.0.0')",
      "CDK_LATEST=$(npm view aws-cdk version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+')",
      'if [ -z "$CDK_LATEST" ]; then',
      '  log "ERROR: Failed to fetch latest aws-cdk version from npm"',
      'elif [ "$CDK_CURRENT" = "$CDK_LATEST" ]; then',
      '  log "aws-cdk is up to date ($CDK_CURRENT)"',
      'else',
      '  log "Updating aws-cdk from $CDK_CURRENT to $CDK_LATEST"',
      '  if npm install -g aws-cdk@latest 2>&1 | tee -a /var/log/hereya-update.log; then',
      "    CDK_INSTALLED=$(cdk --version 2>/dev/null | grep -oE '^[0-9]+\\.[0-9]+\\.[0-9]+')",
      '    log "aws-cdk update successful: now running $CDK_INSTALLED"',
      '  else',
      '    log "ERROR: aws-cdk npm install failed"',
      '  fi',
      'fi',
      '',
      '# Restart executor service only if hereya-cli was updated',
      'if [ "$HEREYA_UPDATED" = "true" ]; then',
      '  log "Restarting hereya-executor.service for hereya-cli update..."',
      '  if systemctl restart hereya-executor.service 2>&1 | tee -a /var/log/hereya-update.log; then',
      '    log "Service restarted successfully"',
      '  else',
      '    log "ERROR: Service restart failed"',
      '  fi',
      'fi',
      'UPDATEEOF',
      'chmod +x /opt/hereya/update-hereya.sh',
      '',
      '# Schedule hourly update check at minute 17',
      'echo "17 * * * * root /opt/hereya/update-hereya.sh" > /etc/cron.d/hereya-update',
      'chmod 644 /etc/cron.d/hereya-update',

      // Enable and start crond (for update cron) and executor service
      'systemctl daemon-reload',
      'systemctl enable crond',
      'systemctl start crond',
      'systemctl enable hereya-executor',
      'systemctl start hereya-executor',
    );

    const [instClass, instSize] = instanceType.split('.');

    // Auto Scaling Group capacity differs by mode.
    // - always-on: min=max=desired=instanceCount, classic rolling-update.
    // - ephemeral: min=0, max=1, desired=0. Rolling update with
    //   minInstancesInService=0 so an empty ASG can still update.
    const asg = new autoscaling.AutoScalingGroup(this, 'ExecutorASG', {
      autoScalingGroupName: asgName,
      vpc,
      instanceType: ec2.InstanceType.of(
        instClass as ec2.InstanceClass,
        instSize as ec2.InstanceSize,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
      role,
      userData,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      minCapacity: isEphemeral ? 0 : instanceCount,
      maxCapacity: isEphemeral ? 1 : instanceCount,
      desiredCapacity: isEphemeral ? 0 : instanceCount,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: autoscaling.BlockDeviceVolume.ebs(30, {
            volumeType: autoscaling.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: isEphemeral ? 0 : Math.max(0, instanceCount - 1),
      }),
    });

    // Outputs (always)
    new cdk.CfnOutput(this, 'executorAsgName', {
      value: asg.autoScalingGroupName,
      description: 'Auto Scaling Group name of the remote executor',
    });

    new cdk.CfnOutput(this, 'executorSecurityGroupId', {
      value: sg.securityGroupId,
      description: 'Security group ID of the remote executor',
    });

    if (!isEphemeral) {
      // Always-on mode is fully provisioned at this point.
      return;
    }

    // -----------------------------------------------------------------
    // Ephemeral mode additions: jti table + broker Lambda
    // -----------------------------------------------------------------
    //
    // Originally this branch also provisioned an OIDC identity provider and
    // an IAM role (HereyaBrokerInvoker-<workspaceId>) so hereya-cloud could
    // SigV4-sign requests via AssumeRoleWithWebIdentity, with the Function URL
    // gated by AuthType=AWS_IAM. In practice AWS rejected those signed
    // requests with 403 even when the resource policy explicitly allowed the
    // role ARN. The cause was never pinned down (long debug session). The
    // KMS-signed JWT in `X-Hereya-Broker-Token` is the real authentication —
    // it's RS256-signed by hereya-cloud's KMS key, body-bound (`bh` claim),
    // jti-deduped, and 60s-expiring. Reverted to AuthType=NONE so the Lambda
    // sees and verifies the JWT.

    // DynamoDB jti replay cache — TTL on `expiresAt`.
    const jtiCacheTable = new dynamodb.Table(this, 'BrokerJtiCache', {
      partitionKey: { name: 'jti', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Broker Lambda — NodejsFunction with esbuild bundling
    const expectedAud = `broker:${workspaceId}`;

    const brokerLambda = new nodejs.NodejsFunction(this, 'BrokerLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '..', 'lambda', 'handler.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(25),
      reservedConcurrentExecutions: brokerConcurrency,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        // hereya-cli is published as ESM-only. The Lambda bundle MUST be ESM
        // too, otherwise `import 'hereya-cli'` is transpiled to `require()` and
        // crashes at runtime with ERR_REQUIRE_ESM.
        format: nodejs.OutputFormat.ESM,
        // The AWS-provided runtime ships @aws-sdk/* — externalize to keep the
        // bundle small and avoid pinning an older SDK version.
        externalModules: [
          '@aws-sdk/client-auto-scaling',
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/client-secrets-manager',
          '@aws-sdk/client-ssm',
          '@aws-sdk/lib-dynamodb',
          'hereya-cli',
        ],
        // hereya-cli is installed-into-bundle (NodejsFunction `npm install`s it
        // alongside the bundle so the runtime can `import` it as ESM).
        nodeModules: ['hereya-cli'],
      },
      environment: {
        HEREYA_CLOUD_URL: hereyaCloudUrl,
        WORKSPACE_ID: workspaceId,
        WORKSPACE_NAME: workspace,
        JTI_CACHE_TABLE: jtiCacheTable.tableName,
        ASG_NAME: asg.autoScalingGroupName,
        EXPECTED_BROKER_AUD: expectedAud,
      },
    });

    // Lambda permissions: ASG control (scoped to this ASG), DynamoDB jti
    // table, SSM/SecretsManager for resolve-env, CloudWatch logs (granted by
    // the NodejsFunction default role).
    brokerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['autoscaling:SetDesiredCapacity'],
        resources: [
          `arn:aws:autoscaling:${this.region}:${this.account}:autoScalingGroup:*:autoScalingGroupName/${asg.autoScalingGroupName}`,
        ],
      }),
    );
    // resolve-env reads SSM parameters and Secrets Manager secrets.
    brokerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
        resources: ['*'],
      }),
    );
    brokerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: ['*'],
      }),
    );
    // KMS decrypt for SSM SecureString reads.
    brokerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `ssm.${this.region}.amazonaws.com`,
          },
        },
      }),
    );

    jtiCacheTable.grantReadWriteData(brokerLambda);

    // Function URL with AuthType=NONE — the URL is unguessable AND the Lambda
    // verifies a KMS-signed JWT in `X-Hereya-Broker-Token` before doing any
    // work. Reserved concurrency + JWT verification + jti dedup limit DoS
    // exposure if the URL leaks.
    const fnUrl = brokerLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // Ephemeral-mode CFN outputs
    new cdk.CfnOutput(this, 'brokerWebhookUrl', { value: fnUrl.url });
    new cdk.CfnOutput(this, 'brokerVersion', { value: BROKER_VERSION });
    new cdk.CfnOutput(this, 'awsAccountId', { value: cdk.Aws.ACCOUNT_ID });
    new cdk.CfnOutput(this, 'region', { value: cdk.Aws.REGION });
    new cdk.CfnOutput(this, 'brokerLambdaArn', { value: brokerLambda.functionArn });
  }
}
