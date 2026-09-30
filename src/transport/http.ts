import {
  createServer as createHttpServer,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { randomUUID, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { google } from "googleapis";
import { URL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { YouTubeAuth } from "../auth/oauth.js";
import { createServer } from "../server.js";

export interface HttpTransportOptions {
  port: number;
  host: string;
  auth: YouTubeAuth;
}

/** One-time OAuth `state` values issued by /authorize → expiry time. */
const pendingStates = new Map<string, number>();

function esc(v: string): string {
  return v.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );
}

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function sendHtml(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
  });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>` +
      `<body style="font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px">` +
      `<h1>${esc(title)}</h1>${body}</body></html>`,
  );
}

export async function startHttpTransport(
  options: HttpTransportOptions,
): Promise<void> {
  const transports = new Map<
    string,
    StreamableHTTPServerTransport
  >();

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    const body = Buffer.concat(chunks).toString("utf8");

    if (!body) {
      return undefined;
    }

    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  };

  const httpServer = createHttpServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(
          req.url || "/",
          `http://${req.headers.host || "localhost"}`,
        );

       
       
       
       if (url.pathname === "/") {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`
    <html>
      <head><title>Bhabbi World Claude</title></head>
      <body>
        <h1>Bhabbi World Claude</h1>
        <p>This application connects Claude with the Bhabbi World YouTube channel.</p>
        <p>Powered by the YouTube Data API.</p>
      </body>
    </html>
  `);
  return;
}

