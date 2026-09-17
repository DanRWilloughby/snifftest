/**
 * The local server behind `snifftest serve`.
 *
 * It serves three things: the page, the tab icon, and `POST /score`. A draft
 * is somebody's unpublished writing and, in live mode, a request costs money on
 * somebody's key, so every wall here is about one question: can anything other
 * than the person at this machine, using this page, reach either?
 *
 *   The bind. 127.0.0.1 and nothing else, even when asked. Another machine on
 *   the network never gets a connection.
 *
 *   The Host check. A page on another site can point its own domain at
 *   127.0.0.1 (DNS rebinding) and then talk to this server as "same origin".
 *   Its requests still carry its own name in Host, so anything but the literal
 *   loopback address and this port is turned away before it is routed.
 *
 *   The origin check. Scoring takes POST, takes JSON, and takes it only from
 *   this page. JSON is the point: a cross-site form cannot send it without a
 *   preflight, and no preflight is ever approved, because no CORS header is
 *   ever sent.
 *
 *   The policy. `default-src 'none'`, then only what the one inline page needs,
 *   by nonce. The page cannot load, embed, post to or be framed by anything.
 *
 * Node's `http`, not `Bun.serve`, because `npx snifftest serve` runs on Node.
 * Nothing here writes to disk, and nothing here logs a draft.
 */

import { randomBytes } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { scrubSecrets } from "../scrub.ts";
import { type PageConfig, faviconSvg, renderPage } from "./page.ts";
import type { Scorer } from "./score.ts";

/** The only address this server will ever bind. */
export const LOOPBACK = "127.0.0.1";

/** Placeholder from the plan; `--port` changes it. */
export const DEFAULT_PORT = 4747;

/**
 * The most a scoring request may carry (placeholder). A long essay is tens of
 * kilobytes; a quarter of a megabyte is a whole book chapter with room to spare.
 */
export const MAX_BODY_BYTES = 256 * 1024;

/** The response header the capture lane reads to know the numbers are recorded. */
export const REPLAY_HEADER = "x-snifftest-replay";

export class ServeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeError";
  }
}

export interface ServeOptions {
  readonly port: number;
  /** Accepted only so that asking for anything but the loopback address can be refused out loud. */
  readonly host?: string;
  readonly scorer: Scorer;
  readonly page: PageConfig;
  /** Replay mode: the recorded file's own name, for the header. Never a path. */
  readonly replayName?: string;
  /** Values that must never appear in a response, whatever an upstream error quotes. */
  readonly secrets: readonly string[];
}

export interface ServeHandle {
  readonly url: string;
  readonly port: number;
  readonly address: string;
  close(): Promise<void>;
}

export function startServer(options: ServeOptions): Promise<ServeHandle> {
  if (options.host !== undefined && options.host !== LOOPBACK) {
    return Promise.reject(
      new ServeError(
        `snifftest serve listens on ${LOOPBACK} only, not ${options.host}. Drafts and the key behind this page are not for the network.`,
      ),
    );
  }

  const server = createServer((req, res) => {
    handle(req, res, options).catch(() => {
      // The handler answers its own failures; this is the last line, and it
      // says nothing about what went wrong because it does not know what is safe.
      if (!res.headersSent) respond(res, 500, "text/plain; charset=utf-8", "snifftest serve could not answer that.\n");
      else res.destroy();
    });
  });

  // A local page has no business holding a connection open for minutes.
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  return new Promise((resolvePromise, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        new ServeError(
          error.code === "EADDRINUSE"
            ? `port ${options.port} is taken. Pick another with --port <n>.`
            : `could not listen on ${LOOPBACK}:${options.port} (${error.message}).`,
        ),
      );
    });
    server.listen(options.port, LOOPBACK, () => {
      // SAFETY: a TCP server that is listening always reports an AddressInfo.
      const bound = server.address() as AddressInfo;
      resolvePromise({
        url: `http://${LOOPBACK}:${bound.port}/`,
        port: bound.port,
        address: bound.address,
        close: () => close(server),
      });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections();
  });
}

