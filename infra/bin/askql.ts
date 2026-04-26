#!/usr/bin/env node
import * as dotenv from "dotenv";
dotenv.config();
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AskQLStack } from "../lib/askql-stack";

const app = new cdk.App();

new AskQLStack(app, "AskQLStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
  tags: {
    Project: "AskQL",
    Environment: "dev",
  },
});
