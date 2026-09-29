// Owner-configurable in config.toml [limits]; "unlimited" is stored as null.
export const DEFAULT_LIMITS = { max_jobs: 4, max_run_minutes: 120 } as const;
export type Limits = { maxJobs: number | null; maxRunMinutes: number | null };
export function resolveLimits(limits: Limits | undefined): Limits {
  return limits ?? { maxJobs: DEFAULT_LIMITS.max_jobs, maxRunMinutes: DEFAULT_LIMITS.max_run_minutes };
}
export const MAX_LOG_READ_BYTES = 8192;
export const MAX_LOG_BYTES = 1_048_576;
// Deadline for a run whose spec predates configurable limits.
export const MAX_RUN_MS = DEFAULT_LIMITS.max_run_minutes * 60 * 1000;
export const LOG_TRUNCATED = "\n[outsrc log truncated]\n";
