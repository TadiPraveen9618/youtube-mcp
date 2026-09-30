import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { createAuthFromEnv } from "./auth/oauth.js";
import { startHttpTransport } from "./transport/http.js";

function parseArgs(): { transport: "stdio" | "http"; port: number; host: string } {
  const args = process.argv.slice(2);
  let transport: "stdio" | "http" = "stdio";
  let port = 3000;
  let host = "0.0.0.0";
  let portFromCli = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--transport" && args[i + 1]) {
      const val = args[i + 1];
      if (val === "stdio" || val === "http") {
        transport = val;
      }
      i++;
    } else if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      portFromCli = true;
      i++;
    } else if (args[i] === "--host" && args[i + 1]) {
      host = args[i + 1];
      i++;
    }
  }

  // Environment variables as fallback
  transport = (process.env.TRANSPORT as "stdio" | "http") || transport;
  // Port precedence: --port flag > PORT (set automatically by Render/Heroku)
  // > HTTP_PORT > 3000.
  if (!portFromCli) {
    const envPort = process.env.PORT || process.env.HTTP_PORT;
    if (envPort) port = parseInt(envPort, 10);
  }
  host = process.env.HTTP_HOST || host;

  return { transport, port, host };
}

async function main() {
  const config = parseArgs();
const auth = createAuthFromEnv();


  if (config.transport === "http") {
    await startHttpTransport({
  port: config.port,
  host: config.host,
  auth,
});
  } else {
    const server = createServer(auth);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("YouTube MCP server running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
