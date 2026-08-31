/**
 * Warm simulator session loop (M5, architecture §5). A session task is one
 * Fargate engine-runner that, instead of executing a single manifest and
 * exiting, long-polls a per-editing-session SQS queue for `{ runId }` jobs and
 * idles out after a quiet period. The first simulation in an editing session
 * pays the ~33 s Fargate cold start; every tweak-and-rerun after that starts
 * near-instantly on the warm task.
 *
 * This module is the PURE loop — receive/run are injected — so the smoke
 * script can exercise idle-out and job sequencing without AWS. The SQS wiring
 * lives in engine-runner/main.ts (session mode).
 *
 * Semantics:
 * - Jobs run strictly one at a time; queued messages wait (a tweak-and-rerun
 *   editing session is serial by nature).
 * - A job failure is logged and the loop continues: every run writes its own
 *   result.json on failure paths, and a run whose execution crashed entirely
 *   is caught by the 45-minute watchdog exactly like a lost cold task.
 * - Idle-out is measured from the END of the last activity (job or poll).
 */

export interface SessionJob {
  runId: string;
}

export interface SessionLoopDeps {
  /** Long-poll for one job; resolves null when the wait elapsed empty. */
  receive(): Promise<SessionJob | null>;
  runJob(job: SessionJob): Promise<void>;
  idleTimeoutMs: number;
  log?: (message: string) => void;
  now?: () => number;
}

export interface SessionLoopOutcome {
  jobsRun: number;
  jobFailures: number;
  endedReason: 'idle';
}

export async function runSessionLoop(deps: SessionLoopDeps): Promise<SessionLoopOutcome> {
  const log = deps.log ?? ((m: string) => console.log(`session: ${m}`));
  const now = deps.now ?? Date.now;
  let lastActivity = now();
  let jobsRun = 0;
  let jobFailures = 0;
  for (;;) {
    const job = await deps.receive();
    if (job) {
      jobsRun += 1;
      log(`job ${jobsRun}: run ${job.runId}`);
      try {
        await deps.runJob(job);
      } catch (err) {
        jobFailures += 1;
        log(`job for run ${job.runId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      lastActivity = now();
      continue;
    }
    if (now() - lastActivity >= deps.idleTimeoutMs) {
      log(`idle for ${Math.round(deps.idleTimeoutMs / 1000)}s; session ending (${jobsRun} job(s) served)`);
      return { jobsRun, jobFailures, endedReason: 'idle' };
    }
  }
}
