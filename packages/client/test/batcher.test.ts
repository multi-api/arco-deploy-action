import { describe, expect, it, vi } from 'vitest';
import { Batcher } from '../src/batcher.js';

describe('Batcher', () => {
  it('flushes on the interval', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => {});
    const b = new Batcher({ send, intervalMs: 2000 });
    b.addLine('a');
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledWith({ seq: 1, lines: ['a'], events: [] });
    vi.useRealTimers();
  });

  it('flushes at 200 lines', async () => {
    const send = vi.fn(async () => {});
    const b = new Batcher({ send });
    for (let i = 0; i < 200; i++) b.addLine(String(i));
    await b.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as any)[0].lines).toHaveLength(200);
  });

  it('retries with the same seq and backs off', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined);
    const sleep = vi.fn(async () => {});
    const b = new Batcher({ send, sleep });
    b.addLine('a');
    await b.flush();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map((c: any) => c[0].seq)).toEqual([1, 1, 1]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('queues an empty keep-alive batch when nothing was sent for keepAliveMs, and stops on close', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => {});
    const b = new Batcher({ send, keepAliveMs: 60000 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ seq: 1, lines: [], events: [] });
    await vi.advanceTimersByTimeAsync(60000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ seq: 2, lines: [], events: [] });
    await b.close();
    await vi.advanceTimersByTimeAsync(300000);
    expect(send).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not send keep-alive while real batches keep going out', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => {});
    const b = new Batcher({ send, keepAliveMs: 60000, intervalMs: 1000 });
    for (let i = 0; i < 5; i++) {
      b.addLine('x');
      await vi.advanceTimersByTimeAsync(30000);
    }
    expect(send.mock.calls.every((c: any) => c[0].lines.length === 1)).toBe(true);
    await b.close();
    vi.useRealTimers();
  });
});
