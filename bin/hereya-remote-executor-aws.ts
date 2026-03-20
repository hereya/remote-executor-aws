#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { HereyaRemoteExecutorAwsStack } from '../lib/hereya-remote-executor-aws-stack';

const app = new cdk.App();
new HereyaRemoteExecutorAwsStack(app, process.env.STACK_NAME!, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
