/**
 * Concurrent identical reads share one in-flight promise.
 * The producer starts on a microtask so callers in the same turn can join.
 */
export class SingleFlight {
  private readonly inflight = new Map<string, Promise<unknown>>();

  has(key: string): boolean {
    return this.inflight.has(key);
  }

  do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = Promise.resolve().then(fn);
    this.inflight.set(key, promise);
    const clear = () => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    };
    promise.then(clear, clear);
    return promise;
  }
}

/** Serializes writers (and cache misses) per key without blocking L1 hits. */
export class KeyMutex {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, gate);
    const done = prev.then(() => fn());
    const finish = () => {
      release();
      if (this.tails.get(key) === gate) this.tails.delete(key);
    };
    done.then(finish, finish);
    return done;
  }
}
