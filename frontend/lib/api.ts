const API_URL = process.env.NEXT_PUBLIC_API_URL!;

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(error.error || `Request failed: ${response.status}`);
  }

  return response.json();
}

export interface QueryResult {
  answer: string;
  sql?: string;
  session_id: string;
  columns?: string[];
  rows?: string[][];
  row_count?: number;
}

export interface UploadResult {
  upload_url: string;
  s3_key: string;
  expires_in: number;
}

export async function runQuery(
  prompt: string,
  sessionId?: string
): Promise<QueryResult> {
  return apiFetch<QueryResult>("/query", {
    method: "POST",
    body: JSON.stringify({ prompt, session_id: sessionId }),
  });
}

export async function getUploadUrl(
  filename: string,
  contentType: string = "text/csv"
): Promise<UploadResult> {
  return apiFetch<UploadResult>("/upload", {
    method: "POST",
    body: JSON.stringify({ filename, content_type: contentType }),
  });
}

export async function uploadFileToS3(
  file: File,
  presignedUrl: string
): Promise<void> {
  const response = await fetch(presignedUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type || "text/csv" },
  });

  if (!response.ok) {
    throw new Error(`S3 upload failed: ${response.status}`);
  }
}