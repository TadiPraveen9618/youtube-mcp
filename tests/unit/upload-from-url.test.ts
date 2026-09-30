import { jest } from "@jest/globals";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DownloadPolicy,
  downloadToFile,
  isPrivateAddress,
  makeTempDir,
  normalizeShareUrl,
  removeTempDir,
  validateUrl,
} from "../../src/utils/safe-download.js";
import {
  _resetJobsForTests,
  parseTags,
  registerUploadFromUrlTools,
  youtubeTagLength,
} from "../../src/tools/upload-from-url.js";
import { createMockClient } from "../helpers/mock-client.js";

const PROD: DownloadPolicy = {
  maxBytes: 10 * 1024 * 1024,
  idleTimeoutMs: 5000,
  totalTimeoutMs: 10000,
  maxRedirects: 5,
};
// Tests talk to a local server, so they explicitly opt in to http + loopback.
const LOCAL: DownloadPolicy = { ...PROD, allowHttp: true, allowPrivateAddresses: true };

// A tiny fake MP4: 'ftyp' box at offset 4, then padding.
const FAKE_MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypisom"),
  Buffer.alloc(4096, 1),
]);
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(256, 2),
]);

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case "/video.mp4":
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": FAKE_MP4.length });
        res.end(FAKE_MP4);
        return;
      case "/redirect":
        res.writeHead(302, { Location: "/video.mp4" });
        res.end();
        return;
      case "/redirect-to-metadata":
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
        res.end();
        return;
      case "/big-declared":
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": 50 * 1024 * 1024 });
        res.end();
        return;
      case "/big-chunked": {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        let sent = 0;
        const chunk = Buffer.alloc(1024 * 1024, 1);
        const push = () => {
          while (sent < 20) {
            sent++;
            if (!res.write(chunk)) return res.once("drain", push);
          }
          res.end();
        };
        push();
        return;
      }
      case "/page.html":
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>Sign in</html>");
        return;
      case "/not-a-video":
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(Buffer.from("just some bytes that are not a video"));
        return;
      case "/thumb.png":
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(FAKE_PNG);
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => _resetJobsForTests());

// ---------------------------------------------------------------------------

describe("URL validation", () => {
  it("accepts a normal https URL", () => {
    expect(validateUrl("https://example.com/v.mp4", PROD).hostname).toBe("example.com");
  });

  it.each([
    ["http://example.com/v.mp4", /https/],
    ["ftp://example.com/v.mp4", /https/],
    ["file:///etc/passwd", /https/],
    ["https://user:pass@example.com/v.mp4", /credentials/],
    ["https://localhost/v.mp4", /private/],
    ["https://127.0.0.1/v.mp4", /private/],
    ["https://10.1.2.3/v.mp4", /private/],
    ["https://169.254.169.254/latest/meta-data", /private/],
    ["https://[::1]/v.mp4", /private/],
    ["https://[::ffff:127.0.0.1]/v.mp4", /private/],
    ["not a url", /Invalid/],
  ])("rejects %s", (url, msg) => {
    expect(() => validateUrl(url, PROD)).toThrow(msg);
  });

  it("enforces the host allowlist with suffix matching", () => {
    const p = { ...PROD, allowedHosts: ["googleusercontent.com", "drive.google.com"] };
    expect(() => validateUrl("https://drive.google.com/x", p)).not.toThrow();
    expect(() => validateUrl("https://doc-0s.drive.googleusercontent.com/x", p)).not.toThrow();
    expect(() => validateUrl("https://evil.com/x", p)).toThrow(/UPLOAD_ALLOWED_HOSTS/);
    expect(() => validateUrl("https://notgoogleusercontent.com/x", p)).toThrow();
  });

  it("classifies addresses", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("142.250.183.46")).toBe(false);
    expect(isPrivateAddress("2607:f8b0:4004:800::200e")).toBe(false);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("172.20.0.1")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
  });
});

describe("share link normalisation", () => {
  it("converts Google Drive share links to direct downloads", () => {
    const direct =
      "https://drive.usercontent.google.com/download?id=1AbC_dEf-123&export=download&confirm=t";
    expect(normalizeShareUrl("https://drive.google.com/file/d/1AbC_dEf-123/view?usp=sharing")).toBe(direct);
    expect(normalizeShareUrl("https://drive.google.com/open?id=1AbC_dEf-123")).toBe(direct);
    expect(normalizeShareUrl("https://drive.google.com/uc?id=1AbC_dEf-123&export=download")).toBe(direct);
  });

  it("forces Dropbox links to download", () => {
    expect(normalizeShareUrl("https://www.dropbox.com/scl/fi/abc/video.mp4?rlkey=xyz&dl=0")).toBe(
      "https://www.dropbox.com/scl/fi/abc/video.mp4?rlkey=xyz&dl=1",
    );
  });

  it("leaves other URLs alone", () => {
    expect(normalizeShareUrl("https://cdn.example.com/a.mp4?sig=1")).toBe("https://cdn.example.com/a.mp4?sig=1");
  });
});

