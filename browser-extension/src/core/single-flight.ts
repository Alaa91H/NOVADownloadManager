/**
 * Deduplicates concurrent calls to the same async operation.
 * If `run()` is called while a previous invocation is still in-flight,
 * the same promise is returned instead of starting a second one.
 * Once the promise settles, the next call will start fresh.
 */
export class SingleFlight<TResult> {
  private current?: Promise<TResult>;

  run(factory: () => Promise<TResult>): Promise<TResult> {
    if (this.current) return this.current;
    this.current = factory().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }

  get active(): boolean {
    return Boolean(this.current);
  }
}
