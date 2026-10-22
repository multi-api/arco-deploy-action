import type { LogsPayload } from './api.js';
import { redactValue } from './redactor.js';

export interface BatcherOptions {
  send: (payload: LogsPayload) => Promise<void>;
  intervalMs?: number;
  maxItems?: number;
  retries?: number;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  redact?: (text: string) => string;
  /** When set, an empty batch is queued after this long without any batch, so the lease stays alive. */
  keepAliveMs?: number;
  onError?: (message: string) => void;
  /** When true for a send error, delivery stops for good (no retry, later batches are discarded) and onAbort runs once. */
  isFatal?: (error: unknown) => boolean;
  onAbort?: (error: unknown) => void;
}

/** Buffers log lines and events; flushes every `intervalMs` or `maxItems` lines, in order, with increasing seq. */
export class Batcher {
  private lines: string[] = [];
  private events: unknown[] = [];
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private aborted = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly o: Required<Omit<BatcherOptions, 'onError' | 'isFatal' | 'onAbort' | 'keepAliveMs'>> & Pick<BatcherOptions, 'onError' | 'isFatal' | 'onAbort' | 'keepAliveMs'>;

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
    this.armKeepAlive();
  }

  addLine(line: string): void {
    if (this.aborted) return;
    this.lines.push(this.o.redact(line));
    this.afterAdd();
  }

  addEvent(event: unknown): void {
    if (this.aborted) return;
    this.events.push(redactValue(event, this.o.redact));
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
      this.enqueue(payload);
    }
    return this.chain;
  }

  /** Flushes what is pending and stops every timer. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.keepAliveTimer) {
      clearTimeout(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    await this.flush();
  }

  private enqueue(payload: LogsPayload): void {
    this.chain = this.chain.then(() => this.deliver(payload));
    this.armKeepAlive();
  }

  private armKeepAlive(): void {
    if (this.keepAliveTimer) clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = null;
    const ms = this.o.keepAliveMs;
    if (!ms || this.closed || this.aborted) return;
    this.keepAliveTimer = setTimeout(() => {
      this.keepAliveTimer = null;
      // Fold anything pending into the keep-alive batch rather than sending an empty one next to it.
      if (this.timer) {
        this.flush();
      } else {
        this.enqueue({ seq: ++this.seq, lines: [], events: [] });
      }
    }, ms);
    this.keepAliveTimer.unref();
  }

  private async deliver(payload: LogsPayload): Promise<void> {
    if (this.aborted) return;
    const attempts = this.o.retries + 1; // the first try plus `retries` retries, same seq each time
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.o.send(payload);
        return;
      } catch (e) {
        if (this.o.isFatal?.(e)) {
          this.aborted = true;
          this.lines = [];
          this.events = [];
          if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
          }
          if (this.keepAliveTimer) {
            clearTimeout(this.keepAliveTimer);
            this.keepAliveTimer = null;
          }
          this.o.onAbort?.(e);
          return;
        }
        if (attempt === attempts - 1) {
          this.o.onError?.(`Dropping log batch ${payload.seq}: ${(e as Error).message}`);
          return;
        }
        await this.o.sleep(this.o.backoffMs(attempt));
      }
    }
  }
}
