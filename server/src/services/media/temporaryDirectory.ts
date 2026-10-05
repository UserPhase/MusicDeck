import fs from "node:fs";

/** Only for private directories created by the caller with mkdtemp. */
export async function cleanupTemporaryDirectory(directory: string): Promise<string | null> {
  try {
    // Scanners and antivirus can briefly hold files open on Windows. Retry
    // asynchronously so cleanup does not block playback or other requests.
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return null;
  } catch (error) {
    // A leftover temporary directory must not invalidate published audio or
    // replace the original download/tagging error from a surrounding finally.
    const warning = `Temporary directory cleanup failed (${directory}): ${error instanceof Error ? error.message : String(error)}`;
    console.warn(warning);
    return warning;
  }
}
