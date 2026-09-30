# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-09-30

### Added
- `youtube_upload_video_from_url`: download a video from an HTTPS link (Google Drive, Dropbox, presigned URLs) to a private temp file, upload it to YouTube, optionally set a thumbnail, then delete the temp file. Defaults: category 1 (Film & Animation), privacy private. Supports `selfDeclaredMadeForKids`.
- `youtube_upload_status`: poll background upload jobs.
- `youtube_auth_status`: non-secret OAuth diagnostics and a live channel check.
- `/authorize` is protected by `SETUP_KEY` and a one-time `state`; `/callback` verifies the channel and shows the new refresh token to copy into Render.
- Safe downloader: HTTPS-only, SSRF protection with pinned DNS and per-redirect validation, optional host allowlist, size cap, timeouts, video/image magic-byte checks, no URL logging.

### Changed
- HTTP transport binds to `$PORT` (Render) when `--port` is not given.
- `youtube_videos_update` now reads the current video and merges changes, so updating one field (e.g. privacy) no longer blanks the title or resets category, tags, or the made-for-kids flag. Adds `selfDeclaredMadeForKids`.
- `youtube_videos_insert` description clarifies it needs a path on the server.

### Fixed
- Stale HTTP transport test (single options argument).
- Token refresh errors now include Google's error code (e.g. `invalid_grant`) with a fix hint; token values are never included.
- Saving refreshed tokens no longer drops the stored refresh token.
- Access tokens are cached until expiry instead of refreshing on every call; stray whitespace in `GOOGLE_REFRESH_TOKEN` is trimmed.
- `/callback` error output is HTML-escaped.

## [1.0.0] - 2026-03-10

### Added
- Comprehensive README.md with full tool reference (48 tools documented)
- Claude Desktop configuration example
- Quota budgeting guide
- OAuth scopes reference
- Project structure documentation

### Changed
- Version bumped to 1.0.0 (all milestones complete)
- Milestone M4 (Full Coverage) completed
- All 17 tasks across 4 milestones complete
- 101 tests passing, 0 TypeScript errors

## [0.16.0] - 2026-03-10

### Added
- 1 Activity tool: youtube_activities_list (src/tools/activities.ts)
- 2 Member tools: youtube_members_list, youtube_memberships_levels_list (src/tools/members.ts)
- 2 i18n tools: youtube_i18n_languages_list, youtube_i18n_regions_list (src/tools/i18n.ts)
- 1 VideoCategory tool: youtube_video_categories_list (src/tools/video-categories.ts)
- 2 Abuse tools: youtube_video_abuse_report_reasons_list, youtube_videos_report_abuse (src/tools/video-abuse.ts)
- 8 metadata & reporting tools total
- 12 unit tests for metadata & reporting tools
- 101 total tests passing across 16 test suites

## [0.15.0] - 2026-03-10

### Added
- 4 ChannelSection MCP tools: list, insert, update, delete (src/tools/channel-sections.ts)
- 1 ChannelBanner MCP tool: insert/upload (src/tools/channel-banners.ts)
- 1 Thumbnail MCP tool: set custom thumbnail (src/tools/thumbnails.ts)
- 2 Watermark MCP tools: set, unset (src/tools/watermarks.ts)
- 8 channel management tools total with streaming file uploads
- 10 unit tests for channel management tools
- 89 total tests passing across 15 test suites

### Note
- PlaylistImages API not available in googleapis SDK — 4 tools skipped

## [0.14.0] - 2026-03-10

### Added
- 5 Caption MCP tools: list, insert, update, download, delete (src/tools/captions.ts)
- Caption upload supports SRT/VTT formats with streaming
- Caption download returns text content in requested format
- All caption tools require youtube.force-ssl scope
- 7 unit tests for caption tools
- 79 total tests passing across 14 test suites

### Changed
- Task T14 (Caption Tools) completed — M4 started

## [0.13.0] - 2026-03-09

### Added
- 5 Comment MCP tools: list, insert, update, delete, moderate (src/tools/comments.ts)
- Reply to comments, edit, delete, and set moderation status (publish/hold/reject)
- Ban author option with moderation rejection
- All write tools require youtube.force-ssl scope
- 8 unit tests for comment tools
- 72 total tests passing across 13 test suites

### Changed
- Milestone M3 (Social Features) completed

## [0.12.0] - 2026-03-09

### Added
- 2 CommentThread MCP tools: list, insert (src/tools/comment-threads.ts)
- List comment threads by video, channel, or ID with search and order
- Post top-level comments (requires youtube.force-ssl scope)
- 5 unit tests for comment thread tools
- 64 total tests passing across 12 test suites

