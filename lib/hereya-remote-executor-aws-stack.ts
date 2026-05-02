import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

const BROKER_VERSION = '0.7.4';

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
    // CloudWatchAgentServerPolicy is also attached for clarity / best-practice
    // even though AdministratorAccess already covers CloudWatch Logs writes.
    const role = new iam.Role(this, 'ExecutorRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    // CloudWatch Log Group for durable executor logs. Created in BOTH modes
    // — even an always-on instance can crash and lose its journald history.
    // Per-instance streams are written by the CloudWatch agent installed in
    // UserData (see below).
    const logGroup = new logs.LogGroup(this, 'ExecutorLogs', {
      logGroupName: `/hereya/executor/${workspace}-${this.stackName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
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
      ? ` --idleTimeout=${idleTimeoutSeconds} --concurrency=20`
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

      // Install CloudWatch agent for durable log forwarding (so we have
      // visibility even when the instance terminates — journald dies with
      // the host).
      'dnf install -y amazon-cloudwatch-agent',

      // CDK Token for the log group name needs to be assigned to a shell
      // variable first; embedding the Token directly inside a heredoc is not
      // reliable.
      `LOG_GROUP_NAME='${logGroup.logGroupName}'`,

      // Write the agent config: tail the executor log file, the UserData log,
      // and cloud-init output. The unquoted heredoc terminator (CWAEOF, no
      // single-quotes) allows ${LOG_GROUP_NAME} to be expanded by the shell.
      'cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << CWAEOF',
      '{',
      '  "agent": {',
      '    "metrics_collection_interval": 60,',
      '    "logfile": "/var/log/amazon-cloudwatch-agent.log"',
      '  },',
      '  "logs": {',
      '    "force_flush_interval": 1,',
      '    "logs_collected": {',
      '      "files": {',
      '        "collect_list": [',
      '          {',
      '            "file_path": "/var/log/hereya-executor.log",',
      '            "log_group_name": "${LOG_GROUP_NAME}",',
      '            "log_stream_name": "{instance_id}/executor",',
      '            "timezone": "UTC"',
      '          },',
      '          {',
      '            "file_path": "/var/log/hereya-userdata.log",',
      '            "log_group_name": "${LOG_GROUP_NAME}",',
      '            "log_stream_name": "{instance_id}/userdata",',
      '            "timezone": "UTC"',
      '          },',
      '          {',
      '            "file_path": "/var/log/cloud-init-output.log",',
      '            "log_group_name": "${LOG_GROUP_NAME}",',
      '            "log_stream_name": "{instance_id}/cloud-init",',
      '            "timezone": "UTC"',
      '          },',
      '          {',
      '            "file_path": "/var/log/messages",',
      '            "log_group_name": "${LOG_GROUP_NAME}",',
      '            "log_stream_name": "{instance_id}/syslog",',
      '            "timezone": "UTC"',
      '          }',
      '        ]',
      '      }',
      '    }',
      '  }',
      '}',
      'CWAEOF',

      // Pre-create the executor log file so the agent has something to tail
      // from boot (the systemd unit will append to it).
      'touch /var/log/hereya-executor.log',
      'chown ec2-user:ec2-user /var/log/hereya-executor.log',

      // Start the CloudWatch agent.
      '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \\',
      '  -a fetch-config -m ec2 -s \\',
      '  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json',

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
      // Append (not journal) so executor stdout/stderr is durable on disk;
      // journald dies with the host on ephemeral terminate. The CloudWatch
      // agent (above) tails this file into CloudWatch Logs.
      'StandardOutput=append:/var/log/hereya-executor.log',
      'StandardError=append:/var/log/hereya-executor.log',
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
            '# Give the CloudWatch agent time to flush any pending log buffers',
            '# (executor crash logs especially) before we terminate the host. The',
            '# agent default flush interval is up to 5s and the upload itself takes',
            '# a few seconds — without this delay we lose the post-mortem.',
            'logger -t hereya-drain "pre-drain flush window: 30s"',
            'sleep 30',
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
            'logger -t hereya-drain "scheduling shutdown -h now in 10s (final flush window)"',
            'sleep 10',
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

    new cdk.CfnOutput(this, 'executorLogGroupName', {
      value: logGroup.logGroupName,
      description: 'CloudWatch Log Group receiving executor + UserData + cloud-init logs',
    });

    if (!isEphemeral) {
      // Always-on mode is fully provisioned at this point.
      return;
    }

    // -----------------------------------------------------------------
    // Ephemeral mode additions: jti table + broker Lambda
    // -----------------------------------------------------------------
    //
    // Originally this branch provisioned a Lambda Function URL (first with
    // AWS_IAM auth gated by an OIDC identity provider + HereyaBrokerInvoker
    // role, later with AuthType=NONE). Both arrangements ran into Function
    // URL auth weirdness in this AWS account: AWS_IAM rejected
    // properly-signed assumed-role sessions with 403, and AuthType=NONE
    // somehow returned 403 for unauthenticated requests too. Switched to an
    // API Gateway HTTP API + custom Lambda authorizer (below) — the
    // KMS-signed JWT in `X-Hereya-Broker-Token` is still the real
    // authentication (RS256, body-bound via `bh` claim, jti-deduped,
    // 60s-expiring), now verified by the authorizer Lambda before the broker
    // Lambda is invoked. The broker re-verifies signature/exp/aud (cheap
    // with cached JWKS) plus the body hash and jti for defense in depth.

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

    // Lambda authorizer — verifies the X-Hereya-Broker-Token JWT BEFORE the
    // broker Lambda is invoked. Uses the same JWKS verification helpers as the
    // broker handler. No DynamoDB lookups (jti dedup happens later in the
    // broker), so the authorizer is ~ms.
    const authorizerLambda = new nodejs.NodejsFunction(this, 'BrokerAuthorizerLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '..', 'lambda', 'authorizer.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        format: nodejs.OutputFormat.ESM,
        externalModules: [
          '@aws-sdk/client-auto-scaling',
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/client-secrets-manager',
          '@aws-sdk/client-ssm',
          '@aws-sdk/lib-dynamodb',
        ],
      },
      environment: {
        HEREYA_CLOUD_URL: hereyaCloudUrl,
        EXPECTED_BROKER_AUD: expectedAud,
      },
    });

    const brokerAuthorizer = new apigwv2Authorizers.HttpLambdaAuthorizer(
      'BrokerAuthorizer',
      authorizerLambda,
      {
        responseTypes: [apigwv2Authorizers.HttpLambdaResponseType.SIMPLE],
        identitySource: ['$request.header.X-Hereya-Broker-Token'],
        // Each broker JWT is single-use (jti dedup in the broker). Disable
        // authorizer caching so every request gets verified.
        resultsCacheTtl: cdk.Duration.seconds(0),
      },
    );

    const httpApi = new apigwv2.HttpApi(this, 'BrokerHttpApi', {
      description: `Hereya broker for workspace ${workspace}`,
      corsPreflight: undefined,
    });

    httpApi.addRoutes({
      path: '/',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        'BrokerLambdaIntegration',
        brokerLambda,
      ),
      authorizer: brokerAuthorizer,
    });

    // Ephemeral-mode CFN outputs
    new cdk.CfnOutput(this, 'brokerWebhookUrl', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'brokerVersion', { value: BROKER_VERSION });
    new cdk.CfnOutput(this, 'awsAccountId', { value: cdk.Aws.ACCOUNT_ID });
    new cdk.CfnOutput(this, 'region', { value: cdk.Aws.REGION });
    new cdk.CfnOutput(this, 'brokerLambdaArn', { value: brokerLambda.functionArn });
  }
}
