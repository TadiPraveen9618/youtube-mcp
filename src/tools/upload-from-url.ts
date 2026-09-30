import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { YouTubeClient } from "../client/youtube.js";
import {
  DownloadError,
  DownloadPolicy,
  downloadToFile,
  makeTempDir,
  removeTempDir,
  sniffImage,
  sniffVideo,
  thumbnailPolicyFromEnv,
  videoPolicyFromEnv,
} from "../utils/safe-download.js";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** YouTube rejects titles/descriptions containing angle brackets. */
const NO_ANGLE_BRACKETS = /^[^<>]*$/;

export function parseTags(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const tags = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return tags.length ? tags : undefined;
}

/**
 * YouTube's 500-character tag limit counts commas between tags and adds two
 * characters (quotes) for every tag that contains a space.
 */
export function youtubeTagLength(tags: string[]): number {
  const body = tags.reduce((n, t) => n + t.length + (t.includes(" ") ? 2 : 0), 0);
  return body + Math.max(0, tags.length - 1);
}

// ---------------------------------------------------------------------------
// In-memory job tracking
// ---------------------------------------------------------------------------

export type JobState =
  | "queued"
  | "downloading"
  | "uploading"
  | "setting_thumbnail"
  | "completed"
  | "failed";

export interface UploadJob {
  jobId: string;
  state: JobState;
  title: string;
  sourceHost: string;
  createdAt: string;
  updatedAt: string;
  downloadedBytes: number;
  totalBytes?: number;
  uploadedBytes: number;
  videoId?: string;
  result?: Record<string, unknown>;
  thumbnail?: { status: "set" | "failed" | "skipped"; message?: string };
  error?: string;
  tempFilesDeleted: boolean;
}

const jobs = new Map<string, UploadJob>();
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

function pruneJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (Date.parse(job.updatedAt) < cutoff) jobs.delete(id);
  }
}

function activeJob(): UploadJob | undefined {
  for (const job of jobs.values()) {
    if (!["completed", "failed"].includes(job.state)) return job;
  }
  return undefined;
}

