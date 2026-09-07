import fs from "node:fs";
import path from "node:path";
import type { MusicDeckPlugin, MusicDeckPluginContext } from "./plugin-registry.js";
import type { AcquisitionProvider, AcquisitionContext, AcquisitionResult, AcquiredFile } from "../domain/acquisition.js";
import { extractZipSafely } from "../domain/acquisition.js";
import type { SourceCandidate } from "../domain/source-discovery.js";

function isPrivateHostname(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("169.254.")
  );
}

function validatedAcquisitionUrl(value: string, baseUrl?: string): URL | null {
  try {
    let resolved = value;
    if (value.startsWith("/") && baseUrl) {
      resolved = new URL(value, baseUrl).toString();
    }
    const url = new URL(resolved);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    if (isPrivateHostname(url.hostname) && !url.hostname.endsWith(".test") && !url.hostname.endsWith(".example") && url.hostname !== "localhost") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export class AuthorizedHttpAcquisitionProvider implements AcquisitionProvider {
  readonly id = "authorized-http-acquisition";
  readonly name = "Authorized HTTP Acquisition";

  constructor(
    private readonly context: MusicDeckPluginContext,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private config() {
    const rawBaseUrl = (this.context.settings.get<string>("baseUrl") || "").trim();
    const rawAuthType = (this.context.settings.get<string>("authType") || "none").trim().toLowerCase();
    const token = (this.context.settings.get<string>("accessToken") || "").trim();
    const authType = rawAuthType === "bearer" || (!rawAuthType && token) ? "bearer" : "none";
    return { baseUrl: rawBaseUrl, authType, token };
  }

  canAcquire(candidate: SourceCandidate): boolean {
    if (candidate.metadata?.fileUrl || candidate.metadata?.downloadUrl) {
      return true;
    }

    if (candidate.id.startsWith("https://") || candidate.id.startsWith("http://")) {
      return true;
    }

    if (candidate.id.startsWith("archiveorg:") && !candidate.id.endsWith(".torrent")) {
      return true;
    }

    if (candidate.id.includes(":") && !candidate.id.startsWith("magnet:")) {
      const rest = candidate.id.slice(candidate.id.indexOf(":") + 1);
      if (rest.startsWith("https://") || rest.startsWith("http://") || rest.startsWith("/")) {
        return true;
      }
    }

    return candidate.kind === "file" || candidate.kind === "track" || candidate.kind === "album-container";
  }

  async acquire(candidate: SourceCandidate, context: AcquisitionContext): Promise<AcquisitionResult> {
    const { baseUrl, authType, token } = this.config();

    if (authType === "bearer" && !token) {
      throw new Error("Access token is required for Bearer authentication");
    }

    let targetUrlStr = (candidate.metadata?.fileUrl as string) || (candidate.metadata?.downloadUrl as string);

    if (!targetUrlStr) {
      if (candidate.id.startsWith("archiveorg:")) {
        const parts = candidate.id.slice("archiveorg:".length).split(":");
        if (parts.length >= 2) {
          const identifier = encodeURIComponent(parts[0]);
          const filePart = parts.slice(1).join(":").split("/").map(encodeURIComponent).join("/");
          targetUrlStr = `https://archive.org/download/${identifier}/${filePart}`;
        }
      } else if (candidate.id.startsWith("http://") || candidate.id.startsWith("https://")) {
        targetUrlStr = candidate.id;
      } else if (candidate.id.includes(":") && !candidate.id.startsWith("magnet:")) {
        targetUrlStr = candidate.id.slice(candidate.id.indexOf(":") + 1);
      }
    }

    if (!targetUrlStr && baseUrl) {
      targetUrlStr = `${baseUrl.replace(/\/+$/, "")}/files/${encodeURIComponent(candidate.id)}`;
    }

    if (!targetUrlStr) {
      throw new Error(`Unable to resolve download URL for candidate: ${candidate.id}`);
    }

    const validatedUrl = validatedAcquisitionUrl(targetUrlStr, baseUrl);
    if (!validatedUrl) {
      throw new Error("Invalid or blocked acquisition URL");
    }

    const headers: Record<string, string> = {};
    if (authType === "bearer" && token) {
      headers["authorization"] = `Bearer ${token}`;
    }

    const response = await this.fetchImpl(validatedUrl, {
      headers,
      signal: context.signal,
    });

    if (!response.ok) {
      throw new Error(`Acquisition download failed with HTTP ${response.status}`);
    }

    const contentLengthHeader = response.headers.get("content-length");
    const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;

    let baseFileName = path.basename(validatedUrl.pathname) || `${candidate.id}.flac`;
    if (!baseFileName.includes(".")) {
      baseFileName += ".flac";
    }

    const tempFilePath = path.join(context.tmpDir, `${baseFileName}.partial`);
    const finalFilePath = path.join(context.tmpDir, baseFileName);

    let bytesDownloaded = 0;

    if (response.body && typeof (response.body as any).getReader === "function") {
      const writeStream = fs.createWriteStream(tempFilePath);
      const reader = (response.body as any).getReader();
      try {
        while (true) {
          if (context.signal.aborted) {
            reader.cancel();
            writeStream.close();
            throw new Error("Acquisition cancelled");
          }

          const { done, value } = await reader.read();
          if (done) break;

          if (value) {
            writeStream.write(Buffer.from(value));
            bytesDownloaded += value.length;
            context.onProgress(bytesDownloaded, totalBytes);
          }
        }
      } finally {
        await new Promise<void>((resolve) => writeStream.end(resolve));
      }
    } else {
      // Fallback for ArrayBuffer or Buffer responses
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      bytesDownloaded = buffer.length;
      fs.writeFileSync(tempFilePath, buffer);
      context.onProgress?.(bytesDownloaded, totalBytes || bytesDownloaded);
    }

    if (fs.existsSync(finalFilePath)) {
      fs.unlinkSync(finalFilePath);
    }
    fs.renameSync(tempFilePath, finalFilePath);

    // If the acquired file is a ZIP archive, extract contained audio files
    if (finalFilePath.toLowerCase().endsWith(".zip")) {
      const extractedPaths = extractZipSafely(finalFilePath, context.tmpDir);
      fs.unlinkSync(finalFilePath);

      const files: AcquiredFile[] = extractedPaths.map((p, index) => {
        const ext = path.extname(p);
        const nameWithoutExt = path.basename(p, ext);
        return {
          path: p,
          name: path.basename(p),
          title: nameWithoutExt,
          artist: candidate.artist,
          album: candidate.album || candidate.title,
          trackNumber: index + 1,
          size: fs.statSync(p).size,
        };
      });

      return { files };
    }

    const acquiredFile: AcquiredFile = {
      path: finalFilePath,
      name: baseFileName,
      title: candidate.title,
      artist: candidate.artist,
      album: candidate.album,
      durationSeconds: candidate.durationSeconds,
      size: fs.statSync(finalFilePath).size,
    };

    return { files: [acquiredFile] };
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    const { baseUrl, authType, token } = this.config();
    if (authType === "bearer" && !token) {
      return { ok: false, message: "Access token is required for Bearer authentication" };
    }
    if (!baseUrl) {
      return { ok: true, message: "Authorized HTTP Acquisition is configured" };
    }
    try {
      const url = new URL("/health", baseUrl);
      const headers: Record<string, string> = {};
      if (authType === "bearer" && token) {
        headers["authorization"] = `Bearer ${token}`;
      }
      const res = await this.fetchImpl(url, { headers });
      return { ok: res.ok, message: res.ok ? "Acquisition service is reachable" : "Acquisition service returned error" };
    } catch {
      return { ok: false, message: "Acquisition service is unreachable" };
    }
  }
}

export function createOnDemandLibraryPlugin(): MusicDeckPlugin {
  return {
    manifest: {
      id: "on-demand-library",
      name: "On-Demand Library",
      version: "1.0.0",
      description: "Acquires external music on demand and imports it into the local MusicDeck library.",
      capabilities: ["acquisition"],
      permissions: [
        "library.acquire",
        "library.write",
        "library.read",
        "network.request",
        "external-source.play",
        "history.read",
      ],
      config: {
        fields: [
          {
            key: "authType",
            label: "Authentication",
            required: false,
            default: "none",
            options: [
              { value: "none", label: "None" },
              { value: "bearer", label: "Bearer Token" },
            ],
          },
          { key: "baseUrl", label: "Authorized Provider Base URL", required: false },
          { key: "accessToken", label: "Access Token", secret: true, required: false },
          { key: "maxConcurrentDownloads", label: "Max Concurrent Downloads", required: false, default: 1 },
          { key: "autoScanLibraryAfterImport", label: "Auto-scan Library After Import", required: false, default: true },
        ],
      },
    },
    register(context) {
      const fetchImpl = context.network!.fetch as typeof fetch;
      context.acquisition?.register(new AuthorizedHttpAcquisitionProvider(context, fetchImpl));
    },
    async test(context) {
      const baseUrl = (context.settings.get<string>("baseUrl") || "").trim();
      const rawAuthType = (context.settings.get<string>("authType") || "none").trim().toLowerCase();
      const token = (context.settings.get<string>("accessToken") || "").trim();
      const authType = rawAuthType === "bearer" || (!rawAuthType && token) ? "bearer" : "none";

      if (authType === "bearer" && !token) {
        return { ok: false, message: "Access token is required for Bearer authentication" };
      }

      if (baseUrl) {
        try {
          const headers: Record<string, string> = {};
          if (authType === "bearer" && token) {
            headers["authorization"] = `Bearer ${token}`;
          }
          const res = await context.network!.fetch(`${baseUrl.replace(/\/+$/, "")}/health`, { headers });
          return { ok: res.ok, message: res.ok ? "Acquisition provider is reachable" : "Acquisition provider health check failed" };
        } catch {
          return { ok: false, message: "Acquisition provider is unreachable" };
        }
      }
      return { ok: true, message: "On-Demand Library is configured and ready" };
    },
  };
}
