import { google } from "googleapis";
import { OAuth2Client, Credentials } from "google-auth-library";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * YouTube API OAuth scopes mapped by operation category.
 */
export const YOUTUBE_SCOPES = {
  readonly: "https://www.googleapis.com/auth/youtube.readonly",
  manage: "https://www.googleapis.com/auth/youtube",
  upload: "https://www.googleapis.com/auth/youtube.upload",
  forceSsl: "https://www.googleapis.com/auth/youtube.force-ssl",
} as const;

/** All scopes needed for full YouTube API access. */
export const ALL_SCOPES = Object.values(YOUTUBE_SCOPES);

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenStoragePath: string;
}

/**
 * Manages Google OAuth 2.0 authentication for the YouTube Data API.
 *
 * Handles token storage, refresh, and provides an authenticated OAuth2Client.
 */
export class YouTubeAuth {
  private oauth2Client: OAuth2Client;
  private tokenPath: string;

  constructor(private config: OAuthConfig) {
    this.oauth2Client = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
      config.redirectUri,
    );
    this.tokenPath = path.resolve(config.tokenStoragePath, "tokens.json");

    // Set up automatic token refresh
    this.oauth2Client.on("tokens", (tokens) => {
      this.saveTokens(tokens).catch(() => {
        // Silently handle save errors — never log token data
      });
    });
  }

  /**
   * Get the authenticated OAuth2 client.
   * Loads stored tokens if available and refreshes if expired.
   */
  async getClient(): Promise<OAuth2Client> {
    const tokens = await this.loadTokens();
    if (!tokens) {
      throw new Error(
        "No stored credentials found. Run the authorization flow first. " +
          "Use getAuthUrl() to generate an authorization URL.",
      );
    }

    this.oauth2Client.setCredentials(tokens);

    // Check if token is expired or about to expire (5 min buffer)
    if (this.isTokenExpired(tokens)) {
      await this.refreshToken();
    }

    return this.oauth2Client;
  }

  /**
   * Generate an authorization URL for the user to visit.
   */
  getAuthUrl(scopes: string[] = ALL_SCOPES): string {
    return this.oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: scopes,
      prompt: "consent",
    });
  }

  /**
   * Exchange an authorization code for tokens and store them.
   */
  async exchangeCode(code: string): Promise<void> {
    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    await this.saveTokens(tokens);
  }

  /**
   * Check if the current token is expired or near expiry.
   */
  private isTokenExpired(tokens: Credentials): boolean {
    if (!tokens.expiry_date) return true;
    const bufferMs = 5 * 60 * 1000; // 5 minutes
    return Date.now() >= tokens.expiry_date - bufferMs;
  }

  /**
   * Refresh the access token using the stored refresh token.
   */
  private async refreshToken(): Promise<void> {
    try {
      const { credentials } = await this.oauth2Client.refreshAccessToken();
      this.oauth2Client.setCredentials(credentials);
      await this.saveTokens(credentials);
    } catch (err) {
      // Surface Google's error code (e.g. invalid_grant, unauthorized_client) —
      // it is not secret and tells you what to fix. Never include token values.
      const data = (err as { response?: { data?: { error?: unknown; error_description?: unknown } } })
        ?.response?.data;
      const code = typeof data?.error === "string" ? data.error : undefined;
      const desc =
        typeof data?.error_description === "string" ? data.error_description : undefined;
      const hints: Record<string, string> = {
        invalid_grant:
          "The refresh token is expired or revoked. If the OAuth consent screen is in 'Testing' mode, " +
          "Google expires refresh tokens after 7 days — publish the app ('In production'), then re-authorize.",
        unauthorized_client:
          "The refresh token was issued for a different OAuth client than GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.",
        invalid_client: "GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is wrong.",
      };
      throw new Error(
        "Failed to refresh access token" +
          (code ? ` (Google: ${code}${desc ? ` — ${desc}` : ""})` : "") +
          ". " +
          (code && hints[code] ? hints[code] + " " : "") +
          "Generate a new refresh token and update GOOGLE_REFRESH_TOKEN (see README: Fixing 'Failed to refresh access token').",
      );
    }
  }

  /**
   * Save tokens to disk. Never logs token values.
   */
  private async saveTokens(tokens: Credentials): Promise<void> {
    const dir = path.dirname(this.tokenPath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // Refresh responses usually omit refresh_token — keep the one we have.
    let existing: Credentials = {};
    try {
      existing = JSON.parse(await fs.readFile(this.tokenPath, "utf-8")) as Credentials;
    } catch {
      // no existing file
    }
    const merged: Credentials = { ...existing, ...tokens };
    if (!tokens.refresh_token && existing.refresh_token) {
      merged.refresh_token = existing.refresh_token;
    }
    await fs.writeFile(this.tokenPath, JSON.stringify(merged), {
      mode: 0o600, // Owner read/write only
    });
  }

  /**
   * Load tokens from disk. Returns null if no stored tokens.
   */
  private async loadTokens(): Promise<Credentials | null> {
    // On Render, the refresh token in the environment is authoritative. It
    // deliberately wins over the token file so that someone visiting the public
    // /authorize page cannot swap in a different Google account.
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (refreshToken) {
      return { refresh_token: refreshToken };
    }

    // Local fallback: tokens saved by the /authorize → /callback flow.
    try {
      const data = await fs.readFile(this.tokenPath, "utf-8");
      return JSON.parse(data) as Credentials;
    } catch {
      return null;
    }
  }

  /**
   * Check if stored credentials exist.
   */
  async hasStoredCredentials(): Promise<boolean> {
    try {
      await fs.access(this.tokenPath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Create a YouTubeAuth instance from environment variables.
 */
export function createAuthFromEnv(): YouTubeAuth {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/callback";
  const tokenStoragePath = process.env.TOKEN_STORAGE_PATH || "./.tokens";

  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables are required.",
    );
  }

  return new YouTubeAuth({
    clientId,
    clientSecret,
    redirectUri,
    tokenStoragePath,
  });
}
