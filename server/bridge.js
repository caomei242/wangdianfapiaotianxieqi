import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnvFile(path.resolve(__dirname, "..", ".env"));
await loadEnvFile(path.resolve(__dirname, ".env"), true);

const HOST = process.env.OCR_BRIDGE_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.OCR_BRIDGE_PORT || "8765", 10);
const BODY_LIMIT_MB = Number.parseInt(process.env.OCR_BRIDGE_BODY_LIMIT_MB || "25", 10);
const BODY_LIMIT_BYTES = BODY_LIMIT_MB * 1024 * 1024;
const MINIMAX_API_HOST = process.env.MINIMAX_API_HOST || "https://api.minimaxi.com";
const MCP_COMMAND = process.env.MINIMAX_MCP_COMMAND || "uvx";
const MCP_ARGS = process.env.MINIMAX_MCP_ARGS
  ? splitArgs(process.env.MINIMAX_MCP_ARGS)
  : ["minimax-coding-plan-mcp", "-y"];

const OCR_PROMPT = `
You are extracting bill information from a Chinese ecommerce bill screenshot for invoice assistance.
Return only strict JSON with this exact shape:
{
  "bills": [
    { "name": "string", "type": "string", "month": "YYYY-MM or empty string", "amount": number, "confidence": number }
  ],
  "totalAmount": number,
  "receiverName": "string",
  "warnings": ["string"],
  "rawText": "string"
}
Rules:
- Extract all recognizable bill/payment/order/fee rows.
- amount must be a plain number in CNY, without currency symbols or commas.
- confidence must be between 0 and 1.
- Use empty strings and warnings when uncertain.
`;

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "ocr-bridge",
        host: HOST,
        port: PORT,
        mcpCommand: [MCP_COMMAND, ...MCP_ARGS].join(" "),
        minimaxApiHost: MINIMAX_API_HOST
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/ocr/bills") {
      const body = await readJsonBody(req);
      if (!body || typeof body.imageDataUrl !== "string") {
        throw httpError(400, "Request body must be JSON with a string imageDataUrl field.");
      }

      ensureConfigured();
      const imageFile = await writeDataUrlToTempFile(body.imageDataUrl);
      try {
        const modelText = await callUnderstandImage(imageFile);
        const extracted = extractJson(modelText);
        const normalized = normalizeOcrResult(extracted, modelText);
        sendJson(res, 200, normalized);
      } finally {
        await rm(path.dirname(imageFile), { recursive: true, force: true });
      }
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, {
      error: error.message || "Internal server error",
      code: error.code || undefined
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`OCR bridge listening at http://${HOST}:${PORT}`);
});

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function loadEnvFile(filePath, override = false) {
  let text = "";
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > BODY_LIMIT_BYTES) {
        reject(httpError(413, `Request body exceeds ${BODY_LIMIT_MB}MB limit.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", reject);
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(httpError(400, "Request body must be valid JSON."));
      }
    });
  });
}

function ensureConfigured() {
  if (!process.env.MINIMAX_API_KEY) {
    throw httpError(500, "MINIMAX_API_KEY is not set. Put it in local .env; never commit the key.");
  }
}

async function writeDataUrlToTempFile(imageDataUrl) {
  const match = imageDataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) {
    throw httpError(400, "imageDataUrl must be a base64 data URL for PNG, JPEG, or WebP.");
  }

  const mime = match[1].replace("image/jpg", "image/jpeg");
  const extension = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp"
  }[mime];

  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!buffer.length) {
    throw httpError(400, "imageDataUrl did not contain image bytes.");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ocr-bridge-"));
  const imagePath = path.join(tempDir, `screenshot.${extension}`);
  await writeFile(imagePath, buffer);
  return imagePath;
}

async function callUnderstandImage(imagePath) {
  await assertCommandLikelyAvailable(MCP_COMMAND);

  const client = new StdioMcpClient(MCP_COMMAND, MCP_ARGS, {
    ...process.env,
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
    MINIMAX_API_HOST
  });

  try {
    await client.start();
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "wangdian-ocr-bridge", version: "0.1.0" }
    });
    client.notify("notifications/initialized", {});

    const response = await client.request("tools/call", {
      name: "understand_image",
      arguments: {
        prompt: OCR_PROMPT.trim(),
        image_source: imagePath
      }
    }, 120000);

    if (response?.isError) {
      throw httpError(502, `MiniMax understand_image failed: ${stringifyContent(response.content)}`);
    }

    return stringifyContent(response?.content ?? response);
  } finally {
    client.close();
  }
}

async function assertCommandLikelyAvailable(command) {
  if (command.includes("/") || command.startsWith(".")) {
    try {
      await access(command);
    } catch {
      throw httpError(500, `MCP command not found: ${command}`);
    }
  }
}

function stringifyContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item?.text === "string") return item.text;
      if (typeof item?.content === "string") return item.content;
      return JSON.stringify(item);
    }).join("\n");
  }
  return JSON.stringify(content);
}

class StdioMcpClient {
  constructor(command, args, env) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
  }

  start() {
    return new Promise((resolve, reject) => {
      this.child = spawn(this.command, this.args, {
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"]
      });

      const failStartup = (error) => {
        reject(httpError(500, `Unable to start MiniMax MCP via "${[this.command, ...this.args].join(" ")}": ${error.message}`));
      };

      this.child.once("error", failStartup);
      this.child.stdout.on("data", (chunk) => this.onData(chunk));
      this.child.stderr.on("data", (chunk) => {
        this.stderr += chunk.toString("utf8");
        if (this.stderr.length > 4000) this.stderr = this.stderr.slice(-4000);
      });
      this.child.once("spawn", () => {
        this.child.off("error", failStartup);
        resolve();
      });
      this.child.on("exit", (code, signal) => {
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(httpError(502, `MiniMax MCP exited early (${signal || code}). ${this.stderr.trim()}`.trim()));
        }
        this.pending.clear();
      });
    });
  }

  request(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(httpError(504, `Timed out waiting for MCP method ${method}. ${this.stderr.trim()}`.trim()));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.send(message);
    });
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  send(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number.parseInt(lengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) return;

      const raw = this.buffer.slice(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.slice(messageEnd);
      this.handleMessage(JSON.parse(raw));
    }
  }

  handleMessage(message) {
    if (!message.id || !this.pending.has(message.id)) return;

    const pending = this.pending.get(message.id);
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(httpError(502, `MCP ${message.error.code || "error"}: ${message.error.message || JSON.stringify(message.error)}`));
    } else {
      pending.resolve(message.result);
    }
  }

  close() {
    if (!this.child || this.child.killed) return;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}

function extractJson(text) {
  if (!text || typeof text !== "string") {
    return {};
  }

  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  for (const block of fenced) {
    candidates.push(block.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim());
  }
  candidates.push(text.trim());

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next extraction strategy.
    }
  }

  return { rawText: text, warnings: ["Model response did not contain parseable JSON."] };
}

function normalizeOcrResult(parsed, modelText) {
  const warnings = asArray(parsed?.warnings).map(String);
  const bills = asArray(parsed?.bills).map((bill) => ({
    name: stringValue(bill?.name),
    type: stringValue(bill?.type),
    month: stringValue(bill?.month),
    amount: numberValue(bill?.amount),
    confidence: clamp(numberValue(bill?.confidence, 0), 0, 1)
  }));

  if (!bills.length) {
    warnings.push("No bill rows were confidently extracted.");
  }

  const calculatedTotal = roundMoney(bills.reduce((sum, bill) => sum + bill.amount, 0));
  const totalAmount = parsed?.totalAmount === undefined
    ? calculatedTotal
    : numberValue(parsed.totalAmount, calculatedTotal);

  return {
    bills,
    totalAmount: roundMoney(totalAmount),
    receiverName: stringValue(parsed?.receiverName),
    warnings: [...new Set(warnings.filter(Boolean))],
    rawText: stringValue(parsed?.rawText) || modelText || ""
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function numberValue(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number.parseFloat(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function splitArgs(value) {
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) || [];
}

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}
