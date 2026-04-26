import json
import boto3
import os
import io
import csv
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client("s3")
bedrock_agent = boto3.client("bedrock-agent")
glue = boto3.client("glue")
athena = boto3.client("athena")

KNOWLEDGE_BASE_ID = os.environ.get("KNOWLEDGE_BASE_ID", "")
DATA_SOURCE_ID = os.environ.get("DATA_SOURCE_ID", "")
ATHENA_RESULTS_BUCKET = os.environ.get("ATHENA_RESULTS_BUCKET", "")
ATHENA_DATABASE = "askql_db"


def infer_schema(bucket: str, key: str) -> dict:
    """Download file from S3 and infer column names, types and sample values."""
    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj["Body"].read().decode("utf-8")
    filename = key.split("/")[-1]
    table_name = filename.replace(".", "_").replace("-", "_").replace(" ", "_")

    if key.endswith(".csv"):
        reader = csv.DictReader(io.StringIO(body))
        rows = list(reader)
        if not rows:
            raise ValueError("CSV file is empty")

        columns = []
        for col in rows[0].keys():
            samples = [r[col] for r in rows[:5] if r.get(col)]
            col_type = infer_type(samples)
            columns.append({
                "name": col.strip(),
                "type": col_type,
                "samples": samples[:3],
            })

        return {
            "table_name": table_name,
            "source_file": key,
            "row_count": len(rows),
            "columns": columns,
        }

    elif key.endswith(".json"):
        data = json.loads(body)
        if isinstance(data, list):
            rows = data
        elif isinstance(data, dict):
            rows = [data]
        else:
            raise ValueError("Unsupported JSON structure")

        if not rows:
            raise ValueError("JSON file is empty")

        columns = []
        for col in rows[0].keys():
            samples = [str(r.get(col, "")) for r in rows[:5] if r.get(col) is not None]
            col_type = infer_type(samples)
            columns.append({
                "name": col.strip(),
                "type": col_type,
                "samples": samples[:3],
            })

        return {
            "table_name": table_name,
            "source_file": key,
            "row_count": len(rows),
            "columns": columns,
        }

    raise ValueError(f"Unsupported file type: {key}")


def infer_type(samples: list) -> str:
    """Simple type inference from sample values."""
    if not samples:
        return "string"

    numeric_count = 0
    for s in samples:
        try:
            float(str(s).replace(",", ""))
            numeric_count += 1
        except ValueError:
            pass

    if numeric_count == len(samples):
        # Check if all are integers
        all_int = all("." not in str(s) for s in samples)
        return "bigint" if all_int else "double"

    return "string"


def create_athena_table(schema: dict, bucket: str, key: str):
    """Register the dataset as an Athena table via Glue."""
    db_name = ATHENA_DATABASE
    table_name = schema["table_name"]

    # Ensure database exists
    try:
        glue.create_database(DatabaseInput={"Name": db_name})
        logger.info(f"Created Glue database: {db_name}")
    except glue.exceptions.AlreadyExistsException:
        pass

    # Build column definitions
    columns = [
        {"Name": col["name"], "Type": col["type"]}
        for col in schema["columns"]
    ]

    # S3 location for this file
    s3_location = f"s3://{bucket}/{'/'.join(key.split('/')[:-1])}/"

    try:
        glue.create_table(
            DatabaseName=db_name,
            TableInput={
                "Name": table_name,
                "StorageDescriptor": {
                    "Columns": columns,
                    "Location": s3_location,
                    "InputFormat": "org.apache.hadoop.mapred.TextInputFormat",
                    "OutputFormat": "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
                    "SerdeInfo": {
                        "SerializationLibrary": "org.apache.hadoop.hive.serde2.OpenCSVSerde",
                        "Parameters": {
                            "separatorChar": ",",
                            "quoteChar": '"',
                            "skip.header.line.count": "1",
                        },
                    },
                },
                "Parameters": {"classification": "csv"},
            },
        )
        logger.info(f"Created Glue table: {db_name}.{table_name}")
    except glue.exceptions.AlreadyExistsException:
        logger.info(f"Table already exists: {db_name}.{table_name}")


def format_schema_document(schema: dict) -> str:
    """Format schema as a readable document for Bedrock KB embedding."""
    lines = [
        f"Table: {schema['table_name']}",
        f"Source file: {schema['source_file']}",
        f"Total rows: {schema['row_count']}",
        "",
        "Columns:",
    ]

    for col in schema["columns"]:
        sample_str = ", ".join(str(s) for s in col["samples"])
        lines.append(
            f"  - {col['name']} ({col['type']}) — example values: {sample_str}"
        )

    lines.extend([
        "",
        f"Use table name '{schema['table_name']}' in SQL queries.",
        f"Database: {ATHENA_DATABASE}",
    ])

    return "\n".join(lines)


def sync_knowledge_base():
    """Trigger a Bedrock Knowledge Base ingestion sync."""
    if not KNOWLEDGE_BASE_ID or KNOWLEDGE_BASE_ID == "PLACEHOLDER":
        logger.warning("KNOWLEDGE_BASE_ID not set — skipping KB sync")
        return

    try:
        response = bedrock_agent.start_ingestion_job(
            knowledgeBaseId=KNOWLEDGE_BASE_ID,
            dataSourceId=DATA_SOURCE_ID,
        )
        logger.info(f"KB sync started: {response['ingestionJob']['ingestionJobId']}")
    except Exception as e:
        logger.error(f"KB sync failed: {e}")


def lambda_handler(event, context):
    """
    Triggered by S3 object creation.
    1. Infer schema from uploaded file
    2. Register as Athena table via Glue
    3. Store schema doc back in S3 for KB ingestion
    4. Trigger Knowledge Base sync
    """
    try:
        record = event["Records"][0]
        bucket = record["s3"]["bucket"]["name"]
        key = record["s3"]["object"]["key"]

        logger.info(f"Processing: s3://{bucket}/{key}")

        # 1. Infer schema
        schema = infer_schema(bucket, key)
        logger.info(f"Schema inferred: {schema['table_name']} ({len(schema['columns'])} columns)")

        # 2. Register in Glue / Athena
        create_athena_table(schema, bucket, key)

        # 3. Write schema document to S3 (KB data source will pick this up)
        schema_doc = format_schema_document(schema)
        schema_key = f"schemas/{schema['table_name']}.txt"
        s3.put_object(
            Bucket=bucket,
            Key=schema_key,
            Body=schema_doc.encode("utf-8"),
            ContentType="text/plain",
        )
        logger.info(f"Schema doc written to s3://{bucket}/{schema_key}")

        # 4. Trigger KB sync
        sync_knowledge_base()

        return {
            "statusCode": 200,
            "body": json.dumps({
                "table": schema["table_name"],
                "columns": len(schema["columns"]),
                "rows": schema["row_count"],
            }),
        }

    except Exception as e:
        logger.error(f"Schema ingestion failed: {e}", exc_info=True)
        raise