describe("downloadToFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir("yt-test-");
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("downloads a file with 0600 permissions", async () => {
    const r = await downloadToFile(`${base}/video.mp4`, dir, "v.bin", LOCAL);
    expect(r.bytes).toBe(FAKE_MP4.length);
    expect(fs.readFileSync(r.filePath).equals(FAKE_MP4)).toBe(true);
    expect(fs.statSync(r.filePath).mode & 0o777).toBe(0o600);
  });

  it("follows redirects", async () => {
    const r = await downloadToFile(`${base}/redirect`, dir, "v.bin", LOCAL);
    expect(r.bytes).toBe(FAKE_MP4.length);
  });

  it("re-validates every redirect hop (redirect to cloud metadata is refused)", async () => {
    // The test server is on loopback, so allow it via the allowlist; the
    // redirect to 169.254.169.254 must then be rejected on the second hop.
    await expect(
      downloadToFile(`${base}/redirect-to-metadata`, dir, "v.bin", {
        ...LOCAL,
        allowedHosts: ["127.0.0.1"],
      }),
    ).rejects.toThrow(/UPLOAD_ALLOWED_HOSTS/);
  });

  it("refuses files whose Content-Length exceeds the cap", async () => {
    await expect(downloadToFile(`${base}/big-declared`, dir, "v.bin", LOCAL)).rejects.toThrow(/limit/);
  });

  it("aborts streams that exceed the cap without Content-Length", async () => {
    await expect(downloadToFile(`${base}/big-chunked`, dir, "v.bin", LOCAL)).rejects.toThrow(/limit/);
  });

  it("rejects HTML pages (e.g. Drive permission pages)", async () => {
    await expect(downloadToFile(`${base}/page.html`, dir, "v.bin", LOCAL)).rejects.toThrow(/web page/);
  });

  it("reports HTTP errors", async () => {
    await expect(downloadToFile(`${base}/missing`, dir, "v.bin", LOCAL)).rejects.toThrow(/HTTP 404/);
  });

  it("blocks loopback in production policy even over http", async () => {
    await expect(
      downloadToFile(`${base}/video.mp4`, dir, "v.bin", { ...PROD, allowHttp: true }),
    ).rejects.toThrow(/private/);
  });
});

