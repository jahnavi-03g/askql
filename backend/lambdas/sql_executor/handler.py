import json
import boto3
import os
import time
import logging
import re

logger = logging.getLogger()
logger.setLevel(logging.INFO)

athena = boto3.client("athena")

ATHENA_RESULTS_BUCKET = os.environ.get("ATHENA_RESULTS_BUCKET", "")
ATHENA_DATABASE = os.environ.get("ATHENA_DATABASE", "askql_db")

# Simple SQL validation — block dangerous statements
BLOCKED_PATTERNS = [
    r"\bDROP\b",
    r"\bDELETE\b",
    r"\bTRUNCATE\b",
    r"\bINSERT\b",
    r"\bUPDATE\b",
    r"\bALTER\b",
    r"\bCREATE\b",
    r"\bGRANT\b",
    r"\bREVOKE\b",
]


def validate_sql(sql: str) -> tuple[bool, str]:
    """Basic SQL safety validation — only allow SELECT queries."""
    sql_upper = sql.upper().strip()

    if not sql_upper.startswith("SELECT") and not sql_upper.startswith("WITH"):
        return False, "Only SELECT queries are allowed"

    for pattern in BLOCKED_PATTERNS:
        if re.search(pattern, sql_upper):
            return False, f"Blocked SQL keyword detected: {pattern}"

    return True, "ok"


def execute_athena_query(sql: str) -> dict:
    """Execute SQL on Athena and wait for results."""
    response = athena.start_query_execution(
        QueryString=sql,
        QueryExecutionContext={"Database": ATHENA_DATABASE},
        ResultConfiguration={
            "OutputLocation": f"s3://{ATHENA_RESULTS_BUCKET}/query-results/",
        },
        WorkGroup="primary",
    )

    execution_id = response["QueryExecutionId"]
    logger.info(f"Athena query started: {execution_id}")

    # Poll for completion (max 30 seconds)
    for attempt in range(15):
        status = athena.get_query_execution(QueryExecutionId=execution_id)
        state = status["QueryExecution"]["Status"]["State"]

        if state == "SUCCEEDED":
            break
        elif state in ("FAILED", "CANCELLED"):
            reason = status["QueryExecution"]["Status"].get(
                "StateChangeReason", "Unknown error"
            )
            raise Exception(f"Athena query {state}: {reason}")

        time.sleep(2)
    else:
        raise Exception("Athena query timed out after 30 seconds")

    # Fetch results (first 100 rows)
    results = athena.get_query_results(
        QueryExecutionId=execution_id,
        MaxResults=100,
    )

    rows = results["ResultSet"]["Rows"]
    if not rows:
        return {"execution_id": execution_id, "columns": [], "rows": [], "row_count": 0}

    # First row is column headers
    columns = [col.get("VarCharValue", "") for col in rows[0]["Data"]]
    data_rows = []
    for row in rows[1:]:
        data_rows.append([cell.get("VarCharValue", "") for cell in row["Data"]])

    return {
        "execution_id": execution_id,
        "columns": columns,
        "rows": data_rows,
        "row_count": len(data_rows),
    }


def lambda_handler(event, context):
    """
    Bedrock Agent Action Group handler.
    Called by the agent when it wants to validate + execute SQL.

    Bedrock passes the action in this format:
    {
      "actionGroup": "validate_and_run",
      "function": "execute_sql",
      "parameters": [{"name": "sql", "value": "SELECT ..."}]
    }
    """
    logger.info(f"Event: {json.dumps(event)}")

    try:
        # Extract parameters from Bedrock agent call
        action_group = event.get("actionGroup", "")
        function_name = event.get("function", "")
        parameters = event.get("parameters", [])

        # Parse SQL parameter
        sql = None
        for param in parameters:
            if param["name"] == "sql":
                sql = param["value"]
                break

        if not sql:
            return build_response(action_group, function_name, {
                "success": False,
                "error": "No SQL provided",
            })

        logger.info(f"Executing SQL: {sql}")

        # 1. Validate
        is_valid, validation_message = validate_sql(sql)
        if not is_valid:
            return build_response(action_group, function_name, {
                "success": False,
                "error": f"SQL validation failed: {validation_message}",
                "sql": sql,
            })

        # 2. Execute on Athena
        result = execute_athena_query(sql)

        return build_response(action_group, function_name, {
            "success": True,
            "sql": sql,
            "execution_id": result["execution_id"],
            "columns": result["columns"],
            "rows": result["rows"],
            "row_count": result["row_count"],
        })

    except Exception as e:
        logger.error(f"SQL execution failed: {e}", exc_info=True)
        return build_response(
            event.get("actionGroup", ""),
            event.get("function", ""),
            {
                "success": False,
                "error": str(e),
            },
        )


def build_response(action_group: str, function_name: str, result: dict) -> dict:
    """Format response for Bedrock Agent."""
    return {
        "actionGroup": action_group,
        "function": function_name,
        "functionResponse": {
            "responseBody": {
                "TEXT": {
                    "body": json.dumps(result),
                }
            }
        },
    }
