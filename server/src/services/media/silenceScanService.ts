import type { Db } from "../../db/database.js";
import type { CatalogService } from "../../domain/catalog.js";
import { SilenceAnalysisService, silenceParameters, type SilenceParameters } from "../../domain/silence-analysis.js";
import { LibraryAnalysisScanService } from "./libraryAnalysisScanService.js";

export class SilenceScanService extends LibraryAnalysisScanService {
  constructor(db: Db, catalog: CatalogService, analysis: SilenceAnalysisService) {
    super(db, catalog, "silence", async (track, options) => {
      const parameters = silenceParameters(options);
      if (analysis.getAnalysis(track.id, parameters)?.status === "completed") return { success: true, reused: true };
      const result = await analysis.analyzeTrack(track.id, parameters);
      return { success: result.status === "completed", reused: false };
    });
  }
  override start(userId: string, options: Partial<SilenceParameters> = {}) {
    return super.start(userId, silenceParameters(options));
  }
}
