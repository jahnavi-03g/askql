import json
import boto3
import os
import logging
import urllib.request
import urllib.error
import base64
import time
from functools import lru_cache

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client("s3")
bedrock_runtime = boto3.client("bedrock-agent-runtime")
athena = boto3.client("athena")

REGION = os.environ.get("REGION", "us-east-1")
USER_POOL_ID = os.environ.get("USER_POOL_ID", "")
CLIENT_ID = os.environ.get("CLIENT_ID", "")
DATASET_BUCKET = os.environ.get("DATASET_BUCKET", "")
AGENT_ID = os.environ.get("AGENT_ID", "")
AGENT_ALIAS_ID = os.environ.get("AGENT_ALIAS_ID", "TSTALIASID")


# ── JWT Verification (lightweight, no extra deps) ─────────────────────────────

@lru_cache(maxsize=1)
def get_jwks():
    """Fetch Cognito JWKS (cached for Lambda warm invocations)."""
    url = f"https://cognito-idp.{REGION}.amazonaws.com/{USER_POOL_ID}/.well-known/jwks.json"
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.loads(response.read())


def decode_jwt_payload(token: str) -> dict:
    """Decode JWT payload without full verification (API GW already verified sig)."""
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("Invalid JWT format")

    payload_b64 = parts[1]
    # Add padding
    padding = 4 - len(payload_b64) % 4
    if padding != 4:
        payload_b64 += "=" * padding

    payload = base64.urlsafe_b64decode(payload_b64)
    return json.loads(payload)


def get_user_from_token(event: dict) -> dict:
    """Extract user info from the Cognito JWT in Authorization header.
    Note: API Gateway Cognito authorizer already verified the token.
    We just decode the payload to get the user sub/email.
    """
    auth_header = event.get("headers", {}).get("Authorization", "")
    if not auth_header:
        raise ValueError("No Authorization header")

    token = auth_header.replace("Bearer ", "").strip()
    payload = decode_jwt_payload(token)

    return {
        "sub": payload.get("sub", ""),
        "email": payload.get("email", ""),
        "name": payload.get("name", ""),
    }


# ── Route Handlers ────────────────────────────────────────────────────────────

def handle_query(event: dict, user: dict) -> dict:
    """
    POST /query
    Body: { "prompt": "Show me top 10 sales", "session_id": "optional" }
    Invokes the Bedrock Agent and streams back the result.
    """
    body = json.loads(event.get("body") or "{}")
    prompt = body.get("prompt", "").strip()

    if not prompt:
        return error_response(400, "prompt is required")

    if len(prompt) > 2000:
        return error_response(400, "prompt too long (max 2000 characters)")

    # Use user sub as session ID so agent has per-user memory
    session_id = body.get("session_id") or user["sub"][:36]

    logger.info(f"Query from {user['email']}: {prompt[:100]}")

    if not AGENT_ID or AGENT_ID == "PLACEHOLDER":
        # Dev fallback — return a mock response
        return success_response({
            "answer": "Bedrock Agent not configured yet. Set AGENT_ID env var after creating the agent.",
            "sql": "SELECT * FROM your_table LIMIT 10",
            "session_id": session_id,
        })

    try:
        response = bedrock_runtime.invoke_agent(
            agentId=AGENT_ID,
            agentAliasId=AGENT_ALIAS_ID,
            sessionId=session_id,
            inputText=prompt,
            enableTrace=False,
        )

        # Collect streaming response
        completion = ""
        for event_chunk in response["completion"]:
            if "chunk" in event_chunk:
                chunk_data = event_chunk["chunk"]
                if "bytes" in chunk_data:
                    completion += chunk_data["bytes"].decode("utf-8")

        return success_response({
            "answer": completion,
            "session_id": session_id,
            "prompt": prompt,
        })

    except Exception as e:
        logger.error(f"Bedrock agent error: {e}", exc_info=True)
        return error_response(500, f"Agent error: {str(e)}")


def handle_upload(event: dict, user: dict) -> dict:
    """
    POST /upload
    Body: { "filename": "sales_data.csv", "content_type": "text/csv" }
    Returns a presigned URL for direct S3 upload from the browser.
    """
    body = json.loads(event.get("body") or "{}")
    filename = body.get("filename", "").strip()
    content_type = body.get("content_type", "text/csv")

    if not filename:
        return error_response(400, "filename is required")

    # Scope uploads to the user's sub directory
    s3_key = f"uploads/{user['sub']}/{int(time.time())}_{filename}"

    presigned_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": DATASET_BUCKET,
            "Key": s3_key,
            "ContentType": content_type,
        },
        ExpiresIn=300,  # 5 minutes
    )

    logger.info(f"Presigned URL generated for {user['email']}: {s3_key}")

    return success_response({
        "upload_url": presigned_url,
        "s3_key": s3_key,
        "expires_in": 300,
    })


def handle_results(event: dict, user: dict) -> dict:
    """
    GET /results/{executionId}
    Poll Athena for query results by execution ID.
    """
    execution_id = event.get("pathParameters", {}).get("executionId", "")

    if not execution_id:
        return error_response(400, "executionId is required")

    try:
        status = athena.get_query_execution(QueryExecutionId=execution_id)
        state = status["QueryExecution"]["Status"]["State"]

        if state == "RUNNING" or state == "QUEUED":
            return success_response({"status": state, "execution_id": execution_id})

        if state in ("FAILED", "CANCELLED"):
            reason = status["QueryExecution"]["Status"].get("StateChangeReason", "")
            return error_response(500, f"Query {state}: {reason}")

        # SUCCEEDED — fetch rows
        results = athena.get_query_results(
            QueryExecutionId=execution_id, MaxResults=200
        )
        rows = results["ResultSet"]["Rows"]
        columns = [c.get("VarCharValue", "") for c in rows[0]["Data"]] if rows else []
        data = [
            [cell.get("VarCharValue", "") for cell in row["Data"]]
            for row in rows[1:]
        ]

        return success_response({
            "status": "SUCCEEDED",
            "execution_id": execution_id,
            "columns": columns,
            "rows": data,
            "row_count": len(data),
        })

    except athena.exceptions.InvalidRequestException as e:
        return error_response(400, str(e))
    except Exception as e:
        logger.error(f"Results fetch error: {e}", exc_info=True)
        return error_response(500, str(e))


# ── Router ────────────────────────────────────────────────────────────────────

def lambda_handler(event, context):
    logger.info(f"Path: {event.get('resource')} Method: {event.get('httpMethod')}")

    user = {
        "sub": "anonymous",
        "email": "user@askql.app",
        "name": "User",
    }

    resource = event.get("resource", "")
    method = event.get("httpMethod", "")

    if resource == "/query" and method == "POST":
        return handle_query(event, user)

    if resource == "/upload" and method == "POST":
        return handle_upload(event, user)

    if resource == "/results/{executionId}" and method == "GET":
        return handle_results(event, user)

    return error_response(404, f"Route not found: {method} {resource}")


# ── Helpers ───────────────────────────────────────────────────────────────────

def success_response(data: dict, status_code: int = 200) -> dict:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
        "body": json.dumps(data),
    }


def error_response(status_code: int, message: str) -> dict:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps({"error": message}),
    }
