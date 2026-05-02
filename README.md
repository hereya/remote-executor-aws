# hereya/remote-executor-aws

Deploy a remote executor on AWS EC2 for a hereya workspace. Two operating modes:

- **`always-on`** (default): an Auto Scaling Group with `min=max=desired=instanceCount` keeps the executor running 24/7 polling hereya-cloud.
- **`ephemeral`** (scale-to-zero): an ASG with `min=0/max=1/desired=0` plus a broker Lambda. Heavyweight jobs trigger `SetDesiredCapacity(1)` to launch the executor on demand; `resolve-env` jobs run directly inside the Lambda (sub-second). When the executor goes idle it exits cleanly and the ASG drains back to 0 — no compute charges when nothing is running.

## Parameters

| Name | Required | Default | Notes |
|---|---|---|---|
| `mode` | no | `always-on` | `always-on` or `ephemeral`. |
| `EXECUTOR_TOKEN` | yes | — | Long-lived workspace token (set automatically by `hereya workspace executor install`). |
| `WORKSPACE` | yes | — | Workspace name (`hereya executor start -w <name>`). |
| `HEREYA_CLOUD_URL` | no | `https://cloud.hereya.dev` | Hereya Cloud origin. In ephemeral mode also used as the OIDC issuer. |
| `instanceType` | no | `t3.medium` | EC2 instance type. |
| `instanceCount` | no | `1` | Always-on only — fixed ASG capacity. |
| `vpcId` | no | default VPC | VPC to launch into. |
| `workspaceId` | yes if `mode=ephemeral` | — | Workspace ID. Used in the OIDC trust-policy `sub` condition and the invoker role name. |
| `brokerConcurrency` | no | `50` | Reserved Lambda concurrency for the broker (ephemeral only). |
| `idleTimeoutSeconds` | no | `600` | Executor idle-shutdown timeout in seconds (ephemeral only). |

## Ephemeral mode

When `mode=ephemeral`, the stack additionally provisions:

- An **OIDC identity provider** trusting `HEREYA_CLOUD_URL` so hereya-cloud can sign STS web-identity tokens.
- An **IAM invoker role** `HereyaBrokerInvoker-<workspaceId>` whose only permission is `lambda:InvokeFunctionUrl` on the broker Lambda. Trust policy is bound to `cloud.hereya.dev:sub == "workspace:<id>"`.
- A **broker Lambda** (Node 22, `NodejsFunction` + esbuild) behind a Function URL with `AuthType=AWS_IAM`.
- A **DynamoDB `BrokerJtiCache`** table for JWT replay protection (TTL on `expiresAt`).

The systemd unit on the EC2 is augmented with `--idle-timeout=<seconds> --concurrency=20`, `Restart=no`, and `ExecStopPost=aws autoscaling set-desired-capacity --desired-capacity 0` so an idle exit drains the ASG.

The same long-lived `EXECUTOR_TOKEN` (KMS-encrypted in Secrets Manager) is reused on every wake — no bootstrap-redeem flow on the wake path.

### Ephemeral outputs

The install command POSTs these to hereya-cloud's `/api/workspaces/:name/executor-broker`:

| Name | Example |
|---|---|
| `brokerWebhookUrl` | `https://abc123.lambda-url.us-east-1.on.aws/` |
| `brokerVersion` | `0.6.0` |
| `awsAccountId` | `123456789012` |
| `region` | `us-east-1` |
| `invokerRoleArn` | `arn:aws:iam::123456789012:role/HereyaBrokerInvoker-<workspaceId>` |
| `brokerLambdaArn` | `arn:aws:lambda:us-east-1:123456789012:function:...` |
| `executorAsgName` | `hereya-executor-<workspace>-<stack>` |
| `executorSecurityGroupId` | `sg-...` |

## Logging

Executor logs forward to CloudWatch Logs at `/hereya/executor/<workspace>-<stackname>` with 7-day retention. Streams (one set per EC2 instance):

| Stream | Source |
|---|---|
| `<instanceId>/executor` | `/var/log/hereya-executor.log` (systemd-managed `hereya-executor.service` stdout/stderr, appended on disk) |
| `<instanceId>/userdata` | `/var/log/hereya-userdata.log` (UserData bootstrap output) |
| `<instanceId>/cloud-init` | `/var/log/cloud-init-output.log` (cloud-init / boot stages) |

Forwarding is done by the AWS CloudWatch agent installed during UserData. Because the executor's own stdout/stderr is `append:`ed to a regular file (not journald), the logs survive even if the instance terminates before the agent flushes — and survive a CloudWatch agent crash too. The log group name is exposed as the `executorLogGroupName` CFN output.

## Development

```bash
npm install
npm run build
npm test
```
