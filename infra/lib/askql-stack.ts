import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "path";

export class AskQLStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── SECRETS ──────────────────────────────────────────────────────────────
    // Store your Google OAuth client secret here after running:
    // aws secretsmanager create-secret --name askql/google-oauth-secret \
    //   --secret-string "YOUR_GOOGLE_CLIENT_SECRET"
    const googleSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "GoogleOAuthSecret",
      process.env.GOOGLE_SECRET_ARN || ""
    );

    // ── COGNITO USER POOL ─────────────────────────────────────────────────────
    const userPool = new cognito.UserPool(this, "AskQLUserPool", {
      userPoolName: "askql-users",
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // change to RETAIN for prod
    });

    // Google IdP
    const googleIdp = new cognito.UserPoolIdentityProviderGoogle(
      this,
      "GoogleIdP",
      {
        userPool,
        // Replace with your actual Google OAuth Client ID
        clientId: process.env.GOOGLE_CLIENT_ID || "YOUR_GOOGLE_CLIENT_ID",
        clientSecretValue: googleSecret.secretValue,
        scopes: ["email", "profile", "openid"],
        attributeMapping: {
          email: cognito.ProviderAttribute.GOOGLE_EMAIL,
          fullname: cognito.ProviderAttribute.GOOGLE_NAME,
          profilePicture: cognito.ProviderAttribute.GOOGLE_PICTURE,
        },
      }
    );

    // App client
    const userPoolClient = userPool.addClient("AskQLWebClient", {
      userPoolClientName: "askql-web",
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          "http://localhost:3000/auth/callback",
          // Add your Amplify URL once deployed:
          // "https://main.XXXX.amplifyapp.com/auth/callback",
        ],
        logoutUrls: [
          "http://localhost:3000",
          // "https://main.XXXX.amplifyapp.com",
        ],
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.GOOGLE,
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // Hosted UI domain
    const userPoolDomain = userPool.addDomain("AskQLDomain", {
      cognitoDomain: { domainPrefix: "askql-auth" },
    });

    userPoolClient.node.addDependency(googleIdp);

    // ── S3 BUCKETS ────────────────────────────────────────────────────────────
    const datasetBucket = s3.Bucket.fromBucketName(
      this,
      "DatasetBucket",
      `askql-datasets-${this.account}`
    );
    
    const athenaResultsBucket = s3.Bucket.fromBucketName(
      this,
      "AthenaResultsBucket",
      `askql-athena-results-${this.account}`
    );

    // ── IAM ROLE FOR LAMBDAS ──────────────────────────────────────────────────
    const lambdaRole = new iam.Role(this, "AskQLLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
      inlinePolicies: {
        BedrockAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                "bedrock:InvokeAgent",
                "bedrock:InvokeModel",
                "bedrock:RetrieveAndGenerate",
                "bedrock:Retrieve",
                "bedrock:StartIngestionJob",
              ],
              resources: ["*"],
            }),
          ],
        }),
        S3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
              resources: [
                datasetBucket.bucketArn + "/*",
                athenaResultsBucket.bucketArn + "/*",
              ],
            }),
            new iam.PolicyStatement({
              actions: ["s3:ListBucket"],
              resources: [
                datasetBucket.bucketArn,
                athenaResultsBucket.bucketArn,
              ],
            }),
          ],
        }),
        AthenaAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                "athena:StartQueryExecution",
                "athena:GetQueryExecution",
                "athena:GetQueryResults",
                "athena:StopQueryExecution",
                "glue:GetTable",
                "glue:GetDatabase",
                "glue:CreateTable",
                "glue:CreateDatabase",
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // ── LAMBDA: SCHEMA INGESTION ──────────────────────────────────────────────
    // Triggered when a file is uploaded to S3
    const schemaIngestionLambda = new lambda.Function(
      this,
      "SchemaIngestionFn",
      {
        functionName: "askql-schema-ingestion",
        runtime: lambda.Runtime.PYTHON_3_12,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../backend/lambdas/schema_ingestion")
        ),
        handler: "handler.lambda_handler",
        role: lambdaRole,
        timeout: cdk.Duration.seconds(120),
        memorySize: 512,
        environment: {
          ATHENA_RESULTS_BUCKET: athenaResultsBucket.bucketName,
          // Set this after creating Bedrock Knowledge Base:
          KNOWLEDGE_BASE_ID: process.env.KNOWLEDGE_BASE_ID || "PLACEHOLDER",
          DATA_SOURCE_ID: process.env.DATA_SOURCE_ID || "PLACEHOLDER",
        },
        logRetention: logs.RetentionDays.ONE_WEEK,
      }
    );

    // Trigger schema ingestion when file lands in S3
    datasetBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(schemaIngestionLambda),
      { suffix: ".csv" }
    );
    datasetBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(schemaIngestionLambda),
      { suffix: ".json" }
    );

    // ── LAMBDA: SQL EXECUTOR (Bedrock Action Group) ───────────────────────────
    const sqlExecutorLambda = new lambda.Function(this, "SqlExecutorFn", {
      functionName: "askql-sql-executor",
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../backend/lambdas/sql_executor")
      ),
      handler: "handler.lambda_handler",
      role: lambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        ATHENA_RESULTS_BUCKET: athenaResultsBucket.bucketName,
        ATHENA_DATABASE: "askql_db",
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Allow Bedrock to invoke the SQL executor
    sqlExecutorLambda.addPermission("BedrockInvoke", {
      principal: new iam.ServicePrincipal("bedrock.amazonaws.com"),
      action: "lambda:InvokeFunction",
    });

    // ── LAMBDA: API HANDLER ───────────────────────────────────────────────────
    const apiLambda = new lambda.Function(this, "ApiFn", {
      functionName: "askql-api",
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../backend/lambdas/api")
      ),
      handler: "handler.lambda_handler",
      role: lambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE, // X-Ray
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        CLIENT_ID: userPoolClient.userPoolClientId,
        DATASET_BUCKET: datasetBucket.bucketName,
        // Set after creating Bedrock Agent:
        AGENT_ID: process.env.AGENT_ID || "PLACEHOLDER",
        AGENT_ALIAS_ID: process.env.AGENT_ALIAS_ID || "TSTALIASID",
        REGION: this.region,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // ── API GATEWAY ───────────────────────────────────────────────────────────
    const api = new apigateway.RestApi(this, "AskQLApi", {
      restApiName: "askql-api",
      description: "AskQL — natural language to SQL",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "Authorization"],
      },
      deployOptions: {
        stageName: "dev",
        throttlingBurstLimit: 50,
        throttlingRateLimit: 20,
      },
    });

    // Cognito authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "CognitoAuthorizer",
      {
        cognitoUserPools: [userPool],
        authorizerName: "askql-authorizer",
        identitySource: "method.request.header.Authorization",
      }
    );

    const integration = new apigateway.LambdaIntegration(apiLambda);

    // POST /query — run a natural language query
    const queryResource = api.root.addResource("query");
    queryResource.addMethod("POST", integration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // POST /upload — get a presigned URL for direct S3 upload
    const uploadResource = api.root.addResource("upload");
    uploadResource.addMethod("POST", integration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /results/{executionId} — poll Athena result
    const resultsResource = api.root.addResource("results");
    const resultResource = resultsResource.addResource("{executionId}");
    resultResource.addMethod("GET", integration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // ── OUTPUTS ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
      description: "Cognito User Pool ID",
      exportName: "AskQL-UserPoolId",
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
      description: "Cognito App Client ID",
      exportName: "AskQL-ClientId",
    });

    new cdk.CfnOutput(this, "CognitoDomain", {
      value: userPoolDomain.domainName,
      description: "Cognito Hosted UI domain",
    });

    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "API Gateway URL",
      exportName: "AskQL-ApiUrl",
    });

    new cdk.CfnOutput(this, "DatasetBucketName", {
      value: datasetBucket.bucketName,
      description: "S3 bucket for uploaded datasets",
    });

    new cdk.CfnOutput(this, "SqlExecutorLambdaArn", {
      value: sqlExecutorLambda.functionArn,
      description: "ARN for Bedrock Agent Action Group",
      exportName: "AskQL-SqlExecutorArn",
    });
  }
}
