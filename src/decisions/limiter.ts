const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RequestLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly starts: number[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxRequestsPerMinute: number,
  ) {
    if (concurrency < 1 || maxRequestsPerMinute < 1) throw new Error('Limiter values must be positive');
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      await this.awaitRateSlot();
      return await operation();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
  }

  private async awaitRateSlot(): Promise<void> {
    while (true) {
      const now = Date.now();
      while (this.starts.length && this.starts[0]! <= now - 60_000) this.starts.shift();
      if (this.starts.length < this.maxRequestsPerMinute) {
        this.starts.push(now);
        return;
      }
      await sleep(Math.max(1, this.starts[0]! + 60_000 - now));
    }
  }
}
