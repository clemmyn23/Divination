export interface RunningJob {
  name: string;
  startedAt: number;
}

export interface FinishedJob {
  name: string;
  ok: boolean;
  error?: string;
  finishedAt: number;
}

/**
 * One background job at a time. A second job offered while one runs is refused, which is
 * what stops a double-pressed button from calling the LLM twice. The last result is kept
 * so the page can show what happened.
 */
export function createJobs(now: () => number) {
  let current: RunningJob | null = null;
  let last: FinishedJob | null = null;

  return {
    /** Start `fn` in the background. Returns false, without calling it, while another job runs. */
    run(name: string, fn: () => unknown): boolean {
      if (current !== null) return false;
      current = { name, startedAt: now() };
      // The job starts straight away; a throw before its first await is caught like any other failure.
      let work: Promise<unknown>;
      try {
        work = Promise.resolve(fn());
      } catch (e) {
        work = Promise.reject(e);
      }
      work
        .then(
          () => {
            last = { name, ok: true, finishedAt: now() };
          },
          (e: unknown) => {
            last = { name, ok: false, error: e instanceof Error ? e.message : String(e), finishedAt: now() };
          },
        )
        .finally(() => {
          current = null;
        });
      return true;
    },
    current: () => current,
    last: () => last,
  };
}