// --- one request ------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse, options: ServeOptions): Promise<void> {
  const port = req.socket.localPort;
  const expectedHost = `${LOOPBACK}:${port}`;

  if (req.headers.host !== expectedHost) {
    respond(res, 421, "text/plain; charset=utf-8", `This is a local tool. Open http://${expectedHost}/ instead.\n`);
    return;
  }

  // The raw target, not a parsed URL: nothing is ever resolved against the disk,
  // so there is nothing for a clever path to traverse. It matches or it is a 404.
  const target = req.url ?? "";
  const path = target.split("?", 1)[0];

  if (path === "/score") {
    if (req.method !== "POST") {
      respond(res, 405, "text/plain; charset=utf-8", "Scoring takes POST.\n", { allow: "POST" });
      return;
    }
    await score(req, res, options, `http://${expectedHost}`);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    respond(res, 405, "text/plain; charset=utf-8", "That takes GET.\n", { allow: "GET, HEAD" });
    return;
  }

  if (path === "/") {
    const nonce = randomBytes(18).toString("base64");
    respond(res, 200, "text/html; charset=utf-8", renderPage(options.page, nonce), {
      "content-security-policy": pagePolicy(nonce),
      ...(options.replayName === undefined ? {} : { [REPLAY_HEADER]: options.replayName }),
    });
    return;
  }

  if (path === "/favicon.svg") {
    respond(res, 200, "image/svg+xml", faviconSvg());
    return;
  }

  respond(res, 404, "text/plain; charset=utf-8", "Nothing here.\n");
}

async function score(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServeOptions,
  ownOrigin: string,
): Promise<void> {
  const refuse = (status: number, error: string): void =>
    respond(res, status, "application/json; charset=utf-8", JSON.stringify({ error }));

  // A browser always sends Origin on a POST. No Origin means not this page.
  const site = req.headers["sec-fetch-site"];
  if (req.headers.origin !== ownOrigin || (site !== undefined && site !== "same-origin")) {
    refuse(403, "Scoring is for the local page only.");
    return;
  }

  const type = (req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    refuse(415, "Send the draft as application/json.");
    return;
  }

  const tooBig = `That draft is over the ${MAX_BODY_BYTES / 1024} KB this page takes in one go.`;
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    discard(req);
    respond(res, 413, "application/json; charset=utf-8", JSON.stringify({ error: tooBig }), { connection: "close" });
    return;
  }

  const body = await readBody(req, MAX_BODY_BYTES);
  if (body === null) {
    respond(res, 413, "application/json; charset=utf-8", JSON.stringify({ error: tooBig }), { connection: "close" });
    return;
  }

  const draft = draftFrom(body);
  if (draft === null) {
    refuse(400, 'Send { "draft": "your text" }.');
    return;
  }

  let payload: string;
  try {
    // The draft is not echoed: the page already has it, and a response that
    // repeats what it was sent is one more place for it to be.
    const { text: _text, ...result } = await options.scorer.score(draft);
    payload = JSON.stringify(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    refuse(500, scrubSecrets(`The draft could not be scored: ${message}`, options.secrets));
    return;
  }

  respond(res, 200, "application/json; charset=utf-8", scrubSecrets(payload, options.secrets));
}

/**
 * The body as text, or null once it passes the cap. Past the cap nothing more
 * is kept; the rest is let through unread so the sender gets an answer rather
 * than a reset, and the connection is cut if it just keeps coming.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolvePromise, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let over = false;

    req.on("data", (part: Buffer) => {
      size += part.length;
      if (over) {
        if (size > limit * DISCARD_FACTOR) req.destroy();
        return;
      }
      if (size > limit) {
        over = true;
        parts.length = 0;
        resolvePromise(null);
        return;
      }
      parts.push(part);
    });
    req.on("end", () => {
      if (!over) resolvePromise(Buffer.concat(parts).toString("utf8"));
    });
    req.on("error", (error) => {
      if (!over) reject(error);
    });
  });
}

/** How many caps' worth of an over-long body is read and dropped before the line is cut. */
const DISCARD_FACTOR = 8;

function discard(req: IncomingMessage): void {
  let size = 0;
  req.on("data", (part: Buffer) => {
    size += part.length;
    if (size > MAX_BODY_BYTES * DISCARD_FACTOR) req.destroy();
  });
  req.on("error", () => {});
}

function draftFrom(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("draft" in parsed)) return null;
  return typeof parsed.draft === "string" ? parsed.draft : null;
}

// --- what every response carries ---------------------------------------------

function pagePolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function respond(
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
  extra: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    // Anything that is not the page may do nothing at all.
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(res.req.method === "HEAD" ? undefined : body);
}