## [0.11.0] - 2026-03-09

### Added
- 3 Subscription MCP tools: list, insert, delete (src/tools/subscriptions.ts)
- Subscribe/unsubscribe to channels with resourceId support
- List subscriptions with order, pagination, and forChannelId filtering
- 5 unit tests for subscription tools registration and descriptions
- 59 total tests passing across 11 test suites

## [0.10.0] - 2026-03-09

### Added
- 2 Channel MCP tools: list, update (src/tools/channels.ts)
- Channel list supports ID, username, and authenticated user lookup
- Channel update supports description, keywords, language, country
- 4 unit tests for channel tools registration and descriptions
- 54 total tests passing across 10 test suites

### Changed
- Task T10 (Channel Tools) completed — M3 started

## [0.9.0] - 2026-03-09

### Added
- Streamable HTTP transport (src/transport/http.ts)
- CLI argument parsing: --transport (stdio|http), --port, --host
- Environment variable fallbacks: TRANSPORT, HTTP_PORT, HTTP_HOST
- Health check endpoint at /health
- Session-based HTTP connections via MCP SDK StreamableHTTPServerTransport
- 2 unit tests for HTTP transport module
- 50 total tests passing across 9 test suites

### Changed
- Entry point (src/index.ts) supports both stdio and HTTP transports
- Milestone M2 (Videos & Search) completed

## [0.8.0] - 2026-03-09

### Added
- 6 Video MCP tools: list, insert (upload), update, delete, rate, getRating (src/tools/videos.ts)
- Streaming file upload for youtube_videos_insert (1600 quota units)
- Video rating tools (like/dislike/none) for authenticated users
- 8 unit tests for video tools registration and description validation
- 47 total tests passing across 8 test suites

### Changed
- Task T8 (Video Tools) completed in Milestone M2

## [0.7.0] - 2026-03-09

### Added
- YouTube Search MCP tool: youtube_search (src/tools/search.ts)
- Search by query with filters: type (video/channel/playlist), order, date range, region
- Pagination support via pageToken
- 3 unit tests for search tool registration and description
- 39 total tests passing across 7 test suites

### Changed
- Task T7 (Search Tool) completed in Milestone M2

## [0.6.0] - 2026-03-09

### Added
- Test fixtures for YouTube API responses (playlists, playlist items)
- Mock client helper for unit testing
- E2E server creation tests
- Integration test scaffold (skippable without API credentials)
- 36 total tests passing across 6 test suites

### Changed
- Milestone M1 (Foundation + Playlists MVP) completed

## [0.5.0] - 2026-03-09

### Added
- 4 Playlist MCP tools: list, insert, update, delete (src/tools/playlists.ts)
- 4 PlaylistItems MCP tools: list, insert, update, delete (src/tools/playlist-items.ts)
- All tools have Zod input validation and quota cost in descriptions
- Server registers tools when auth is provided
- Unit tests for tool registration and description validation

## [0.4.0] - 2026-03-09

### Added
- YouTube API client wrapper (src/client/youtube.ts)
- YouTubeClient class with authenticated API access
- Error mapping: 400/401/403/404/409/5xx to clear messages
- Quota-exceeded detection (403 with quotaExceeded reason)
- Retry with exponential backoff for 5xx errors (1s, 2s, 4s)
- Quota cost constants for all operation types
- 13 unit tests for client module

## [0.3.0] - 2026-03-09

### Added
- Google OAuth 2.0 authentication module (src/auth/oauth.ts)
- YouTubeAuth class with token storage, refresh, and scope management
- Authorization URL generation with configurable scopes
- Automatic token refresh with 5-minute expiry buffer
- Secure token persistence (0600 file permissions)
- OAuth scope constants for all YouTube API scope categories
- Unit tests for auth module (9 tests passing)

## [0.2.0] - 2026-03-09

### Added
- TypeScript project scaffolding with esbuild build system
- MCP server entry point with stdio transport
- Package.json with build, dev, test, typecheck scripts
- tsconfig.json targeting ES2022/Node16 with strict mode
- Jest testing configuration with ts-jest ESM support
- Shared type definitions (TokenData, ServerConfig, YouTubeErrorResponse)
- Directory structure: src/{auth,client,tools,types,transport}, tests/{unit,integration}

## [0.1.0] - 2026-03-09

### Added
- Project requirements covering all 52 YouTube Data API v3 endpoints
- 4 milestones: Foundation + Playlists (MVP), Videos & Search, Social Features, Full Coverage
- 17 tasks with dependency chains and time estimates (70-90 hours total)
- ACP agent patterns, designs, and command templates
- Project progress tracking via progress.yaml
