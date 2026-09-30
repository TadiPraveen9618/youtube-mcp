import {
  createServer as createHttpServer,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
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
          const authUrl = options.auth.getAuthUrl();

          res.writeHead(302, {
            Location: authUrl,
          });
          res.end();
          return;
        }

        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");

          if (error) {
            res.writeHead(400, {
              "Content-Type": "text/html",
            });
            res.end(
              `<h1>Authorization failed</h1><p>${error}</p>`,
            );
            return;
          }

          if (!code) {
            res.writeHead(400, {
              "Content-Type": "text/html",
            });
            res.end("<h1>Missing authorization code</h1>");
            return;
          }

          try {
            await options.auth.exchangeCode(code);

            res.writeHead(200, {
              "Content-Type": "text/html",
            });

            res.end(`
              <html>
                <body>
                  <h1>YouTube authorization successful!</h1>
                  <p>You can close this window and return to Claude.</p>
                </body>
              </html>
            `);
          } catch (error) {
            console.error("OAuth callback error:", error);

            res.writeHead(500, {
              "Content-Type": "text/html",
            });

            res.end(`
              <html>
                <body>
                  <h1>Authorization failed</h1>
                  <p>Please check the Render logs for details.</p>
                </body>
              </html>
            `);
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
