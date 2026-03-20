import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class HereyaRemoteExecutorAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Required parameters (passed by hereya workspace executor install)
    const executorToken = process.env['EXECUTOR_TOKEN'];
    if (!executorToken) {
      throw new Error('EXECUTOR_TOKEN environment variable is required');
    }

    const workspace = process.env['WORKSPACE'];
    if (!workspace) {
      throw new Error('WORKSPACE environment variable is required');
    }

    // Optional parameters
    const hereyaCloudUrl = process.env['HEREYA_CLOUD_URL'] || 'https://cloud.hereya.dev';
    const instanceType = process.env['instanceType'] || 't3.small';
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

    // UserData script
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -ex',

      // Install Node.js 22
      'dnf install -y nodejs22 npm git',

      // Install OpenTofu
      'curl -fsSL https://get.opentofu.org/install-opentofu.sh -o install-opentofu.sh',
      'chmod +x install-opentofu.sh',
      './install-opentofu.sh --install-method rpm',
      'rm -f install-opentofu.sh',

      // Install AWS CDK globally
      'npm install -g aws-cdk',

      // Install hereya-cli globally
      'npm install -g hereya-cli',

      // Create systemd service for hereya executor
      `cat > /etc/systemd/system/hereya-executor.service << 'EOF'`,
      '[Unit]',
      'Description=Hereya Remote Executor',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      'User=ec2-user',
      `Environment=HEREYA_TOKEN=${executorToken}`,
      `Environment=HEREYA_CLOUD_URL=${hereyaCloudUrl}`,
      `ExecStart=/usr/bin/npx hereya executor start -w ${workspace}`,
      'Restart=always',
      'RestartSec=10',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOF',

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
