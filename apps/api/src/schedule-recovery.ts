import type { ScheduleStore } from "@4evergent/database";
import { validateScheduleExpression } from "@4evergent/database";

export interface ScheduleRecoveryOptions {
  /** Override clock for deterministic testing. */
  now?: () => Date;
  /** Batch size per iteration (default 50). */
  batchSize?: number;
  /** Maximum batches to scan to guarantee bounded execution (default 1000). */
  maxBatches?: number;
}

export interface ScheduleRecoveryResult {
  /** Number of interrupted schedules found. */
  found: number;
  /** Number of schedules successfully recovered. */
  recovered: number;
  /** IDs of schedules that were recovered (for audit/debug). */
  recoveredIds: string[];
  /** Number of schedules skipped (e.g. state changed concurrently). */
  skipped: number;
  /** Errors encountered during recovery (record-level, non-fatal). */
  errors: Array<{ id: string; error: string }>;
}

/**
 * ScheduleRecoveryService — scans persisted ScheduleStore for records left with an
 * in-progress marker (`lastStartedAt IS NOT NULL`) due to a crash during callback
 * execution, and reconciles them before the scheduler starts.
 *
 * TRANSACTION-SUBMISSION RECOVERY SEMANTICS:
 *   - A process crash mid-callback leaves it indeterminate whether an in-flight
 *     transaction was submitted to or accepted by the Stellar network.
 *   - Recovery deliberately does NOT assume the transaction failed, and does NOT
 *     re-submit or re-trigger the callback, because doing so could cause duplicate
 *     transaction execution (e.g. double spend) if the transaction was already
 *     broadcast or mined.
 *   - Nor does recovery assume successful on-chain finality; it does not fabricate
 *     submission records. On-chain transaction verification and status reconciliation
 *     remain the responsibility of the transaction reconciler / execution store.
 *   - Instead, the scheduler reconciles the schedule occurrence by recording
 *     `lastRunAt: lastStartedAt`, clearing `lastStartedAt: null`, and advancing
 *     `nextRunAt` to the next future occurrence so subsequent scheduler ticks run
 *     only future intervals.
 *
 * CONCURRENCY SAFETY:
 *   - State transitions use compare-and-swap (`updateIfLastStartedAt`) to ensure
 *     concurrent recovery passes or active scheduler workers never overwrite one another.
 *
 * BOUNDED PAGINATION:
 *   - Scans in batches (`batchSize`, default 50) and paginates through all interrupted
 *     schedules so repositories with >50 interrupted records are completely reconciled.
 */
export class ScheduleRecoveryService {
  private now: () => Date;
  private batchSize: number;
  private maxBatches: number;

  constructor(
    private store: ScheduleStore,
    options: ScheduleRecoveryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.batchSize = options.batchSize ?? 50;
    this.maxBatches = options.maxBatches ?? 1000;
  }

  async recover(): Promise<ScheduleRecoveryResult> {
    const result: ScheduleRecoveryResult = {
      found: 0,
      recovered: 0,
      recoveredIds: [],
      skipped: 0,
      errors: [],
    };

    let offset = 0;
    let batchesRun = 0;
    const seenIds = new Set<string>();

    while (batchesRun < this.maxBatches) {
      batchesRun++;
      const batch = await this.store.listInterrupted(this.batchSize, offset);
      if (!batch || batch.length === 0) {
        break;
      }

      let newInBatch = 0;
      const now = this.now();
      const nowIso = now.toISOString();

      for (const record of batch) {
        if (seenIds.has(record.id)) {
          continue;
        }
        seenIds.add(record.id);
        newInBatch++;
        result.found++;

        try {
          const expectedStartedAt = record.lastStartedAt;
          if (!expectedStartedAt) {
            result.skipped++;
            continue;
          }

          // Advance nextRunAt to the next future occurrence
          const exprResult = validateScheduleExpression(
            record.scheduleExpression,
            record.timezone,
            now
          );

          const nextRunAt =
            exprResult.valid && exprResult.nextRunAt && Date.parse(exprResult.nextRunAt) > now.getTime()
              ? exprResult.nextRunAt
              : (exprResult.valid && exprResult.nextRunAt ? exprResult.nextRunAt : null);

          let patch: Partial<typeof record>;

          if (record.status === "active") {
            if (nextRunAt) {
              patch = {
                lastRunAt: expectedStartedAt,
                lastStartedAt: null,
                nextRunAt,
                updatedAt: nowIso,
              };
            } else {
              // Expression cannot produce a valid future occurrence; pause so operator can correct
              patch = {
                lastRunAt: expectedStartedAt,
                lastStartedAt: null,
                status: "paused",
                updatedAt: nowIso,
              };
              console.error(
                `[schedule-recovery] paused schedule ${record.id}: could not compute a future occurrence${exprResult.error ? ` (${exprResult.error})` : ""}`
              );
            }
          } else {
            // Preserve existing paused/disabled status
            patch = {
              lastRunAt: expectedStartedAt,
              lastStartedAt: null,
              ...(nextRunAt ? { nextRunAt } : {}),
              updatedAt: nowIso,
            };
          }

          // Atomic CAS update: only update if lastStartedAt still matches expectedStartedAt
          const updated = await this.store.updateIfLastStartedAt(
            record.id,
            expectedStartedAt,
            patch
          );

          if (!updated) {
            result.skipped++;
            // If the record still has lastStartedAt set, advance offset so next query skips it
            const current = await this.store.get(record.id);
            if (current?.lastStartedAt) {
              offset++;
            }
            continue;
          }

          result.recovered++;
          result.recoveredIds.push(record.id);
        } catch (err) {
          offset++;
          result.errors.push({
            id: record.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (newInBatch === 0 || batch.length < this.batchSize) {
        break;
      }
    }

    return result;
  }
}