if (url.pathname === "/privacy") {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`
    <html>
      <head><title>Privacy Policy - Bhabbi World Claude</title></head>
      <body>
        <h1>Privacy Policy</h1>
        <p>Bhabbi World Claude uses Google OAuth and the YouTube Data API to manage the authorized Bhabbi World YouTube channel.</p>
        <p>The application only accesses YouTube data that the account owner has authorized.</p>
        <p>We do not sell or share personal information with third parties.</p>
        <p>OAuth credentials are used only to provide the requested YouTube management functionality.</p>
        <p>For questions, contact the application owner through the Google account associated with this application.</p>
      </body>
    </html>
  `);
  return;
} if (url.pathname === "/health") {
          res.writeHead(200, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }

        if (url.pathname === "/authorize") {
          // Protected by SETUP_KEY so a stranger cannot connect their own
          // Google account to this server.
          const setupKey = process.env.SETUP_KEY;
          if (!setupKey) {
            sendHtml(res, 403, "Authorization disabled",
              "<p>Set a <code>SETUP_KEY</code> environment variable on Render, redeploy, then open " +
              "<code>/authorize?key=&lt;your SETUP_KEY&gt;</code>.</p>");
            return;
          }
          if (!safeEqual(url.searchParams.get("key") ?? "", setupKey)) {
            sendHtml(res, 403, "Wrong or missing key",
              "<p>Open <code>/authorize?key=&lt;your SETUP_KEY&gt;</code>.</p>");
            return;
          }
          const state = randomBytes(24).toString("hex");
          pendingStates.set(state, Date.now() + 10 * 60 * 1000);
          res.writeHead(302, {
            Location: options.auth.getAuthUrl(undefined, state),
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }

        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");
          const state = url.searchParams.get("state") ?? "";
          const expires = pendingStates.get(state);
          pendingStates.delete(state);

          if (error) {
            sendHtml(res, 400, "Authorization failed", `<p>Google said: <code>${esc(error)}</code></p>`);
            return;
          }
          if (!expires || expires < Date.now()) {
            sendHtml(res, 400, "Authorization link expired",
              "<p>Start again from <code>/authorize?key=&lt;your SETUP_KEY&gt;</code>.</p>");
            return;
          }
          if (!code) {
            sendHtml(res, 400, "Missing authorization code", "");
            return;
          }

          try {
            const tokens = await options.auth.exchangeCode(code);
            if (!tokens.refresh_token) {
              sendHtml(res, 400, "No refresh token returned",
                "<p>Google did not return a refresh token. Remove this app's access at " +
                "<a href=\"https://myaccount.google.com/permissions\">myaccount.google.com/permissions</a> " +
                "and run <code>/authorize</code> again.</p>");
              return;
            }

            // Prove the token works and show which channel it controls.
            let channelHtml = "<p>⚠️ Could not read the channel.</p>";
            try {
              const client = await options.auth.getClient();
              const yt = google.youtube({ version: "v3", auth: client });
              const ch = await yt.channels.list({ part: ["snippet"], mine: true });
              const c = ch.data.items?.[0];
              channelHtml = c
                ? `<p>✅ Connected to channel <b>${esc(c.snippet?.title ?? "")}</b> (<code>${esc(c.id ?? "")}</code>).</p>`
                : "<p>⚠️ This Google account has no YouTube channel. If Bhabbi World is a brand account, run /authorize again and pick the channel in the account chooser.</p>";
            } catch (e) {
              channelHtml = `<p>⚠️ Channel check failed: ${esc(e instanceof Error ? e.message : String(e))}</p>`;
            }

            sendHtml(res, 200, "YouTube authorization successful",
              channelHtml +
              "<p>The server is using this login right now. To keep it after restarts/redeploys, " +
              "copy the value below into Render → <b>Environment</b> → <code>GOOGLE_REFRESH_TOKEN</code> → Save.</p>" +
              `<textarea readonly rows="3" style="width:100%;font-family:monospace" onclick="this.select()">${esc(tokens.refresh_token)}</textarea>` +
              "<p>Do not share this value. It was minted for this server's own OAuth client, so Render can use it.</p>" +
              "<p>You can close this window and return to Claude.</p>");
          } catch (err) {
            const data = (err as { response?: { data?: { error?: string; error_description?: string } } })?.response?.data;
            const codeName = data?.error ?? (err instanceof Error ? err.message : "unknown_error");
            console.error(`OAuth callback error: ${codeName}`);
            const hint =
              codeName === "invalid_client"
                ? "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on Render do not match an existing OAuth client. Copy both again from the same client in Google Cloud Console."
                : codeName === "redirect_uri_mismatch"
                  ? "GOOGLE_REDIRECT_URI on Render must exactly match an Authorized redirect URI on the OAuth client."
                  : "Try /authorize again.";
            sendHtml(res, 500, "Authorization failed", `<p>Google error: <code>${esc(codeName)}</code></p><p>${esc(hint)}</p>`);
          }
          return;
        }

        if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
          const sessionId = req.headers[
            "mcp-session-id"
          ] as string | undefined;

          if (sessionId && transports.has(sessionId)) {
            const transport = transports.get(sessionId)!;
            await transport.handleRequest(req, res);
            return;
          }

          if (!sessionId && req.method === "POST") {
            const body = await readBody(req);

            if (isInitializeRequest(body)) {
              let transport:
                | StreamableHTTPServerTransport
                | undefined;

              transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),

                onsessioninitialized: (newSessionId) => {
                  transports.set(newSessionId, transport!);
                  console.error(
                    `MCP session initialized: ${newSessionId}`,
                  );
                },
              });

              transport.onclose = () => {
                if (transport?.sessionId) {
                  transports.delete(transport.sessionId);
                  console.error(
                    `MCP session closed: ${transport.sessionId}`,
                  );
                }
              };

              const server: McpServer = createServer(
                options.auth,
              );

              await server.connect(transport);

              await transport.handleRequest(
                req,
                res,
                body,
              );

              return;
            }
          }

          // A session ID we don't know means the server restarted (Render
          // sleep/redeploy) and the in-memory session is gone. The MCP spec
          // requires 404 here: that is the signal for the client to start a
          // new session with a fresh `initialize`. Answering 400 instead left
          // Claude stuck on a dead session.
          if (sessionId) {
            console.error(`Unknown MCP session ${sessionId} (${req.method}); asking client to re-initialize`);
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32001,
                  message: "Session not found. Send a new initialize request.",
                },
                id: null,
              }),
            );
            return;
          }

          res.writeHead(400, {
            "Content-Type": "application/json",
          });

          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message:
                  "Bad Request: No valid MCP session found",
              },
              id: null,
            }),
          );

          return;
        }

        res.writeHead(404);
        res.end("Not found");
      } catch (error) {
        console.error("HTTP server error:", error);

        if (!res.headersSent) {
          res.writeHead(500, {
            "Content-Type": "application/json",
          });

          res.end(
            JSON.stringify({
              error: "Internal server error",
            }),
          );
        }
      }
    },
  );

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(
      options.port,
      options.host,
      () => {
        console.error(
          `YouTube MCP server running on http://${options.host}:${options.port}/mcp`,
        );
        resolve();
      },
    );

    httpServer.on("error", reject);
  });
}
