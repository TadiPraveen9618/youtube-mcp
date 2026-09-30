/**
 * Safe remote-file downloader used by the upload-from-URL tool.
 *
 * Security properties:
 *  - HTTPS only (every redirect hop is re-validated).
 *  - URLs with embedded credentials (user:pass@) are rejected.
 *  - SSRF protection: the hostname is resolved and every resolved address must
 *    be public. The validated address is pinned for the actual connection, so a
 *    DNS rebind between "check" and "connect" cannot reach internal services.
 *  - Optional host allowlist (UPLOAD_ALLOWED_HOSTS), applied to every hop.
 *  - Hard size cap, enforced from Content-Length *and* while streaming.
 *  - Idle and overall timeouts.
 *  - Files are written with mode 0600 into a private mkdtemp() directory.
 *  - Full URLs are never logged (signed URLs often carry secrets); only hosts.
 */
import * as https from "node:https";
import * as http from "node:http";
import * as dns from "node:dns";
import * as net from "node:net";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

export interface DownloadPolicy {
  /** Maximum number of bytes accepted. */
  maxBytes: number;
  /** Abort if no data is received for this long (ms). */
  idleTimeoutMs: number;
  /** Abort if the whole download takes longer than this (ms). */
  totalTimeoutMs: number;
  /** Maximum redirects to follow. */
  maxRedirects: number;
  /** Optional host allowlist (exact host or parent-domain suffix match). */
  allowedHosts?: string[];
  /** TESTING ONLY: allow http:// URLs. */
  allowHttp?: boolean;
  /** TESTING ONLY: allow loopback/private addresses. */
  allowPrivateAddresses?: boolean;
}

export interface DownloadResult {
  filePath: string;
  bytes: number;
  contentType: string | undefined;
  /** Host that finally served the file (after redirects). */
  finalHost: string;
}

export interface DownloadProgress {
  bytes: number;
  totalBytes?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Build the default video download policy from environment variables. */
export function videoPolicyFromEnv(): DownloadPolicy {
  const maxMb = envInt("MAX_UPLOAD_SIZE_MB", 2048);
  const hosts = (process.env.UPLOAD_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return {
    maxBytes: maxMb * 1024 * 1024,
    idleTimeoutMs: 60_000,
    totalTimeoutMs: envInt("UPLOAD_DOWNLOAD_TIMEOUT_MINUTES", 30) * 60_000,
    maxRedirects: 5,
    allowedHosts: hosts.length ? hosts : undefined,
  };
}

/** Thumbnails: YouTube caps custom thumbnails at 2 MB. */
export function thumbnailPolicyFromEnv(): DownloadPolicy {
  return { ...videoPolicyFromEnv(), maxBytes: 2 * 1024 * 1024, totalTimeoutMs: 120_000 };
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

const blocked = new net.BlockList();
// IPv4 non-public ranges
blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local / cloud metadata
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.0.0.0", 24, "ipv4");
blocked.addSubnet("192.0.2.0", 24, "ipv4");
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("198.18.0.0", 15, "ipv4");
blocked.addSubnet("198.51.100.0", 24, "ipv4");
blocked.addSubnet("203.0.113.0", 24, "ipv4");
blocked.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
blocked.addSubnet("240.0.0.0", 4, "ipv4"); // reserved + broadcast
// IPv6 non-public ranges
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6"); // unique local
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked.addSubnet("ff00::", 8, "ipv6"); // multicast
blocked.addSubnet("2001:db8::", 32, "ipv6"); // documentation
blocked.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64 (could reach v4 internals)

/** True if the address is loopback, private, link-local, or otherwise non-public. */
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) — judge the embedded IPv4 address.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    if (lower.startsWith("::ffff:")) return true; // hex-form mapped: refuse
    return blocked.check(address, "ipv6");
  }
  return true; // not an IP at all → treat as unsafe
}

// ---------------------------------------------------------------------------
// URL validation and share-link normalisation
// ---------------------------------------------------------------------------

