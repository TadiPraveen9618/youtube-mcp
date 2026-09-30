import { createServer as createNetServer } from "node:net";
import { YouTubeAuth } from "../../src/auth/oauth.js";
import { startHttpTransport } from "../../src/transport/http.js";

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

/** Parse a JSON or single-event SSE response body. */
async function rpcBody(res: Response): Promise<any> {
  const text = await res.text();
  const data = text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .join("");
  return JSON.parse(data || text);
}

describe("HTTP transport (Streamable HTTP)", () => {
  let base: string;

  beforeAll(async () => {
    const port = await freePort();
    const auth = new YouTubeAuth({
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUri: "http://localhost/callback",
      tokenStoragePath: "./.tokens-test",
    });
    await startHttpTransport({ port, host: "127.0.0.1", auth });
    base = `http://127.0.0.1:${port}`;
  });

  it("serves /health", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("initializes a session and advertises every YouTube tool", async () => {
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();
    expect((await rpcBody(init)).result.capabilities.tools).toBeDefined();

    const session = { ...HEADERS, "mcp-session-id": sid!, "mcp-protocol-version": "2025-06-18" };
    const ack = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: session,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(ack.status).toBe(202);

    const list = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: session,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const body = await rpcBody(list);
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(body.result.nextCursor).toBeUndefined();
    expect(names.length).toBeGreaterThanOrEqual(51);
    for (const n of [
      "youtube_channels_list",
      "youtube_videos_list",
      "youtube_playlists_list",
      "youtube_upload_video_from_url",
      "youtube_upload_status",
      "youtube_auth_status",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("answers 404 for an unknown session so the client re-initializes", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...HEADERS, "mcp-session-id": "stale-session-from-before-restart" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
  });

  it("answers 400 for a non-initialize request without a session", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
  });
});
