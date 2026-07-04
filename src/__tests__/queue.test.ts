import { AsyncBatchQueue } from '../queue';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('AsyncBatchQueue', () => {
  it('delivers already-queued items in FIFO order', async () => {
    const q = new AsyncBatchQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    expect(await q.next()).toBe(1);
    expect(await q.next()).toBe(2);
    expect(await q.next()).toBe(3);
  });

  it('parks next() while idle and wakes it on push (push→pull adapter)', async () => {
    const q = new AsyncBatchQueue<string>();
    let resolved: string | null | undefined;
    const pending = q.next().then((v) => {
      resolved = v;
      return v;
    });
    await tick();
    expect(resolved).toBeUndefined(); // still parked — nothing queued
    q.push('batch');
    await expect(pending).resolves.toBe('batch');
  });

  it('drains queued items after close, then resolves null forever', async () => {
    const q = new AsyncBatchQueue<number>();
    q.push(7);
    q.close();
    expect(await q.next()).toBe(7); // close never loses a queued batch
    expect(await q.next()).toBeNull();
    expect(await q.next()).toBeNull();
  });

  it('wakes a parked next() with null when closed while idle (prompt shutdown)', async () => {
    const q = new AsyncBatchQueue<number>();
    const pending = q.next();
    await tick();
    q.close();
    await expect(pending).resolves.toBeNull();
  });

  it('silently drops pushes after close', async () => {
    const q = new AsyncBatchQueue<number>();
    q.close();
    q.push(9);
    expect(await q.next()).toBeNull();
  });

  it('supports the produce-while-suspended pattern: pushes between next() calls accumulate', async () => {
    const q = new AsyncBatchQueue<number>();
    q.push(1);
    expect(await q.next()).toBe(1);
    // Producer keeps pushing while the consumer is busy elsewhere.
    q.push(2);
    q.push(3);
    q.close();
    expect(await q.next()).toBe(2);
    expect(await q.next()).toBe(3);
    expect(await q.next()).toBeNull();
  });
});