function hostAllowed(host: string, allowed?: string[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  const h = host.toLowerCase();
  return allowed.some((a) => h === a || h.endsWith("." + a));
}

/** Validate a URL against the policy. Returns the parsed URL. */
export function validateUrl(raw: string, policy: DownloadPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new DownloadError("Invalid URL.");
  }
  const okProtocol =
    url.protocol === "https:" || (policy.allowHttp && url.protocol === "http:");
  if (!okProtocol) {
    throw new DownloadError("Only https:// URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new DownloadError("URLs containing credentials (user:password@) are not allowed.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new DownloadError("URL has no host.");
  if (!policy.allowPrivateAddresses) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
      throw new DownloadError("URL points to a private/internal host.");
    }
    if (net.isIP(host) && isPrivateAddress(host)) {
      throw new DownloadError("URL points to a private/internal address.");
    }
  }
  if (!hostAllowed(host, policy.allowedHosts)) {
    throw new DownloadError(
      `Host "${host}" is not in UPLOAD_ALLOWED_HOSTS.`,
    );
  }
  return url;
}

/**
 * Turn common "share" links into direct-download links.
 *  - Google Drive: /file/d/<id>/view, open?id=<id>, uc?id=<id>
 *  - Dropbox: ?dl=0 → ?dl=1
 */
export function normalizeShareUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw;
  }
  const host = url.hostname.toLowerCase();

  if (host === "drive.google.com" || host === "docs.google.com") {
    const m = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
    const id = m?.[1] ?? url.searchParams.get("id");
    if (id && /^[A-Za-z0-9_-]+$/.test(id)) {
      // drive.usercontent.google.com with confirm=t skips the
      // "can't scan this file for viruses" page shown for large files.
      return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
    }
  }

  if (host === "www.dropbox.com" || host === "dropbox.com") {
    url.searchParams.set("dl", "1");
    return url.toString();
  }

  return url.toString();
}

// ---------------------------------------------------------------------------
// Pinned, validated DNS lookup
// ---------------------------------------------------------------------------

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

function makeSafeLookup(policy: DownloadPolicy) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCb) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = addresses as dns.LookupAddress[];
      const safe = policy.allowPrivateAddresses
        ? list
        : list.filter((a) => !isPrivateAddress(a.address));
      if (safe.length === 0 || (!policy.allowPrivateAddresses && safe.length !== list.length)) {
        const e = new DownloadError(
          `Host "${hostname}" resolves to a private/internal address; refusing to connect.`,
        ) as unknown as NodeJS.ErrnoException;
        return callback(e, "", 0);
      }
      if (options && options.all) return callback(null, safe);
      callback(null, safe[0].address, safe[0].family);
    });
  };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

