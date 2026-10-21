import type { LogsPayload } from './api';

export interface BatcherOptions {
  send: (payload: LogsPayload) => Promise<void>;
  intervalMs?: number;
  maxItems?: number;
  retries?: number;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  redact?: (text: string) => string;
  onError?: (message: string) => void;
}

/** Buffers log lines and events; flushes every `intervalMs` or `maxItems` lines, in order, with increasing seq. */
export class Batcher {
  private lines: string[] = [];
  private events: unknown[] = [];
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly o: Required<Omit<BatcherOptions, 'onError'>> & Pick<BatcherOptions, 'onError'>;

  constructor(options: BatcherOptions) {
    this.o = {
      intervalMs: 2000,
      maxItems: 200,
      retries: 3,
      backoffMs: (attempt) => 500 * 2 ** attempt,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      redact: (t) => t,
      ...options,
    };
  }

  addLine(line: string): void {
    this.lines.push(this.o.redact(line));
    this.afterAdd();
  }

  addEvent(event: unknown): void {
    this.events.push(JSON.parse(this.o.redact(JSON.stringify(event))));
    this.afterAdd();
  }

  private afterAdd(): void {
    if (this.lines.length + this.events.length >= this.o.maxItems) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.o.intervalMs);
    }
  }

  /** Queues the pending batch; resolves once every queued batch has been delivered or given up. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.lines.length > 0 || this.events.length > 0) {
      const payload: LogsPayload = { seq: ++this.seq, lines: this.lines, events: this.events };
      this.lines = [];
      this.events = [];
      this.chain = this.chain.then(() => this.deliver(payload));
    }
    return this.chain;
  }

  private async deliver(payload: LogsPayload): Promise<void> {
    const attempts = this.o.retries + 1; // the first try plus `retries` retries, same seq each time
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.o.send(payload);
        return;
      } catch (e) {
        if (attempt === attempts - 1) {
          this.o.onError?.(`Dropping log batch ${payload.seq}: ${(e as Error).message}`);
          return;
        }
        await this.o.sleep(this.o.backoffMs(attempt));
      }
    }
  }
}
