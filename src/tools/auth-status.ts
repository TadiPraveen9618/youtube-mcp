import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { YouTubeAuth } from "../auth/oauth.js";
import { YouTubeClient } from "../client/youtube.js";

/**
 * Diagnostics tool: shows non-secret OAuth configuration and whether the
 * server can currently act on a YouTube channel. Never returns secrets.
 */
export function registerAuthStatusTool(
  server: McpServer,
  auth: YouTubeAuth,
  client: YouTubeClient,
): void {
  server.tool(
    "youtube_auth_status",
    "Check whether this server can authenticate to YouTube, which channel it controls, and which OAuth " +
      "client / redirect URI it is configured with (no secrets are returned). Run this before uploading. Quota: 1 unit.",
    {},
    async () => {
      const info: Record<string, unknown> = {
        ...auth.describe(),
        clientSecretConfigured: Boolean(process.env.GOOGLE_CLIENT_SECRET),
        setupKeyConfigured: Boolean(process.env.SETUP_KEY),
        uploadToolAvailable: true,
      };
      try {
        const res = await client.execute((api) =>
          api.channels.list({ part: ["snippet", "status"], mine: true }),
        );
        const ch = res.data.items?.[0];
        info.authenticated = true;
        info.channel = ch
          ? { id: ch.id, title: ch.snippet?.title, madeForKidsDefault: ch.status?.madeForKids }
          : null;
        if (!ch) info.note = "Authenticated, but this Google account has no YouTube channel (pick the brand-account channel during /authorize).";
      } catch (err) {
        info.authenticated = false;
        info.error = err instanceof Error ? err.message : String(err);
        info.fix =
          "Open https://<your-render-host>/authorize?key=<SETUP_KEY> in a browser, sign in, choose the channel, " +
          "then copy the shown refresh token into Render's GOOGLE_REFRESH_TOKEN.";
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
    },
  );
}
