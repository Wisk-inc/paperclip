/**
 * Slows down guessing of share codes. Each client (and everyone together)
 * gets a number of failed joins per window; past that, joins answer 429
 * until the oldest failure leaves the window. A successful join clears the
 * client's failures. Behind the collaborator gateway every request looks
 * local, so the per-client key comes from the tunnel's client address
 * (cf-connecting-ip) when there is one.
 */
export interface AttemptLimiterOptions {
  windowMs: number;
  perKey: number;
  total: number;
  now?: () => number;
}

export interface AttemptGate {
  allowed: boolean;
  /** Seconds until a refused client may try again. */
  retryAfterSeconds: number;
}

export class AttemptLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly options: AttemptLimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  check(key: string): AttemptGate {
    const now = this.now();
    const mine = this.prune(key, now);
    const everyone = this.prune(TOTAL_KEY, now);
    // Forget idle clients so the map never grows without bound.
    if (mine.length === 0) this.failures.delete(key);
    if (mine.length < this.options.perKey && everyone.length < this.options.total) return { allowed: true, retryAfterSeconds: 0 };
    const oldest = Math.min(
      mine.length >= this.options.perKey ? mine[0]! : Number.POSITIVE_INFINITY,
      everyone.length >= this.options.total ? everyone[0]! : Number.POSITIVE_INFINITY,
    );
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.options.windowMs - now) / 1000)) };
  }

  recordFailure(key: string) {
    const now = this.now();
    this.prune(key, now).push(now);
    this.prune(TOTAL_KEY, now).push(now);
  }

  recordSuccess(key: string) {
    this.failures.delete(key);
  }

  private prune(key: string, now: number): number[] {
    const cutoff = now - this.options.windowMs;
    let list = this.failures.get(key);
    if (!list) {
      list = [];
      this.failures.set(key, list);
    }
    while (list.length && list[0]! <= cutoff) list.shift();
    return list;
  }
}

const TOTAL_KEY = "*";

/** The client address a join came from: the tunnel's, when the request came through one. */
export function joinLimiterKey(input: { header(name: string): string | undefined; ip?: string }): string {
  return input.header("cf-connecting-ip")?.trim() || input.ip || "unknown";
}
