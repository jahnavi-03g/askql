# AskQL — Natural Language to SQL on AWS

Upload a dataset. Ask questions in plain English. Get SQL and results instantly.

Built with: Next.js · AWS Bedrock Agents · Amazon Nova Micro · Cognito + Google Auth · Athena · S3 · CDK

---

## Project structure

```
askql/
├── frontend/                   # Next.js app (Amplify Hosting)
│   ├── app/
│   │   ├── page.tsx            # Landing / login page
│   │   ├── dashboard/page.tsx  # Main chat + upload UI
│   │   └── auth/callback/      # OAuth callback handler
│   └── lib/
│       ├── api.ts              # Typed API client
│       └── amplify-config.ts   # Cognito config
│
├── backend/
│   ├── lambdas/
│   │   ├── api/                # Main API handler (query, upload, results)
│   │   ├── schema_ingestion/   # S3-triggered schema parser → Glue + KB
│   │   └── sql_executor/       # Bedrock Agent Action Group → Athena
│   ├── bedrock-agent-instruction.txt   # Agent system prompt
│   └── action-group-schema.json        # OpenAPI schema for action group
│
└── infra/                      # AWS CDK stack (TypeScript)
    ├── bin/askql.ts
    └── lib/askql-stack.ts      # All AWS resources defined here
```

---

## Prerequisites

- AWS account (new accounts get $200 in free credits)
- Node.js 18+
- Python 3.12+
- AWS CLI configured (`aws configure`)
- CDK installed (`npm install -g aws-cdk`)
- Google Cloud account for OAuth

---

## Step 1 — Google OAuth setup

1. Go to https://console.cloud.google.com/apis/credentials
2. Create project → Create credentials → OAuth 2.0 Client ID
3. Application type: **Web application**
4. Add authorized redirect URI:
   ```
   https://askql-auth.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
   ```
5. Note your **Client ID** and **Client Secret**

Store the client secret in AWS Secrets Manager:
```bash
aws secretsmanager create-secret \
  --name askql/google-oauth-secret \
  --secret-string "YOUR_GOOGLE_CLIENT_SECRET" \
  --region us-east-1
```

---

## Step 2 — Deploy infrastructure

```bash
# Install CDK dependencies
cd infra
npm install

# Bootstrap CDK (one-time per account/region)
cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-east-1

# Set your Google Client ID
export GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"

# Deploy
cdk deploy

# Copy the outputs — you'll need them for the next steps:
#   AskQLStack.UserPoolId
#   AskQLStack.UserPoolClientId
#   AskQLStack.CognitoDomain
#   AskQLStack.ApiUrl
#   AskQLStack.SqlExecutorLambdaArn
```

---

## Step 3 — Create Bedrock Knowledge Base

1. AWS Console → Amazon Bedrock → Knowledge Bases → Create
2. Settings:
   - **Name**: `askql-schema-kb`
   - **Embedding model**: Amazon Titan Text Embeddings V2
   - **Vector store**: Amazon S3 Vectors (cheapest option)
   - **Data source**: S3 bucket → `askql-datasets-{YOUR_ACCOUNT_ID}` → prefix `schemas/`
3. Note the **Knowledge Base ID** and **Data Source ID**
4. Update Lambda env vars:
   ```bash
   aws lambda update-function-configuration \
     --function-name askql-schema-ingestion \
     --environment Variables="{KNOWLEDGE_BASE_ID=YOUR_KB_ID,DATA_SOURCE_ID=YOUR_DS_ID,ATHENA_RESULTS_BUCKET=askql-athena-results-ACCOUNT}"
   ```

---

## Step 4 — Create Bedrock Agent

1. AWS Console → Amazon Bedrock → Agents → Create Agent
2. Settings:
   - **Name**: `askql-agent`
   - **Model**: Amazon Nova Micro (cheapest) or Claude Sonnet 4.6 (best quality)
   - **Instructions**: paste contents of `backend/bedrock-agent-instruction.txt`
3. Add Knowledge Base:
   - Select `askql-schema-kb`
   - Description: `Dataset schemas and column information for generating SQL`
