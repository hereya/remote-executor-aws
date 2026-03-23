import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class HereyaRemoteExecutorAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Required parameters (passed by hereya workspace executor install)
    // EXECUTOR_TOKEN uses a placeholder default to allow `cdk destroy` without env vars
    const executorToken = process.env['EXECUTOR_TOKEN'] || 'placeholder';

    const workspace = process.env['WORKSPACE'] || 'placeholder';

    // Optional parameters
    const hereyaCloudUrl = process.env['HEREYA_CLOUD_URL'] || 'https://cloud.hereya.dev';
    const instanceType = process.env['instanceType'] || 't3.medium';
    const vpcId: string | undefined = process.env['vpcId'];

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

    // IAM role with AdministratorAccess (executor provisions arbitrary infrastructure)
    const role = new iam.Role(this, 'ExecutorRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Store executor token in Secrets Manager
    const tokenSecret = new secretsmanager.Secret(this, 'ExecutorTokenSecret', {
      secretName: `/hereya/executor/${workspace}/token`,
      secretStringValue: cdk.SecretValue.unsafePlainText(executorToken),
    });

    // UserData script
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -ex',

      // Log all output for debugging
      'exec > >(tee /var/log/hereya-userdata.log) 2>&1',

      // Install Node.js 22 via NodeSource
      'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -',
      'dnf install -y nodejs git',

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
      'ExecStartPre=/usr/bin/npx hereya login --token $EXECUTOR_TOKEN',
      `ExecStart=/usr/bin/npx hereya executor start -w ${workspace}`,
      'Restart=always',
      'RestartSec=10',
      'StandardOutput=journal',
      'StandardError=journal',
      'SyslogIdentifier=hereya-executor',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'SERVICEEOF',

      // Restrict service file permissions (contains token)
      'chmod 600 /etc/systemd/system/hereya-executor.service',

      // Daily cleanup of stale Terraform provider caches and temp files
      "cat > /etc/cron.daily/hereya-cleanup << 'CLEANUPEOF'",
      '#!/bin/bash',
      'find /tmp -name "terraform-provider*" -mtime +2 -delete 2>/dev/null',
      'find /home/ec2-user/.hereya -name ".terraform" -type d -mtime +7 -exec rm -rf {} + 2>/dev/null',
      'CLEANUPEOF',
      'chmod +x /etc/cron.daily/hereya-cleanup',

      // Enable and start the service
      'systemctl daemon-reload',
      'systemctl enable hereya-executor',
      'systemctl start hereya-executor',
    );

    const [instClass, instSize] = instanceType.split('.');

    // EC2 instance
    const instance = new ec2.Instance(this, 'ExecutorInstance', {
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
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'executorInstanceId', {
      value: instance.instanceId,
      description: 'EC2 instance ID of the remote executor',
    });

    new cdk.CfnOutput(this, 'executorSecurityGroupId', {
      value: sg.securityGroupId,
      description: 'Security group ID of the remote executor',
    });
  }
}