function requestOnce(
  url: URL,
  policy: DownloadPolicy,
  signal: AbortSignal,
): Promise<http.IncomingMessage> {
  const mod = url.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: makeSafeLookup(policy) as unknown as typeof dns.lookup,
        headers: {
          "User-Agent": "youtube-mcp-uploader/1.0",
          Accept: "*/*",
        },
        signal,
      },
      resolve,
    );
    req.setTimeout(policy.idleTimeoutMs, () => {
      req.destroy(new DownloadError("Connection timed out."));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Create a private temp directory (mode 0700). */
export async function makeTempDir(prefix = "yt-upload-"): Promise<string> {
  const base = process.env.UPLOAD_TMP_DIR || os.tmpdir();
  return fsp.mkdtemp(path.join(base, prefix));
}

/** Remove a temp directory and everything in it; never throws. */
export async function removeTempDir(dir: string | undefined): Promise<void> {
  if (!dir) return;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

async function freeBytes(dir: string): Promise<number | undefined> {
  try {
    const s = await fsp.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

/**
 * Download `rawUrl` into `destDir/fileName`, enforcing the policy.
 * The caller owns destDir and must remove it (see removeTempDir).
 */
export async function downloadToFile(
  rawUrl: string,
  destDir: string,
  fileName: string,
  policy: DownloadPolicy,
  onProgress?: (p: DownloadProgress) => void,
): Promise<DownloadResult> {
  const controller = new AbortController();
  const totalTimer = setTimeout(
    () => controller.abort(new DownloadError("Download took too long and was aborted.")),
    policy.totalTimeoutMs,
  );

  try {
    let url = validateUrl(normalizeShareUrl(rawUrl), policy);
    let res: http.IncomingMessage | undefined;

    for (let hop = 0; ; hop++) {
      res = await requestOnce(url, policy, controller.signal);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hop >= policy.maxRedirects) {
          throw new DownloadError("Too many redirects.");
        }
        url = validateUrl(new URL(res.headers.location, url).toString(), policy);
        continue;
      }
      if (status !== 200) {
        res.resume();
        throw new DownloadError(
          `Download failed: server ${url.hostname} returned HTTP ${status}. ` +
            "Check that the link is public (\"Anyone with the link\").",
        );
      }
      break;
    }

    const contentType = res.headers["content-type"]?.split(";")[0].trim().toLowerCase();
    if (contentType && (contentType.startsWith("text/") || contentType === "application/json")) {
      res.resume();
      throw new DownloadError(
        `The link returned a web page (${contentType}), not a file. ` +
          "Make sure it is a direct/public download link and sharing is set to \"Anyone with the link\".",
      );
    }

    const lengthHeader = res.headers["content-length"];
    const declared = lengthHeader ? Number(lengthHeader) : undefined;
    if (declared !== undefined && declared > policy.maxBytes) {
      res.resume();
      throw new DownloadError(
        `File is ${(declared / 1024 / 1024).toFixed(0)} MB, above the ${(policy.maxBytes / 1024 / 1024).toFixed(0)} MB limit.`,
      );
    }
    const free = await freeBytes(destDir);
    if (declared !== undefined && free !== undefined && declared > free - 50 * 1024 * 1024) {
      res.resume();
      throw new DownloadError("Not enough free disk space on the server for this file.");
    }

    const filePath = path.join(destDir, fileName);
    let bytes = 0;
    let lastReport = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > policy.maxBytes) {
          cb(
            new DownloadError(
              `File exceeds the ${(policy.maxBytes / 1024 / 1024).toFixed(0)} MB limit.`,
            ),
          );
          return;
        }
        if (onProgress && bytes - lastReport >= 1024 * 1024) {
          lastReport = bytes;
          onProgress({ bytes, totalBytes: declared });
        }
        cb(null, chunk);
      },
    });

    await pipeline(
      res,
      counter,
      fs.createWriteStream(filePath, { mode: 0o600, flags: "wx" }),
      { signal: controller.signal },
    );

    if (declared !== undefined && bytes !== declared) {
      throw new DownloadError(`Download incomplete (${bytes} of ${declared} bytes).`);
    }
    if (bytes === 0) throw new DownloadError("Downloaded file is empty.");
    onProgress?.({ bytes, totalBytes: declared ?? bytes });

    return { filePath, bytes, contentType, finalHost: url.hostname };
  } catch (err) {
    if (controller.signal.aborted && controller.signal.reason instanceof DownloadError) {
      throw controller.signal.reason;
    }
    if (err instanceof DownloadError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new DownloadError(`Download failed: ${msg}`);
  } finally {
    clearTimeout(totalTimer);
  }
}

// ---------------------------------------------------------------------------
// File-type sniffing
// ---------------------------------------------------------------------------

async function readHead(filePath: string, n = 16): Promise<Buffer> {
  const fh = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Returns a video container name if the file looks like a video, else undefined. */
export async function sniffVideo(filePath: string): Promise<string | undefined> {
  const b = await readHead(filePath);
  if (b.length >= 8 && b.toString("latin1", 4, 8) === "ftyp") return "mp4/mov";
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return "webm/mkv";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 11) === "AVI") return "avi";
  if (b.length >= 4 && b.toString("latin1", 0, 4) === "FLV\x01") return "flv";
  if (b.length >= 1 && b[0] === 0x47) return "mpeg-ts";
  if (b.length >= 4 && b.readUInt32BE(0) === 0x000001ba) return "mpeg-ps";
  // Some MP4s start with a 'wide'/'mdat'/'moov'/'free' box instead of 'ftyp'.
  const box = b.length >= 8 ? b.toString("latin1", 4, 8) : "";
  if (["moov", "mdat", "wide", "free", "skip"].includes(box)) return "mp4/mov";
  return undefined;
}

/** Returns the image MIME type for JPEG/PNG, else undefined. */
export async function sniffImage(filePath: string): Promise<"image/jpeg" | "image/png" | undefined> {
  const b = await readHead(filePath, 8);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return undefined;
}
