import { YouTubeAuth, YOUTUBE_SCOPES, ALL_SCOPES } from "../../src/auth/oauth.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("YouTubeAuth", () => {
  let auth: YouTubeAuth;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-mcp-test-"));
    auth = new YouTubeAuth({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      redirectUri: "http://localhost:3000/callback",
      tokenStoragePath: tmpDir,
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("creates an auth instance with config", () => {
      expect(auth).toBeDefined();
    });
  });

  describe("getAuthUrl", () => {
    it("generates an authorization URL with all scopes", () => {
      const url = auth.getAuthUrl();
      expect(url).toContain("accounts.google.com");
      expect(url).toContain("access_type=offline");
      for (const scope of ALL_SCOPES) {
        expect(url).toContain(encodeURIComponent(scope));
      }
    });

    it("generates URL with specific scopes", () => {
      const url = auth.getAuthUrl([YOUTUBE_SCOPES.readonly]);
      expect(url).toContain(encodeURIComponent(YOUTUBE_SCOPES.readonly));
    });
  });

  describe("hasStoredCredentials", () => {
    it("returns false when no tokens stored", async () => {
      const result = await auth.hasStoredCredentials();
      expect(result).toBe(false);
    });

    it("returns true when tokens exist", async () => {
      const tokenPath = path.join(tmpDir, "tokens.json");
      await fs.writeFile(tokenPath, JSON.stringify({ access_token: "test" }));
      const result = await auth.hasStoredCredentials();
      expect(result).toBe(true);
    });
  });

  describe("getClient", () => {
    it("throws when no stored credentials", async () => {
      await expect(auth.getClient()).rejects.toThrow("No stored credentials found");
    });

    it("returns client when valid tokens exist", async () => {
      const tokenPath = path.join(tmpDir, "tokens.json");
      const tokens = {
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        expiry_date: Date.now() + 3600 * 1000, // 1 hour from now
      };
      await fs.writeFile(tokenPath, JSON.stringify(tokens));

      const client = await auth.getClient();
      expect(client).toBeDefined();
    });
  });

  describe("token sources and refresh errors", () => {
    const saved = process.env.GOOGLE_REFRESH_TOKEN;
    afterEach(() => {
      if (saved === undefined) delete process.env.GOOGLE_REFRESH_TOKEN;
      else process.env.GOOGLE_REFRESH_TOKEN = saved;
    });

    it("uses GOOGLE_REFRESH_TOKEN over the token file (so /authorize can't swap accounts)", async () => {
      process.env.GOOGLE_REFRESH_TOKEN = "env-refresh";
      await fs.writeFile(
        path.join(tmpDir, "tokens.json"),
        JSON.stringify({ access_token: "a", refresh_token: "attacker-refresh", expiry_date: Date.now() + 3600e3 }),
      );
      const oauth = (auth as any).oauth2Client;
      oauth.refreshAccessToken = async () => ({ credentials: { access_token: "x", refresh_token: "env-refresh", expiry_date: Date.now() + 3600e3 } });
      const client = await auth.getClient();
      expect(client.credentials.refresh_token).toBe("env-refresh");
    });

    it("keeps the refresh token when a refresh response omits it", async () => {
      await fs.writeFile(path.join(tmpDir, "tokens.json"), JSON.stringify({ refresh_token: "keep-me" }));
      await (auth as any).saveTokens({ access_token: "new", expiry_date: 1 });
      const stored = JSON.parse(await fs.readFile(path.join(tmpDir, "tokens.json"), "utf-8"));
      expect(stored).toMatchObject({ access_token: "new", refresh_token: "keep-me" });
    });

    it("reports Google's error code with a hint, without leaking the token", async () => {
      process.env.GOOGLE_REFRESH_TOKEN = "super-secret-refresh";
      const oauth = (auth as any).oauth2Client;
      oauth.refreshAccessToken = async () => {
        const e: any = new Error("invalid_grant");
        e.response = { data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
        throw e;
      };
      const err: Error = await auth.getClient().then(() => { throw new Error("should fail"); }, (e) => e);
      expect(err.message).toMatch(/invalid_grant/);
      expect(err.message).toMatch(/Testing/);
      expect(err.message).not.toContain("super-secret-refresh");
    });
  });

  describe("YOUTUBE_SCOPES", () => {
    it("has all required scope categories", () => {
      expect(YOUTUBE_SCOPES.readonly).toContain("youtube.readonly");
      expect(YOUTUBE_SCOPES.manage).toContain("/youtube");
      expect(YOUTUBE_SCOPES.upload).toContain("youtube.upload");
      expect(YOUTUBE_SCOPES.forceSsl).toContain("youtube.force-ssl");
    });
  });
});
