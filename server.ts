import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { InvalidInput, check, toUserError } from "./lib/check.ts";

/** Local-only server: one page, one endpoint. Nothing is stored or logged. */

const PORT = Number(process.env["PORT"] ?? 3300);
// Loopback by default: this holds an API key and has no rate limiting, so it
// should not be reachable from the rest of the network unless you say so.
const HOST = process.env["HOST"] ?? "127.0.0.1";
const PAGE = new URL("./public/index.html", import.meta.url);
const MAX_BODY_BYTES = 64 * 1024;

if (!process.env["TYPESAFE_API_KEY"]) {
  console.error(
    "TYPESAFE_API_KEY is not set.\n" +
      "  cp .env.example .env    then paste your key into .env\n" +
      "  pnpm dev",
  );
  process.exit(1);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * Read the request body, holding at most MAX_BODY_BYTES. Anything past the cap
 * is drained and discarded rather than buffered, so the client still gets a
 * real answer instead of a reset connection.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) reject(new InvalidInput("That message is too long to check."));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function parseInput(raw: string): { message: string; sender?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidInput("The request could not be read.");
  }
  if (typeof parsed !== "object" || parsed === null) throw new InvalidInput("The request could not be read.");

  const { message, sender } = parsed as Record<string, unknown>;
  if (typeof message !== "string") throw new InvalidInput("Paste the message you want checked.");
  if (sender !== undefined && sender !== null && typeof sender !== "string") {
    throw new InvalidInput("The sender field must be text.");
  }
  return typeof sender === "string" && sender.trim() ? { message, sender } : { message };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    const html = await readFile(PAGE);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": html.length,
      "cache-control": "no-store",
    });
    res.end(html);
    return;
  }

  if (req.method === "POST" && path === "/api/check") {
    const input = parseInput(await readBody(req));
    sendJson(res, 200, await check(input));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    const { status, message } = toUserError(err);
    // Server-side only: the client never sees the raw error.
    if (status >= 500) console.error("[check] failed:", err);
    if (!res.headersSent) sendJson(res, status, { error: message });
    else res.end();
  });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Start it somewhere else:\n  PORT=${PORT + 1} pnpm dev`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`Scam checker on http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${PORT}`);
});
