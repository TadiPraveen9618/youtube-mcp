import { jest } from "@jest/globals";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerVideoTools } from "../../src/tools/videos.js";
import { createMockClient } from "../helpers/mock-client.js";

const VIDEO_LIST_RESPONSE = {
  data: {
    kind: "youtube#videoListResponse",
    pageInfo: { totalResults: 1, resultsPerPage: 10 },
    items: [
      {
        kind: "youtube#video",
        id: "dQw4w9WgXcQ",
        snippet: {
          publishedAt: "2009-10-25T06:57:33Z",
          channelId: "UCuAXFkgsw1L7xaCfnd5JJOw",
          title: "Rick Astley - Never Gonna Give You Up",
          description: "Official music video",
          channelTitle: "Rick Astley",
          categoryId: "10",
          thumbnails: {
            default: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg" },
          },
        },
        contentDetails: {
          duration: "PT3M33S",
          dimension: "2d",
          definition: "hd",
        },
        statistics: {
          viewCount: "1500000000",
          likeCount: "15000000",
          commentCount: "3000000",
        },
      },
    ],
  },
};

const VIDEO_INSERT_RESPONSE = {
  data: {
    kind: "youtube#video",
    id: "newVideoId123",
    snippet: {
      title: "My Upload",
      description: "A test upload",
    },
    status: {
      privacyStatus: "private",
      uploadStatus: "uploaded",
    },
  },
};

const RATING_RESPONSE = {
  data: {
    kind: "youtube#videoGetRatingResponse",
    items: [
      {
        videoId: "dQw4w9WgXcQ",
        rating: "like",
      },
    ],
  },
};

const EMPTY_RESPONSE = { data: {} };

describe("Video Tools Registration", () => {
  it("registers all 6 video tools", () => {
    const { client } = createMockClient(VIDEO_LIST_RESPONSE);
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerVideoTools(server, client);

    const registeredTools = (server as any)._registeredTools;
    expect(registeredTools.youtube_videos_list).toBeDefined();
    expect(registeredTools.youtube_videos_insert).toBeDefined();
    expect(registeredTools.youtube_videos_update).toBeDefined();
    expect(registeredTools.youtube_videos_delete).toBeDefined();
    expect(registeredTools.youtube_videos_rate).toBeDefined();
    expect(registeredTools.youtube_videos_get_rating).toBeDefined();
  });

  it("youtube_videos_list has quota cost 1 in description", () => {
    const { client } = createMockClient(VIDEO_LIST_RESPONSE);
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerVideoTools(server, client);

    const tool = (server as any)._registeredTools.youtube_videos_list;
    expect(tool.description).toContain("1 unit");
  });

  it("youtube_videos_insert has quota cost 1600 in description", () => {
    const { client } = createMockClient(VIDEO_INSERT_RESPONSE);
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerVideoTools(server, client);

    const tool = (server as any)._registeredTools.youtube_videos_insert;
    expect(tool.description).toContain("1600");
  });

  it("youtube_videos_update has quota cost 50 in description", () => {
    const { client } = createMockClient(VIDEO_LIST_RESPONSE);
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerVideoTools(server, client);

    const tool = (server as any)._registeredTools.youtube_videos_update;
    expect(tool.description).toContain("50");
  });

  it("youtube_videos_delete has quota cost 50 in description", () => {
    const { client } = createMockClient(VIDEO_LIST_RESPONSE);
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerVideoTools(server, client);

    const tool = (server as any)._registeredTools.youtube_videos_delete;
    expect(tool.description).toContain("50");
  });

  it("youtube_videos_rate has quota cost 50 in description", () => {
    const { client } = createMockClient(VIDEO_LIST_RESPONSE);
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerVideoTools(server, client);

    const tool = (server as any)._registeredTools.youtube_videos_rate;
    expect(tool.description).toContain("50");
  });

  it("youtube_videos_get_rating has quota cost 1 in description", () => {
    const { client } = createMockClient(RATING_RESPONSE);
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerVideoTools(server, client);

    const tool = (server as any)._registeredTools.youtube_videos_get_rating;
    expect(tool.description).toContain("1 unit");
  });

  it("youtube_videos_rate description mentions like/dislike", () => {
    const { client } = createMockClient(VIDEO_LIST_RESPONSE);
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerVideoTools(server, client);

    const tool = (server as any)._registeredTools.youtube_videos_rate;
    expect(tool.description).toMatch(/like|dislike|rate/i);
  });
});

describe("youtube_videos_update preserves existing fields", () => {
  it("merges with the current video so publishing does not wipe metadata or the kids flag", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { client: yt, executeMock } = createMockClient();
    const updateCalls: any[] = [];
    const api = {
      videos: {
        list: async () => ({
          data: {
            items: [
              {
                id: "v1",
                snippet: { title: "Old title", description: "Desc", tags: ["a"], categoryId: "1" },
                status: { privacyStatus: "private", selfDeclaredMadeForKids: true, license: "youtube", embeddable: true },
              },
            ],
          },
        }),
        update: async (p: any) => {
          updateCalls.push(p);
          return { data: p.requestBody };
        },
      },
    };
    executeMock.mockImplementation(async (fn: any) => fn(api));
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerVideoTools(server, yt);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);

    await client.callTool({ name: "youtube_videos_update", arguments: { id: "v1", privacyStatus: "public" } });

    const body = updateCalls[0].requestBody;
    expect(body.snippet).toMatchObject({ title: "Old title", description: "Desc", tags: ["a"], categoryId: "1" });
    expect(body.status).toMatchObject({ privacyStatus: "public", selfDeclaredMadeForKids: true });
  });
});
