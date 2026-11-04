import type { Db } from "../../db/database.js";
import type { CatalogService } from "../../domain/catalog.js";
import type { SourceResolver } from "../../domain/source-resolver.js";
import { LoudnessService, playbackIdentity } from "./loudnessService.js";
import { LibraryAnalysisScanService } from "./libraryAnalysisScanService.js";
import { readContentRevision } from "./contentRevision.js";
export type { LibraryScanStatus as LoudnessScanStatus } from "./libraryAnalysisScanService.js";

/** One analysis worker leaves the other loudness processing slot for playback. */
export class LoudnessScanService extends LibraryAnalysisScanService {
  constructor(db: Db, catalog: CatalogService, resolver: SourceResolver, loudness: LoudnessService) {
    super(db, catalog, "loudness", async track => {
      if (loudness.trackLoudness(track)) return { success: true, reused: true };
      const result = await loudness.analyzeTrack(playbackIdentity(track.id, readContentRevision(db, track.id)), () => resolver.fetchStream(track.id));
      return { success: result.measured, reused: result.reused };
    });
  }
}
