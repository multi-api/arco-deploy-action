import { describe, expect, it, vi } from 'vitest';
import { Batcher } from '../src/batcher';

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
});
