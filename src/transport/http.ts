import {
  createServer as createHttpServer,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { YouTubeAuth } from "../auth/oauth.js";

export interface HttpTransportOptions {
  port: number;
  host: string;
  auth: YouTubeAuth;
}

/**
 * Start the MCP server with Streamable HTTP transport.
 */
export async function startHttpTransport(
  server: McpServer,
  options: HttpTransportOptions,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const httpServer = createHttpServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`,
      );

      // Health check
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      // Start Google OAuth authorization
      if (url.pathname === "/authorize") {
        const authUrl = options.auth.getAuthUrl();

        res.writeHead(302, {
          Location: authUrl,
        });
        res.end();
        return;
      }

      // Google OAuth callback
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            `<h1>Authorization failed</h1><p>${error}</p>`,
          );
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Missing authorization code</h1>");
          return;
        }

        try {
          await options.auth.exchangeCode(code);

          res.writeHead(200, { "Content-Type": "text/html" });
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

          res.writeHead(500, { "Content-Type": "text/html" });
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

      // MCP endpoint
      if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
        await transport.handleRequest(req, res);
        return;
      }

      // Unknown route
      res.writeHead(404);
      res.end("Not found");
    },
  );

  await server.connect(transport);

  return new Promise((resolve, reject) => {
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