4. Add Action Group:
   - **Name**: `validate_and_run`
   - **Lambda function**: `askql-sql-executor`
   - **API Schema**: upload `backend/action-group-schema.json`
5. Save and prepare the agent
6. Note the **Agent ID** and copy the **Test Alias ID** (`TSTALIASID`)
7. Update the API Lambda:
   ```bash
   aws lambda update-function-configuration \
     --function-name askql-api \
     --environment Variables="{AGENT_ID=YOUR_AGENT_ID,AGENT_ALIAS_ID=TSTALIASID,USER_POOL_ID=YOUR_POOL_ID,CLIENT_ID=YOUR_CLIENT_ID,DATASET_BUCKET=askql-datasets-ACCOUNT,REGION=us-east-1}"
   ```

---

## Step 5 — Run the frontend locally

```bash
cd frontend

# Install dependencies
npm install

# Copy env template and fill in values from CDK outputs
cp .env.example .env.local
# Edit .env.local with your actual values

# Start dev server
npm run dev
# → http://localhost:3000
```

---

## Step 6 — Deploy frontend to Amplify

1. Push the repo to GitHub
2. AWS Console → AWS Amplify → New app → Host web app
3. Connect GitHub → select repo
4. Build settings: auto-detected from `amplify.yml`
5. Add environment variables (same as `.env.local` values):
   - `NEXT_PUBLIC_USER_POOL_ID`
   - `NEXT_PUBLIC_CLIENT_ID`
   - `NEXT_PUBLIC_COGNITO_DOMAIN`
   - `NEXT_PUBLIC_API_URL`
   - `NEXT_PUBLIC_REDIRECT_SIGN_IN` → your Amplify URL + `/auth/callback`
   - `NEXT_PUBLIC_REDIRECT_SIGN_OUT` → your Amplify URL
6. Deploy
7. Update Cognito callback URLs with the Amplify domain:
   - Go to Cognito → User Pools → App clients → Edit hosted UI
   - Add: `https://main.XXXX.amplifyapp.com/auth/callback`
8. Update Google OAuth redirect URIs with the same URL

---

## How to use AskQL

1. Sign in with Google
2. Click **Upload** and select a CSV or JSON file
3. Wait ~30 seconds for schema indexing
4. Type a question like:
   - *"Show me total revenue by month"*
   - *"Which customer placed the most orders?"*
   - *"Find all sales above $1000 in Q4"*
5. AskQL generates SQL, runs it on Athena, and shows the results

---

## Cost estimate (with $200 AWS credits)

| Service | ~Monthly cost (prototype) |
|---|---|
| Amazon Nova Micro (10k queries) | ~$1.50 |
| S3 (datasets + results) | ~$2 |
| Athena (query execution) | ~$5 |
| Lambda + API Gateway | ~$1 |
| Cognito (50 MAU free tier) | $0 |
| Bedrock Knowledge Base | ~$5 |
| **Total** | **~$14–15/month** |

Your $200 credits cover ~12 months of prototype usage at this scale.

---

## Switching models

To use Claude Sonnet 4.6 instead of Nova Micro for better SQL quality:

In the Bedrock Agent console → Edit → Model → switch to `Claude Sonnet 4.6`

Cost difference: ~$0.00015/query (Nova Micro) vs ~$0.003/query (Sonnet) — 20x more expensive but significantly better for complex multi-table queries.

---

## Architecture

```
Browser
  └── Next.js (Amplify Hosting)
        └── Cognito (Google OAuth) ──→ JWT
              └── API Gateway (Cognito authorizer)
                    └── Lambda: api/
                          ├── POST /upload  → S3 presigned URL
                          ├── POST /query   → Bedrock Agent
                          └── GET  /results → Athena poll

S3 (dataset upload)
  └── Lambda: schema_ingestion/
        ├── Infer schema (columns, types, samples)
        ├── Register table in Glue / Athena
        └── Sync schema doc to Bedrock Knowledge Base

Bedrock Agent (Nova Micro / Claude Sonnet 4.6)
  ├── Knowledge Base (schema RAG)
  └── Action Group → Lambda: sql_executor/
        ├── Validate SQL (block DROP/DELETE/etc)
        └── Execute on Athena → S3 results
```