describe("tag helpers", () => {
  it("parses comma-separated tags", () => {
    expect(parseTags(" a, b ,, c ")).toEqual(["a", "b", "c"]);
    expect(parseTags("")).toBeUndefined();
  });

  it("counts length the way YouTube does", () => {
    expect(youtubeTagLength(["ab", "c d"])).toBe(2 + 5 + 1);
  });

  it("Bhabbi World first-video tags fit within 500", () => {
    const tags = parseTags(
      "Bhabbi World, Bhabbi, lost baby bird story, baby bird finds mommy, kindness story for kids, moral stories for kids, kids animated story, stories for kids, bedtime stories for kids, helping others story, cartoon for kids, 3D animation for kids, kids cartoon forest adventure, short stories for kids in English, preschool stories, good habits for kids, animal stories for kids, mother and baby story",
    )!;
    expect(youtubeTagLength(tags)).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// Full tool flow through a real MCP client (schema defaults included)
// ---------------------------------------------------------------------------

async function connect(executeImpl: (fn: any) => Promise<any>) {
  const { client: ytClient, executeMock } = createMockClient();
  executeMock.mockImplementation(executeImpl);
  const mcp = new McpServer({ name: "test", version: "0.0.1" });
  registerUploadFromUrlTools(mcp, ytClient, { videoPolicy: LOCAL, thumbnailPolicy: LOCAL });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return { client, executeMock };
}

function fakeApi(calls: any[]) {
  return {
    videos: {
      insert: jest.fn(async (params: any, opts: any) => {
        // Consume the stream like the real client would.
        const chunks: Buffer[] = [];
        for await (const c of params.media.body) chunks.push(c as Buffer);
        opts?.onUploadProgress?.({ bytesRead: Buffer.concat(chunks).length });
        calls.push({ kind: "insert", params, bytes: Buffer.concat(chunks) });
        return {
          data: {
            id: "vid_TEST123",
            snippet: params.requestBody.snippet,
            status: { ...params.requestBody.status, uploadStatus: "uploaded" },
          },
        };
      }),
    },
    thumbnails: {
      set: jest.fn(async (params: any) => {
        const chunks: Buffer[] = [];
        for await (const c of params.media.body) chunks.push(c as Buffer);
        calls.push({ kind: "thumb", params });
        return { data: {} };
      }),
    },
  };
}

function parse(res: any) {
  return JSON.parse(res.content[0].text);
}

describe("youtube_upload_video_from_url tool", () => {
  it("is listed with defaults: category 1, private", async () => {
    const { client } = await connect(async () => ({}));
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "youtube_upload_video_from_url")!;
    expect(tool).toBeDefined();
    const props = (tool.inputSchema as any).properties;
    expect(props.categoryId.default).toBe("1");
    expect(props.privacyStatus.default).toBe("private");
    expect(props.selfDeclaredMadeForKids.type).toBe("boolean");
    expect(tools.find((t) => t.name === "youtube_upload_status")).toBeDefined();
  });

  it("downloads, uploads with correct metadata, sets thumbnail, and deletes temp files", async () => {
    const calls: any[] = [];
    const api = fakeApi(calls);
    const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("yt-upload-"));
    const { client } = await connect(async (fn: any) => fn(api));

    const res = await client.callTool({
      name: "youtube_upload_video_from_url",
      arguments: {
        videoUrl: `${base}/video.mp4`,
        title: "Bhabbi Helps a Lost Baby Bird Find Its Mommy! 🐦💙 Kindness Story for Kids",
        description: "Test description",
        tags: "Bhabbi World, Bhabbi, kids",
        selfDeclaredMadeForKids: true,
        thumbnailUrl: `${base}/thumb.png`,
        waitSeconds: 10,
      },
    });
    const job = parse(res);
    expect(job.state).toBe("completed");
    expect(job.videoId).toBe("vid_TEST123");
    expect(job.thumbnail.status).toBe("set");
    expect(job.tempFilesDeleted).toBe(true);
    expect(job.studioUrl).toBe("https://studio.youtube.com/video/vid_TEST123/edit");
    // The job never stores the source URL (could contain secrets).
    expect(JSON.stringify(job)).not.toContain("/video.mp4");

    const insert = calls.find((c) => c.kind === "insert");
    expect(insert.params.requestBody.snippet.categoryId).toBe("1");
    expect(insert.params.requestBody.snippet.tags).toEqual(["Bhabbi World", "Bhabbi", "kids"]);
    expect(insert.params.requestBody.status).toEqual({
      privacyStatus: "private",
      selfDeclaredMadeForKids: true,
    });
    expect(insert.bytes.equals(FAKE_MP4)).toBe(true);
    expect(calls.find((c) => c.kind === "thumb").params.media.mimeType).toBe("image/png");

    const tmpAfter = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("yt-upload-"));
    expect(tmpAfter.sort()).toEqual(tmpBefore.sort());
  });

  it("fails cleanly (and never calls YouTube) when the file is not a video", async () => {
    const calls: any[] = [];
    const { client, executeMock } = await connect(async (fn: any) => fn(fakeApi(calls)));
    const job = parse(
      await client.callTool({
        name: "youtube_upload_video_from_url",
        arguments: { videoUrl: `${base}/not-a-video`, title: "x", waitSeconds: 10 },
      }),
    );
    expect(job.state).toBe("failed");
    expect(job.error).toMatch(/does not look like a video/);
    expect(job.tempFilesDeleted).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("returns a jobId immediately when waitSeconds is 0, and status can be polled", async () => {
    const calls: any[] = [];
    const { client } = await connect(async (fn: any) => fn(fakeApi(calls)));
    const first = parse(
      await client.callTool({
        name: "youtube_upload_video_from_url",
        arguments: { videoUrl: `${base}/video.mp4`, title: "x", waitSeconds: 0 },
      }),
    );
    expect(first.jobId).toBeDefined();
    let status: any;
    for (let i = 0; i < 50; i++) {
      status = parse(await client.callTool({ name: "youtube_upload_status", arguments: { jobId: first.jobId } }));
      if (status.state === "completed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status.state).toBe("completed");
    expect(status.videoId).toBe("vid_TEST123");
  });

  it("rejects invalid metadata before downloading anything", async () => {
    const { client, executeMock } = await connect(async () => ({}));
    const res: any = await client.callTool({
      name: "youtube_upload_video_from_url",
      arguments: { videoUrl: `${base}/video.mp4`, title: "bad <title>" },
    });
    expect(res.isError).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
