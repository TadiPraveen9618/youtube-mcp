import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { YouTubeClient } from "./client/youtube.js";
import { YouTubeAuth } from "./auth/oauth.js";
import { registerPlaylistTools } from "./tools/playlists.js";
import { registerPlaylistItemsTools } from "./tools/playlist-items.js";
import { registerSearchTools } from "./tools/search.js";
import { registerVideoTools } from "./tools/videos.js";
import { registerChannelTools } from "./tools/channels.js";
import { registerSubscriptionTools } from "./tools/subscriptions.js";
import { registerCommentThreadTools } from "./tools/comment-threads.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerCaptionTools } from "./tools/captions.js";
import { registerChannelSectionTools } from "./tools/channel-sections.js";
import { registerChannelBannerTools } from "./tools/channel-banners.js";
import { registerThumbnailTools } from "./tools/thumbnails.js";
import { registerWatermarkTools } from "./tools/watermarks.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerMemberTools } from "./tools/members.js";
import { registerI18nTools } from "./tools/i18n.js";
import { registerVideoCategoryTools } from "./tools/video-categories.js";
import { registerVideoAbuseTools } from "./tools/video-abuse.js";
import { registerUploadFromUrlTools } from "./tools/upload-from-url.js";
import { registerAuthStatusTool } from "./tools/auth-status.js";

/**
 * Register all YouTube tools on an MCP server with the given client.
 */
function registerAllTools(server: McpServer, client: YouTubeClient): void {
  registerPlaylistTools(server, client);
  registerPlaylistItemsTools(server, client);
  registerSearchTools(server, client);
  registerVideoTools(server, client);
  registerChannelTools(server, client);
  registerSubscriptionTools(server, client);
  registerCommentThreadTools(server, client);
  registerCommentTools(server, client);
  registerCaptionTools(server, client);
  registerChannelSectionTools(server, client);
  registerChannelBannerTools(server, client);
  registerThumbnailTools(server, client);
  registerWatermarkTools(server, client);
  registerActivityTools(server, client);
  registerMemberTools(server, client);
  registerI18nTools(server, client);
  registerVideoCategoryTools(server, client);
  registerVideoAbuseTools(server, client);
  registerUploadFromUrlTools(server, client);
}

/**
 * Create and configure the MCP server with all YouTube tools.
 */
export function createServer(auth?: YouTubeAuth): McpServer {
  const server = new McpServer({
    name: "youtube-mcp",
    version: "1.0.0",
  });

  if (auth) {
    const client = new YouTubeClient(auth);
    registerAllTools(server, client);
    registerAuthStatusTool(server, auth, client);
  }

  return server;
}

/**
 * Create an MCP server with a raw OAuth access token.
 * Used by multi-tenant wrappers (e.g. youtube-mcp-server) where
 * the platform provides per-user tokens.
 */
export function createServerWithToken(accessToken: string): McpServer {
  const server = new McpServer({
    name: "youtube-mcp",
    version: "1.0.0",
  });

  const client = new YouTubeClient(accessToken);
  registerAllTools(server, client);

  return server;
}
