import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createReadStream } from "fs";
import { YouTubeClient } from "../client/youtube.js";

/**
 * Register all Video MCP tools on the server.
 */
export function registerVideoTools(
  server: McpServer,
  client: YouTubeClient,
): void {
  server.tool(
    "youtube_videos_list",
    "List YouTube videos by ID, chart, or user rating. Quota: 1 unit.",
    {
      part: z
        .string()
        .default("snippet,contentDetails,statistics")
        .describe(
          "Comma-separated parts: snippet, contentDetails, statistics, status, id, player, topicDetails, recordingDetails, liveStreamingDetails",
        ),
      id: z.string().optional().describe("Comma-separated video IDs"),
      chart: z
        .enum(["mostPopular"])
        .optional()
        .describe("Chart to retrieve (mostPopular)"),
      myRating: z
        .enum(["like", "dislike"])
        .optional()
        .describe("Filter by authenticated user's rating"),
      maxResults: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max results (1-50)"),
      pageToken: z.string().optional().describe("Pagination token"),
      regionCode: z
        .string()
        .optional()
        .describe("ISO 3166-1 alpha-2 region code"),
      videoCategoryId: z
        .string()
        .optional()
        .describe("Video category ID (with chart)"),
    },
    async (args) => {
      const result = await client.execute((api) =>
        api.videos.list({
          part: [args.part],
          id: args.id ? args.id.split(",") : undefined,
          chart: args.chart,
          myRating: args.myRating,
          maxResults: args.maxResults,
          pageToken: args.pageToken,
          regionCode: args.regionCode,
          videoCategoryId: args.videoCategoryId,
        }),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "youtube_videos_insert",
    "Upload a video from a file path ON THE SERVER's disk. For files on the user's own computer, use youtube_upload_video_from_url instead. Quota: 1600 units.",
    {
      title: z.string().describe("Video title"),
      description: z.string().optional().describe("Video description"),
      tags: z
        .string()
        .optional()
        .describe("Comma-separated tags"),
      categoryId: z
        .string()
        .default("22")
        .describe("Video category ID (default: 22 = People & Blogs)"),
      privacyStatus: z
        .enum(["public", "private", "unlisted"])
        .default("private")
        .describe("Privacy status"),
      filePath: z.string().describe("Absolute path to the video file"),
    },
    async (args) => {
      const fileStream = createReadStream(args.filePath);

      const result = await client.execute((api) =>
        api.videos.insert({
          part: ["snippet", "status"],
          requestBody: {
            snippet: {
              title: args.title,
              description: args.description,
              tags: args.tags ? args.tags.split(",").map((t) => t.trim()) : undefined,
              categoryId: args.categoryId,
            },
            status: {
              privacyStatus: args.privacyStatus,
            },
          },
          media: {
            body: fileStream,
          },
        }),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "youtube_videos_update",
    "Update a YouTube video's metadata (title, description, tags, category, privacy, made-for-kids). " +
      "Only the fields you pass are changed; everything else is preserved (the current video is read first). " +
      "Quota: 51 units (1 read + 50 update).",
    {
      id: z.string().describe("Video ID to update"),
      title: z.string().optional().describe("New video title"),
      description: z.string().optional().describe("New video description"),
      tags: z
        .string()
        .optional()
        .describe("Comma-separated tags"),
      categoryId: z.string().optional().describe("New video category ID"),
      privacyStatus: z
        .enum(["public", "private", "unlisted"])
        .optional()
        .describe("New privacy status"),
      selfDeclaredMadeForKids: z
        .boolean()
        .optional()
        .describe("Set the video's made-for-kids (COPPA) declaration"),
    },
    async (args) => {
      // videos.update replaces whole parts: any snippet/status field we omit is
      // reset. Read the current values and merge so nothing is lost.
      const current = await client.execute((api) =>
        api.videos.list({ part: ["snippet", "status"], id: [args.id] }),
      );
      const video = current.data.items?.[0];
      if (!video) {
        throw new Error(`Video ${args.id} not found on this channel.`);
      }
      const snip = video.snippet ?? {};
      const stat = video.status ?? {};
      const privacyStatus = args.privacyStatus ?? stat.privacyStatus;

      const snippet = {
        title: args.title ?? snip.title ?? "",
        description: args.description ?? snip.description ?? "",
        tags:
          args.tags !== undefined
            ? args.tags.split(",").map((t) => t.trim()).filter(Boolean)
            : snip.tags,
        categoryId: args.categoryId ?? snip.categoryId,
        defaultLanguage: snip.defaultLanguage,
      };
      const status = {
        privacyStatus,
        embeddable: stat.embeddable,
        license: stat.license,
        publicStatsViewable: stat.publicStatsViewable,
        selfDeclaredMadeForKids:
          args.selfDeclaredMadeForKids ?? stat.selfDeclaredMadeForKids ?? stat.madeForKids,
        // A scheduled publish time is only valid while the video is private.
        ...(stat.publishAt && privacyStatus === "private" ? { publishAt: stat.publishAt } : {}),
      };

      const result = await client.execute((api) =>
        api.videos.update({
          part: ["snippet", "status"],
          requestBody: { id: args.id, snippet, status },
        }),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "youtube_videos_delete",
    "Delete a YouTube video. Quota: 50 units.",
    {
      id: z.string().describe("Video ID to delete"),
    },
    async (args) => {
      await client.execute((api) =>
        api.videos.delete({
          id: args.id,
        }),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Video ${args.id} deleted successfully.`,
          },
        ],
      };
    },
  );

  server.tool(
    "youtube_videos_rate",
    "Rate a YouTube video (like, dislike, or remove rating). Quota: 50 units.",
    {
      id: z.string().describe("Video ID to rate"),
      rating: z
        .enum(["like", "dislike", "none"])
        .describe("Rating to apply (none removes existing rating)"),
    },
    async (args) => {
      await client.execute((api) =>
        api.videos.rate({
          id: args.id,
          rating: args.rating,
        }),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Video ${args.id} rated as '${args.rating}' successfully.`,
          },
        ],
      };
    },
  );

  server.tool(
    "youtube_videos_get_rating",
    "Get the authenticated user's rating for one or more videos. Quota: 1 unit.",
    {
      id: z
        .string()
        .describe("Comma-separated video IDs to check ratings for"),
    },
    async (args) => {
      const result = await client.execute((api) =>
        api.videos.getRating({
          id: args.id.split(","),
        }),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    },
  );
}