function touch(job: UploadJob, patch: Partial<UploadJob>): void {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

/** Test hook. */
export function _resetJobsForTests(): void {
  jobs.clear();
}

export function getJob(jobId: string): UploadJob | undefined {
  return jobs.get(jobId);
}

function jobView(job: UploadJob): Record<string, unknown> {
  const view: Record<string, unknown> = { ...job };
  if (job.totalBytes) {
    view.downloadPercent = Math.round((job.downloadedBytes / job.totalBytes) * 100);
    if (job.state === "uploading" || job.state === "setting_thumbnail" || job.state === "completed") {
      view.uploadPercent = Math.min(100, Math.round((job.uploadedBytes / job.totalBytes) * 100));
    }
  }
  if (job.videoId) {
    view.studioUrl = `https://studio.youtube.com/video/${job.videoId}/edit`;
    view.watchUrl = `https://www.youtube.com/watch?v=${job.videoId}`;
  }
  if (job.state !== "completed" && job.state !== "failed") {
    view.next = "Call youtube_upload_status with this jobId to check progress.";
  }
  return view;
}

// ---------------------------------------------------------------------------
// The upload pipeline
// ---------------------------------------------------------------------------

export interface UploadFromUrlArgs {
  videoUrl: string;
  title: string;
  description?: string;
  tags?: string;
  categoryId: string;
  privacyStatus: "public" | "private" | "unlisted";
  selfDeclaredMadeForKids?: boolean;
  thumbnailUrl?: string;
}

export interface UploadDeps {
  videoPolicy?: DownloadPolicy;
  thumbnailPolicy?: DownloadPolicy;
}

async function runJob(
  job: UploadJob,
  args: UploadFromUrlArgs,
  client: YouTubeClient,
  deps: UploadDeps,
): Promise<void> {
  let tempDir: string | undefined;
  try {
    tempDir = await makeTempDir();

    // 1. Download the video to a private temp file.
    touch(job, { state: "downloading" });
    const video = await downloadToFile(
      args.videoUrl,
      tempDir,
      "video.bin",
      deps.videoPolicy ?? videoPolicyFromEnv(),
      (p) => touch(job, { downloadedBytes: p.bytes, totalBytes: p.totalBytes }),
    );
    touch(job, { downloadedBytes: video.bytes, totalBytes: video.bytes });

    const container = await sniffVideo(video.filePath);
    if (!container) {
      throw new DownloadError(
        "The downloaded file does not look like a video (MP4/MOV/WebM/MKV/AVI). " +
          "If this is a Google Drive link, set sharing to \"Anyone with the link\".",
      );
    }

    // 2. Upload to YouTube. The read stream is created inside the callback so
    //    automatic retries (5xx) re-read the file from the start.
    touch(job, { state: "uploading" });
    const status: Record<string, unknown> = { privacyStatus: args.privacyStatus };
    if (args.selfDeclaredMadeForKids !== undefined) {
      status.selfDeclaredMadeForKids = args.selfDeclaredMadeForKids;
    }
    const insert = await client.execute((api) =>
      api.videos.insert(
        {
          part: ["snippet", "status"],
          requestBody: {
            snippet: {
              title: args.title,
              description: args.description,
              tags: parseTags(args.tags),
              categoryId: args.categoryId,
            },
            status,
          },
          media: { body: createReadStream(video.filePath) },
        },
        {
          onUploadProgress: (evt: { bytesRead?: number }) => {
            if (typeof evt?.bytesRead === "number") {
              touch(job, { uploadedBytes: evt.bytesRead });
            }
          },
        },
      ),
    );
    const data = (insert as { data: Record<string, any> }).data ?? {};
    const videoId: string | undefined = data.id;
    if (!videoId) throw new Error("YouTube did not return a video ID.");
    touch(job, {
      videoId,
      uploadedBytes: video.bytes,
      result: {
        videoId,
        title: data.snippet?.title,
        categoryId: data.snippet?.categoryId,
        uploadStatus: data.status?.uploadStatus,
        privacyStatus: data.status?.privacyStatus,
        selfDeclaredMadeForKids: data.status?.selfDeclaredMadeForKids,
        madeForKids: data.status?.madeForKids,
        detectedContainer: container,
        sizeBytes: video.bytes,
      },
    });
    console.error(`[upload ${job.jobId}] uploaded video ${videoId} (${video.bytes} bytes)`);

    // 3. Optional thumbnail. Failure here does not fail the job — the video is
    //    already uploaded — it is reported in job.thumbnail instead.
    if (args.thumbnailUrl) {
      touch(job, { state: "setting_thumbnail" });
      try {
        const thumb = await downloadToFile(
          args.thumbnailUrl,
          tempDir,
          "thumbnail.bin",
          deps.thumbnailPolicy ?? thumbnailPolicyFromEnv(),
        );
        const mimeType = await sniffImage(thumb.filePath);
        if (!mimeType) throw new DownloadError("Thumbnail must be a JPEG or PNG image.");
        await client.execute((api) =>
          api.thumbnails.set({
            videoId,
            media: { mimeType, body: createReadStream(thumb.filePath) },
          }),
        );
        touch(job, { thumbnail: { status: "set" } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        touch(job, {
          thumbnail: {
            status: "failed",
            message:
              message +
              " (Custom thumbnails require a phone-verified channel; the video itself uploaded fine.)",
          },
        });
      }
    } else {
      touch(job, { thumbnail: { status: "skipped" } });
    }

    touch(job, { state: "completed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    touch(job, { state: "failed", error: message });
    console.error(`[upload ${job.jobId}] failed: ${message}`);
  } finally {
    await removeTempDir(tempDir);
    touch(job, { tempFilesDeleted: true });
  }
}

/** Start an upload job. Exported for tests. */
export function startUploadJob(
  args: UploadFromUrlArgs,
  client: YouTubeClient,
  deps: UploadDeps = {},
): { job: UploadJob; done: Promise<void> } {
  pruneJobs();
  const running = activeJob();
  if (running) {
    throw new Error(
      `Another upload is already in progress (jobId ${running.jobId}). ` +
        "Wait for it to finish — check it with youtube_upload_status.",
    );
  }
  let sourceHost = "unknown";
  try {
    sourceHost = new URL(args.videoUrl).hostname;
  } catch {
    /* validated later */
  }
  const now = new Date().toISOString();
  const job: UploadJob = {
    jobId: randomUUID(),
    state: "queued",
    title: args.title,
    sourceHost,
    createdAt: now,
    updatedAt: now,
    downloadedBytes: 0,
    uploadedBytes: 0,
    tempFilesDeleted: false,
  };
  jobs.set(job.jobId, job);
  // Never log the full URL: signed/share links can contain secrets.
  console.error(`[upload ${job.jobId}] started from host ${sourceHost}`);
  const done = runJob(job, args, client, deps);
  return { job, done };
}

async function waitFor(job: UploadJob, done: Promise<void>, seconds: number): Promise<void> {
  if (seconds <= 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    done,
    new Promise<void>((r) => {
      timer = setTimeout(r, seconds * 1000);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

// ---------------------------------------------------------------------------
// MCP tool registration
// ---------------------------------------------------------------------------

export function registerUploadFromUrlTools(
  server: McpServer,
  client: YouTubeClient,
  deps: UploadDeps = {},
): void {
  server.tool(
    "youtube_upload_video_from_url",
    "Upload a video to YouTube from a public HTTPS URL (Google Drive share link, Dropbox link, " +
      "S3/R2 presigned URL, etc.). The server downloads the file to a temporary location, uploads it " +
      "with the channel's existing OAuth credentials, then deletes the temp file. Use this for files " +
      "on the user's own computer (they first put the file on Drive/Dropbox). Defaults: category 1 " +
      "(Film & Animation), privacy PRIVATE. Runs as a background job: if it is not finished within " +
      "waitSeconds, poll youtube_upload_status with the returned jobId. Quota: 1600 units (+50 for thumbnail).",
    {
      videoUrl: z
        .string()
        .url()
        .describe(
          "Public HTTPS link to the video file. Google Drive 'Anyone with the link' share links and Dropbox links are converted to direct downloads automatically.",
        ),
      title: z
        .string()
        .min(1)
        .max(100)
        .regex(NO_ANGLE_BRACKETS, "Title cannot contain < or >")
        .describe("Video title (max 100 characters, no < or >)"),
      description: z
        .string()
        .regex(NO_ANGLE_BRACKETS, "Description cannot contain < or >")
        .refine((d) => Buffer.byteLength(d, "utf8") <= 5000, "Description must be at most 5000 bytes")
        .optional()
        .describe("Video description (max 5000 bytes, no < or >)"),
      tags: z
        .string()
        .optional()
        .refine(
          (t) => !t || youtubeTagLength(parseTags(t) ?? []) <= 500,
          "Tags exceed YouTube's 500-character limit (commas count; tags with spaces count +2)",
        )
        .describe("Comma-separated tags"),
      categoryId: z
        .string()
        .regex(/^\d+$/, "categoryId must be numeric")
        .default("1")
        .describe("Video category ID (default: 1 = Film & Animation)"),
      privacyStatus: z
        .enum(["private", "unlisted", "public"])
        .default("private")
        .describe("Privacy status (default: private, so nothing is published by accident)"),
      selfDeclaredMadeForKids: z
        .boolean()
        .optional()
        .describe(
          "Set true for content made for kids (COPPA). Sets status.selfDeclaredMadeForKids on the video.",
        ),
      thumbnailUrl: z
        .string()
        .url()
        .optional()
        .describe("Optional public HTTPS link to a JPEG/PNG thumbnail (max 2 MB, 1280x720 recommended)"),
      waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(240)
        .default(45)
        .describe("How long to wait for completion before returning the job status (0-240 seconds)"),
    },
    async (args) => {
      const { waitSeconds, ...uploadArgs } = args;
      const { job, done } = startUploadJob(uploadArgs as UploadFromUrlArgs, client, deps);
      await waitFor(job, done, waitSeconds);
      return text(jobView(job));
    },
  );

  server.tool(
    "youtube_upload_status",
    "Check the status of a youtube_upload_video_from_url job (downloading, uploading, completed, failed). " +
      "Omit jobId to list recent jobs. Jobs are kept in memory for 24 hours or until the server restarts. Quota: 0.",
    {
      jobId: z.string().optional().describe("Job ID returned by youtube_upload_video_from_url"),
    },
    async (args) => {
      pruneJobs();
      if (args.jobId) {
        const job = jobs.get(args.jobId);
        if (!job) {
          return text({
            error:
              "Job not found. It may have expired or the server restarted — check the channel with youtube_videos_list / YouTube Studio before re-uploading.",
          });
        }
        return text(jobView(job));
      }
      return text([...jobs.values()].map(jobView));
    },
  );
}
