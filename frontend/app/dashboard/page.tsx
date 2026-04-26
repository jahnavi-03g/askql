"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  runQuery,
  getUploadUrl,
  uploadFileToS3,
  type QueryResult,
} from "@/lib/api";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

function parseContent(content: string): Array<{ type: "text" | "sql"; value: string }> {
  const blocks: Array<{ type: "text" | "sql"; value: string }> = [];
  const sqlRegex = /```sql([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  while ((match = sqlRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index).trim();
      if (text) blocks.push({ type: "text", value: text });
    }
    blocks.push({ type: "sql", value: match[1].trim() });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) blocks.push({ type: "text", value: text });
  }
  if (blocks.length === 0) blocks.push({ type: "text", value: content });
  return blocks;
}

function renderText(text: string) {
  const parts = text.split(/\*\*(.*?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i} style={{ fontWeight: 600, color: "#fff" }}>{part}</strong> : part
  );
}

export default function DashboardPage() {
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleReset = () => {
    setMessages([]);
    setPrompt("");
    setUploadedFile(null);
    setError(null);
    setSessionId(crypto.randomUUID());
  };

  const handleUpload = async (file: File) => {
    if (!file.name.endsWith(".csv") && !file.name.endsWith(".json")) {
      setError("Only CSV or JSON files are supported");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const { upload_url } = await getUploadUrl(file.name, file.type || "text/csv");
      await uploadFileToS3(file, upload_url);
      setUploadedFile(file.name);
      addMessage("assistant",
        `Dataset **${file.name}** uploaded successfully! Schema is being indexed — this takes about 30 seconds. Then start asking questions about your data.`
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const handleQuery = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;
    setPrompt("");
    setError(null);
    setLoading(true);
    addMessage("user", trimmed);
    try {
      const result = await runQuery(trimmed, sessionId);
      addMessage("assistant", result.answer);
    } catch (e: any) {
      setError(e.message);
      addMessage("assistant", `Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const addMessage = (role: "user" | "assistant", content: string) => {
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(), role, content, timestamp: new Date()
    }]);
  };

  const copySQL = (sql: string, id: string) => {
    navigator.clipboard.writeText(sql);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <>
      <div className="root">
        <div className="bg-grid" />

        {/* Header */}
        <header className="header">
          <div className="header-inner">
            <button className="logo" onClick={handleReset} title="New conversation">
              Ask<span className="logo-accent">QL</span>
            </button>
            {uploadedFile && (
              <div className="file-badge">
                <span className="file-dot" />
                {uploadedFile}
              </div>
            )}
          </div>
        </header>

        {/* Messages — scrollable middle */}
        <main className="messages-area">
          {messages.length === 0 ? (
            <div className="empty-state">
              {/* SQL Icon */}
              <div className="sql-icon">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                  <rect width="48" height="48" rx="12" fill="rgba(99,102,241,0.15)" />
                  <rect x="8" y="14" width="32" height="4" rx="2" fill="#6366f1" opacity="0.6"/>
                  <rect x="8" y="22" width="24" height="4" rx="2" fill="#6366f1" opacity="0.8"/>
                  <rect x="8" y="30" width="28" height="4" rx="2" fill="#6366f1"/>
                  <circle cx="38" cy="32" r="6" fill="#22c55e"/>
                  <path d="M35.5 32l2 2 3-3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <h2 className="empty-title">Natural Language to SQL</h2>
              <p className="empty-sub">Upload a dataset and ask anything in plain English</p>
              <div className="examples">
                {[
                  "Show me total revenue by month",
                  "Find all records where amount > 1000",
                  "Which product had the most sales?",
                  "What is the average order value?",
                ].map((ex) => (
                  <button
                    key={ex}
                    className="example-chip"
                    onClick={() => { setPrompt(ex); inputRef.current?.focus(); }}
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages-list">
              {messages.map((msg) => {
                const blocks = parseContent(msg.content);
                return (
                  <div key={msg.id} className={`message-row ${msg.role}`}>
                    {msg.role === "assistant" && <div className="avatar">A</div>}
                    <div className="message-content">
                      {blocks.map((block, i) =>
                        block.type === "sql" ? (
                          <div key={i} className="sql-block">
                            <div className="sql-header">
                              <div className="sql-dots">
                                <span /><span /><span />
                              </div>
                              <span className="sql-label">SQL</span>
                              <button
                                className="copy-btn"
                                onClick={() => copySQL(block.value, `${msg.id}-${i}`)}
                              >
                                {copied === `${msg.id}-${i}` ? "✓ Copied" : "Copy"}
                              </button>
                            </div>
                            <pre className="sql-code">{block.value}</pre>
                          </div>
                        ) : (
                          <p key={i} className={`text-block ${msg.role}`}>
                            {renderText(block.value)}
                          </p>
                        )
                      )}
                    </div>
                    {msg.role === "user" && <div className="avatar user-avatar">U</div>}
                  </div>
                );
              })}
              {loading && (
                <div className="message-row assistant">
                  <div className="avatar">A</div>
                  <div className="typing-indicator">
                    <span /><span /><span />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </main>

        {/* Input — always stuck to bottom */}
        <footer className="input-area">
          <div className="input-inner">
            {error && (
              <div className="error-bar">
                <span>⚠</span> {error}
                <button onClick={() => setError(null)}>✕</button>
              </div>
            )}
            <div className="input-row">
              {/* Upload button beside input */}
              <button
                className="upload-icon-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                title="Upload CSV or JSON dataset"
              >
                {uploading ? (
                  <svg className="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                  </svg>
                ) : (
                  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
                  </svg>
                )}
              </button>

              <div className="input-box">
                <input
                  ref={inputRef}
                  type="text"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleQuery()}
                  placeholder={uploadedFile ? `Ask something about ${uploadedFile}...` : "Upload a dataset, then ask questions..."}
                  className="text-input"
                  disabled={loading}
                />
                <button
                  onClick={handleQuery}
                  disabled={!prompt.trim() || loading}
                  className="ask-btn"
                >
                  {loading ? (
                    <svg className="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z"/>
                    </svg>
                  )}
                </button>
              </div>
            </div>
            <p className="bottom-hint">
              Only CSV or JSON files are supported · Powered by Amazon Bedrock · Claude Haiku 4.5
            </p>
          </div>
        </footer>

        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.json"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleUpload(file);
            e.target.value = "";
          }}
        />
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Syne:wght@400;500;600;700;800&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        html, body, #__next { height: 100%; }

        .root {
          height: 100vh;
          display: flex;
          flex-direction: column;
          background: #0a0a0f;
          color: #e2e2e8;
          font-family: 'Syne', sans-serif;
          position: relative;
          overflow: hidden;
        }

        .bg-grid {
          position: fixed;
          inset: 0;
          background-image:
            linear-gradient(rgba(99,102,241,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(99,102,241,0.03) 1px, transparent 1px);
          background-size: 40px 40px;
          pointer-events: none;
          z-index: 0;
        }

        /* Header */
        .header {
          flex-shrink: 0;
          z-index: 50;
          background: rgba(10,10,15,0.85);
          backdrop-filter: blur(20px);
          border-bottom: 1px solid rgba(99,102,241,0.12);
          padding: 0 24px;
        }

        .header-inner {
          max-width: 860px;
          margin: 0 auto;
          display: flex;
          align-items: center;
          justify-content: space-between;
          height: 56px;
        }

        .logo {
          font-size: 20px;
          font-weight: 800;
          letter-spacing: -0.5px;
          color: #fff;
          background: none;
          border: none;
          cursor: pointer;
          font-family: 'Syne', sans-serif;
          transition: opacity 0.2s;
          padding: 4px 8px;
          border-radius: 6px;
        }

        .logo:hover { opacity: 0.75; }

        .logo-accent { color: #6366f1; }

        .file-badge {
          display: flex;
          align-items: center;
          gap: 6px;
          background: rgba(99,102,241,0.1);
          border: 1px solid rgba(99,102,241,0.25);
          border-radius: 20px;
          padding: 4px 12px;
          font-size: 12px;
          color: #a5b4fc;
          font-family: 'JetBrains Mono', monospace;
          max-width: 240px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .file-dot {
          width: 6px;
          height: 6px;
          background: #22c55e;
          border-radius: 50%;
          flex-shrink: 0;
          animation: pulse 2s infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }

        /* Messages */
        .messages-area {
          flex: 1;
          overflow-y: auto;
          padding: 32px 24px 16px;
          position: relative;
          z-index: 1;
        }

        .messages-list {
          max-width: 860px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 24px;
        }

        /* Empty state */
        .empty-state {
          max-width: 540px;
          margin: 60px auto;
          text-align: center;
        }

        .sql-icon {
          display: inline-flex;
          margin-bottom: 20px;
          filter: drop-shadow(0 0 24px rgba(99,102,241,0.4));
        }

        .empty-title {
          font-size: 36px;
          font-weight: 800;
          color: #fff;
          letter-spacing: -1.5px;
          margin-bottom: 10px;
          line-height: 1.1;
        }

        .empty-sub {
          font-size: 15px;
          color: rgba(255,255,255,0.35);
          margin-bottom: 32px;
          line-height: 1.6;
        }

        .examples {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          justify-content: center;
        }

        .example-chip {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.45);
          border-radius: 20px;
          padding: 8px 16px;
          font-size: 13px;
          font-family: 'Syne', sans-serif;
          cursor: pointer;
          transition: all 0.2s;
        }

        .example-chip:hover {
          background: rgba(99,102,241,0.1);
          border-color: rgba(99,102,241,0.3);
          color: #a5b4fc;
        }

        /* Message rows */
        .message-row {
          display: flex;
          gap: 12px;
          align-items: flex-start;
        }

        .message-row.user { flex-direction: row-reverse; }

        .avatar {
          width: 30px;
          height: 30px;
          border-radius: 8px;
          background: rgba(99,102,241,0.2);
          border: 1px solid rgba(99,102,241,0.3);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          font-weight: 700;
          color: #6366f1;
          flex-shrink: 0;
          font-family: 'JetBrains Mono', monospace;
        }

        .user-avatar {
          background: rgba(255,255,255,0.05);
          border-color: rgba(255,255,255,0.1);
          color: rgba(255,255,255,0.4);
        }

        .message-content {
          flex: 1;
          max-width: calc(100% - 42px);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .message-row.user .message-content { align-items: flex-end; }

        .text-block {
          font-size: 14px;
          line-height: 1.75;
          color: rgba(255,255,255,0.72);
        }

        .text-block.user {
          background: #6366f1;
          color: #fff;
          padding: 10px 16px;
          border-radius: 16px 16px 4px 16px;
          font-size: 14px;
          max-width: 480px;
          line-height: 1.5;
        }

        /* SQL block */
        .sql-block {
          background: #0d0d14;
          border: 1px solid rgba(99,102,241,0.2);
          border-radius: 12px;
          overflow: hidden;
          width: 100%;
        }

        .sql-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 14px;
          background: rgba(99,102,241,0.07);
          border-bottom: 1px solid rgba(99,102,241,0.12);
        }

        .sql-dots { display: flex; gap: 4px; }
        .sql-dots span { width: 8px; height: 8px; border-radius: 50%; }
        .sql-dots span:nth-child(1) { background: #ff5f57; }
        .sql-dots span:nth-child(2) { background: #febc2e; }
        .sql-dots span:nth-child(3) { background: #28c840; }

        .sql-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          color: rgba(255,255,255,0.25);
          flex: 1;
          text-align: center;
          letter-spacing: 2px;
          text-transform: uppercase;
        }

        .copy-btn {
          font-size: 11px;
          color: rgba(255,255,255,0.3);
          background: none;
          border: none;
          cursor: pointer;
          font-family: 'JetBrains Mono', monospace;
          transition: color 0.2s;
          padding: 2px 8px;
          border-radius: 4px;
        }

        .copy-btn:hover {
          color: #a5b4fc;
          background: rgba(99,102,241,0.1);
        }

        .sql-code {
          padding: 16px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 13px;
          color: #7dd3fc;
          white-space: pre-wrap;
          overflow-x: auto;
          line-height: 1.65;
        }

        /* Typing indicator */
        .typing-indicator {
          display: flex;
          gap: 4px;
          align-items: center;
          padding: 12px 16px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 12px;
          width: fit-content;
        }

        .typing-indicator span {
          width: 6px;
          height: 6px;
          background: #6366f1;
          border-radius: 50%;
          animation: bounce 1.2s infinite;
        }

        .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
        .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

        @keyframes bounce {
          0%, 100% { transform: translateY(0); opacity: 0.4; }
          50% { transform: translateY(-5px); opacity: 1; }
        }

        /* Footer / Input area */
        .input-area {
          flex-shrink: 0;
          z-index: 50;
          background: rgba(10,10,15,0.92);
          backdrop-filter: blur(20px);
          border-top: 1px solid rgba(99,102,241,0.1);
          padding: 14px 24px 18px;
        }

        .input-inner {
          max-width: 860px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .error-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          background: rgba(239,68,68,0.08);
          border: 1px solid rgba(239,68,68,0.2);
          border-radius: 8px;
          padding: 8px 12px;
          font-size: 13px;
          color: #fca5a5;
        }

        .error-bar button {
          margin-left: auto;
          background: none;
          border: none;
          color: #fca5a5;
          cursor: pointer;
        }

        .input-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        /* Upload icon button */
        .upload-icon-btn {
          width: 44px;
          height: 44px;
          flex-shrink: 0;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 12px;
          color: rgba(255,255,255,0.4);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
        }

        .upload-icon-btn:hover {
          background: rgba(99,102,241,0.12);
          border-color: rgba(99,102,241,0.3);
          color: #a5b4fc;
        }

        .upload-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        .input-box {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 8px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(99,102,241,0.18);
          border-radius: 14px;
          padding: 6px 6px 6px 16px;
          transition: border-color 0.2s, background 0.2s;
        }

        .input-box:focus-within {
          border-color: rgba(99,102,241,0.45);
          background: rgba(99,102,241,0.04);
        }

        .text-input {
          flex: 1;
          background: none;
          border: none;
          outline: none;
          color: #fff;
          font-size: 14px;
          font-family: 'Syne', sans-serif;
          padding: 6px 0;
        }

        .text-input::placeholder { color: rgba(255,255,255,0.2); }
        .text-input:disabled { opacity: 0.5; }

        .ask-btn {
          width: 40px;
          height: 40px;
          background: #6366f1;
          border: none;
          border-radius: 10px;
          color: #fff;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
          flex-shrink: 0;
        }

        .ask-btn:hover:not(:disabled) {
          background: #4f46e5;
          transform: scale(1.05);
        }

        .ask-btn:disabled { opacity: 0.3; cursor: not-allowed; transform: none; }

        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }

        .bottom-hint {
          text-align: center;
          font-size: 11px;
          color: rgba(255,255,255,0.12);
          letter-spacing: 0.2px;
        }

        /* Scrollbar */
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.2); border-radius: 2px; }
      `}</style>
    </>
  );
}