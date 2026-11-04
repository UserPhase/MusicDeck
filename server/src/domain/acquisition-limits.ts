export const DEFAULT_ACQUISITION_LIMITS = {
  maxPending: 50,
  maxPendingPerUser: 10,
  submissionWindowMs: 60_000,
  submissionsPerUser: 20,
  submissionsGlobal: 100,
  maxRateEntries: 10_000,
  retentionMs: 7 * 24 * 60 * 60_000,
  maxRetainedJobs: 1000,
  cleanupIntervalMs: 60_000,
  ssePerUser: 3,
  sseGlobal: 20,
};

export type AcquisitionLimits = typeof DEFAULT_ACQUISITION_LIMITS;

export class AcquisitionCapacityError extends Error {
  constructor(public readonly retryAfter = 60) {
    super("Acquisition capacity temporarily unavailable; retry later");
  }
}

export function resolveAcquisitionLimits(overrides: Partial<AcquisitionLimits> = {}): AcquisitionLimits {
  const limits = { ...DEFAULT_ACQUISITION_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Acquisition ${key} must be a positive safe integer`);
  }
  return limits;
}
