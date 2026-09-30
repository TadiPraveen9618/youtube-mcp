# youtube-mcp

MCP server wrapping the YouTube Data API v3 for AI agents. Provides 51 tools covering playlists, videos, channels, comments, captions, subscriptions, and more.

> Built with [Agent Context Protocol](https://github.com/prmichaelsen/agent-context-protocol)

## Features

- **51 MCP tools** covering the YouTube Data API v3
- **Upload from URL**: upload a video from a Google Drive / Dropbox / HTTPS link, so a server on Render can publish files that live on your own PC
- **OAuth 2.0** authentication with automatic token refresh
- **Dual transport**: stdio (default) and Streamable HTTP
- **Quota-aware**: every tool description includes its API quota cost
- **Streaming uploads**: video, caption, banner, thumbnail, and watermark uploads use streaming
- **Retry logic**: automatic retry with exponential backoff for transient errors
- **Error mapping**: clear, actionable error messages for all API errors

## Quick Start

### 1. Install

```bash
npm install
npm run build
```

### 2. Configure OAuth

Set these environment variables:

```env
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/callback
```

### 3. Run

```bash
# stdio transport (default)
npm start

# HTTP transport
node dist/index.js --transport http --port 3000
```

### 4. Claude Desktop Configuration

```json
{
  "mcpServers": {
    "youtube": {
      "command": "node",
      "args": ["/path/to/youtube-mcp/dist/index.js"]
    }
  }
}
```

## Transport Options

| Transport | Flag | Default |
|-----------|------|---------|
| stdio | `--transport stdio` | Yes |
| HTTP | `--transport http` | No |

### HTTP Transport Options

| Option | CLI | Env Var | Default |
|--------|-----|---------|---------|
| Port | `--port 3000` | `PORT` (set by Render), then `HTTP_PORT` | 3000 |
| Host | `--host 0.0.0.0` | `HTTP_HOST` | 0.0.0.0 |

## Uploading videos from your computer (Render deployment)

A server hosted on Render cannot read files on your PC, so `youtube_videos_insert`
(which takes a server-side file path) can't upload them. Use
**`youtube_upload_video_from_url`** instead:

1. Put the MP4 somewhere reachable over HTTPS: Google Drive, Dropbox, or any
   presigned S3/R2/GCS URL.
2. Ask Claude to upload it and paste the link.
3. The server downloads the file to a private temp folder on Render (mode 0600),
   checks that it really is a video, uploads it to YouTube with the channel's
   existing OAuth credentials, optionally sets a thumbnail, and deletes the temp
   folder — on success *and* on failure.

### How to share the file (Google Drive — recommended)

1. Upload the MP4 to Google Drive (drag it into drive.google.com).
2. Right-click the file → **Share** → **General access** → **Anyone with the link** (Viewer).
3. **Copy link** — it looks like `https://drive.google.com/file/d/<FILE_ID>/view?usp=sharing`.
   Paste it as-is; the server converts it to a direct download (including large
   files that show Drive's "can't scan for viruses" page).
4. After the upload is confirmed, set sharing back to **Restricted**.

**Dropbox:** Share → Copy link. `?dl=0` is changed to `?dl=1` automatically.

A link that returns a web page (sign-in page, "request access" page) is rejected
with a clear error instead of being uploaded to YouTube.

### Example prompt

> Upload https://drive.google.com/file/d/1AbC.../view to YouTube with
> `youtube_upload_video_from_url`: title "…", description "…", tags "a, b, c",
> made for kids = true. Keep it private.

### Tool parameters — `youtube_upload_video_from_url`

| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `videoUrl` | yes | — | Public HTTPS link. Drive/Dropbox share links are converted automatically |
| `title` | yes | — | Max 100 characters, no `<` or `>` |
| `description` | no | — | Max 5000 bytes, no `<` or `>` |
| `tags` | no | — | Comma-separated. Checked against YouTube's 500-character limit |
| `categoryId` | no | `1` (Film & Animation) | See `youtube_video_categories_list` |
| `privacyStatus` | no | `private` | `private`, `unlisted`, `public` |
| `selfDeclaredMadeForKids` | no | not set | `true` marks the video as made for kids (COPPA) |
| `thumbnailUrl` | no | — | JPEG/PNG, max 2 MB. Requires a phone-verified channel; if it fails, the video still uploads and the error is reported |
| `waitSeconds` | no | `45` | How long the call waits before returning. Uploads keep running in the background after that |

The upload runs as a background job, so large files don't hit client timeouts.
If the result says `downloading` or `uploading`, call **`youtube_upload_status`**
with the `jobId` until it says `completed` (you get `videoId`, `uploadStatus`,
`privacyStatus`, `selfDeclaredMadeForKids`, and a YouTube Studio link) or
`failed` (you get the reason). Only one upload runs at a time. Job history is
kept in memory for 24 hours or until the service restarts.

**Render free plan:** free services sleep after ~15 minutes without incoming
requests. Polling `youtube_upload_status` every minute or two keeps the service
awake during a long upload.

### Security

- HTTPS only; URLs with embedded `user:password@` are rejected.
- SSRF protection: hosts that resolve to loopback, private, link-local
  (including `169.254.169.254` cloud metadata), CGNAT, or other internal
  addresses are refused. The checked IP is pinned for the connection, and every
  redirect hop is re-validated (max 5).
- Optional host allowlist: `UPLOAD_ALLOWED_HOSTS`.
- Size cap from `Content-Length` *and* while streaming; free disk space checked first.
- Temp files live in a `mkdtemp` directory with mode 0600 and are always deleted.
- The downloaded file must be a real video container (MP4/MOV/WebM/MKV/AVI/…), checked by its magic bytes.
- Full URLs are never logged or stored (share and presigned links can contain
  secrets) — only the host name. OAuth tokens and client secrets are never
  logged or returned.

### Environment variables (Render → your service → Environment)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `GOOGLE_CLIENT_ID` | yes | — | OAuth client |
| `GOOGLE_CLIENT_SECRET` | yes | — | OAuth client |
| `GOOGLE_REFRESH_TOKEN` | yes | — | Refresh token for the channel |
| `GOOGLE_REDIRECT_URI` | for `/authorize` only | — | `https://<your-service>.onrender.com/callback` |
| `SETUP_KEY` | to re-authorize | — | Protects `/authorize`. Use Render's **Generate** button |
| `TRANSPORT` | yes | `stdio` | Must be `http` on Render (or pass `--transport http`) |
| `PORT` | auto | — | Set by Render automatically. The server now binds to it |
| `MAX_UPLOAD_SIZE_MB` | no | `2048` | Largest video accepted |
| `UPLOAD_ALLOWED_HOSTS` | no | any public host | Recommended: `drive.google.com,drive.usercontent.google.com,googleusercontent.com,dropbox.com,dropboxusercontent.com` |
| `UPLOAD_DOWNLOAD_TIMEOUT_MINUTES` | no | `30` | Abort downloads that take longer |
| `UPLOAD_TMP_DIR` | no | OS temp dir | Where temp files are written |

### Fixing "Failed to refresh access token"

The error now includes Google's reason. The usual fixes:

- **`invalid_grant`** — the refresh token expired or was revoked. If your OAuth
  consent screen is in **Testing** mode, Google expires refresh tokens after
  **7 days**. Go to Google Cloud Console → *Google Auth Platform → Audience* →
  **Publish app** (an unverified app is fine for your own channel), then make a new token (below).
- **`unauthorized_client`** — the token was created with a different OAuth client
  than `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (for example, OAuth Playground
  without "Use your own OAuth credentials").
- **`invalid_client`** — the client ID or secret on Render is wrong.

**Make a new refresh token (built-in, recommended).** This mints the token with
the exact client ID/secret Render uses, so `unauthorized_client` can't happen:

1. Google Cloud Console → *Google Auth Platform → Clients* → your **Web application**
   client → **Authorized redirect URIs** must contain
   `https://<your-service>.onrender.com/callback`, and Render's `GOOGLE_REDIRECT_URI`
   must be exactly the same string.
2. Render → *Environment* → add `SETUP_KEY` (click **Generate** for a random value) → Save.
3. Open `https://<your-service>.onrender.com/authorize?key=<SETUP_KEY>` in your browser
   (copy the key from Render yourself; never paste it into a chat).
4. Sign in, **choose the channel** (brand-account channels appear as their own
   entry), allow access. The page confirms which channel is connected and shows
   the new refresh token.
5. The server uses it immediately. To keep it after restarts: Render →
   *Environment* → `GOOGLE_REFRESH_TOKEN` → paste → Save.
6. Verify: ask Claude to run `youtube_auth_status`.

`/authorize` is disabled unless `SETUP_KEY` is set and supplied, and `/callback`
only accepts a one-time `state` issued by `/authorize`.

`GOOGLE_REFRESH_TOKEN` takes priority over the token file on disk.

### Render service settings

| Setting | Value |
|---------|-------|
| Build command | `npm ci && npm run build` |
| Start command | `node dist/index.js --transport http` |
| Health check path | `/health` |

Don't pass `--port`; the server picks up Render's `$PORT` automatically.
Render's ephemeral disk is enough for the temp file because it is deleted after
each upload. Keep `MAX_UPLOAD_SIZE_MB` below the free disk space on your instance.


## Tools Reference

### Playlists (4 tools)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_playlists_list` | List playlists by channel, ID, or authenticated user | 1 |
| `youtube_playlists_insert` | Create a new playlist | 50 |
| `youtube_playlists_update` | Update playlist title, description, privacy | 50 |
| `youtube_playlists_delete` | Delete a playlist | 50 |

### Playlist Items (4 tools)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_playlist_items_list` | List items in a playlist | 1 |
| `youtube_playlist_items_insert` | Add a video to a playlist | 50 |
| `youtube_playlist_items_update` | Update item position or video | 50 |
| `youtube_playlist_items_delete` | Remove an item from a playlist | 50 |

### Search (1 tool)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_search` | Search for videos, channels, or playlists | 100 |

### Videos (9 tools)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_videos_list` | List videos by ID, chart, or user rating | 1 |
| `youtube_videos_insert` | Upload a video from a path on the server's disk | 1600 |
| `youtube_upload_video_from_url` | Download a video from an HTTPS link, upload it, delete the temp file | 1600 (+50 thumbnail) |
| `youtube_upload_status` | Check progress of an upload-from-URL job | 0 |
| `youtube_auth_status` | Show which channel/OAuth client the server uses and whether auth works (no secrets) | 1 |
| `youtube_videos_update` | Update video metadata (merges with current values) | 51 |
| `youtube_videos_delete` | Delete a video | 50 |
| `youtube_videos_rate` | Rate a video (like/dislike/none) | 50 |
| `youtube_videos_get_rating` | Get user's rating for videos | 1 |

### Channels (2 tools)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_channels_list` | List channels by ID, username, or authenticated user | 1 |
| `youtube_channels_update` | Update channel description, keywords, language | 50 |

### Subscriptions (3 tools)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_subscriptions_list` | List subscriptions | 1 |
| `youtube_subscriptions_insert` | Subscribe to a channel | 50 |
| `youtube_subscriptions_delete` | Unsubscribe | 50 |

### Comment Threads (2 tools)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_comment_threads_list` | List top-level comments on a video | 1 |
| `youtube_comment_threads_insert` | Post a new top-level comment | 50 |

### Comments (5 tools)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_comments_list` | List replies to a comment | 1 |
| `youtube_comments_insert` | Reply to a comment | 50 |
| `youtube_comments_update` | Edit a comment | 50 |
| `youtube_comments_delete` | Delete a comment | 50 |
| `youtube_comments_moderate` | Set moderation status (publish/hold/reject) | 50 |

### Captions (5 tools)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_captions_list` | List caption tracks for a video | 50 |
| `youtube_captions_insert` | Upload a caption file (SRT/VTT) | 400 |
| `youtube_captions_update` | Update a caption track | 450 |
| `youtube_captions_download` | Download caption content as text | 200 |
| `youtube_captions_delete` | Delete a caption track | 50 |

### Channel Sections (4 tools)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_channel_sections_list` | List channel homepage sections | 1 |
| `youtube_channel_sections_insert` | Create a section | 50 |
| `youtube_channel_sections_update` | Update section title/position | 50 |
| `youtube_channel_sections_delete` | Delete a section | 50 |

### Channel Banners (1 tool)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_channel_banners_insert` | Upload a channel banner image | 50 |

### Thumbnails (1 tool)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_thumbnails_set` | Set a custom video thumbnail | 50 |

### Watermarks (2 tools)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_watermarks_set` | Set channel watermark overlay | 50 |
| `youtube_watermarks_unset` | Remove channel watermark | 50 |

### Activities (1 tool)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_activities_list` | List channel activities | 1 |

### Members (2 tools)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_members_list` | List channel members/sponsors | 1 |
| `youtube_memberships_levels_list` | List membership levels | 1 |

### i18n (2 tools)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_i18n_languages_list` | List supported languages | 1 |
| `youtube_i18n_regions_list` | List supported regions | 1 |

### Video Categories (1 tool)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_video_categories_list` | List video categories by region | 1 |

### Abuse Reporting (2 tools)

| Tool | Description | Quota |
|------|-------------|-------|
| `youtube_video_abuse_report_reasons_list` | List valid abuse report reasons | 1 |
| `youtube_videos_report_abuse` | Report a video for abuse | 50 |

## Quota Budgeting

The YouTube Data API has a daily quota of 10,000 units by default. Key costs:

| Operation | Cost |
|-----------|------|
| Most list/read operations | 1 unit |
| Search | 100 units |
| Insert/Update/Delete (most) | 50 units |
| Caption insert | 400 units |
| Caption update | 450 units |
| Caption download | 200 units |
| Caption list | 50 units |
| Video upload | 1600 units |

## OAuth Scopes

| Scope | Used By |
|-------|---------|
| `youtube.readonly` | All list/read operations |
| `youtube` | Playlist, video, channel, subscription writes |
| `youtube.upload` | Video uploads |
| `youtube.force-ssl` | Comments, captions, moderation |

## Development

```bash
npm run dev        # Watch mode with tsx
npm run build      # Production build with esbuild
npm test           # Run tests (135 passing)
npm run typecheck  # TypeScript type checking
```

## Project Structure

```
youtube-mcp/
├── src/
│   ├── index.ts              # Entry point (transport selection)
│   ├── server.ts             # MCP server factory
│   ├── auth/oauth.ts         # OAuth 2.0 authentication
│   ├── client/youtube.ts     # YouTube API client wrapper
│   ├── tools/                # 18 tool modules
│   └── transport/http.ts     # Streamable HTTP transport
├── tests/
│   ├── unit/                 # 16 test suites
│   └── helpers/              # Mock client, fixtures
├── agent/                    # ACP project management
└── dist/                     # Built output
```

## License

MIT

## Author

Patrick Michaelsen
