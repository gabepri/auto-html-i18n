import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Queue } from '../src/Queue';
import type { QueueConfig, TranslationItem } from '../src/types';

function makeItem(masked: string): TranslationItem {
  return { masked, original: masked, variables: [] };
}

describe('Queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('enqueue and debouncing', () => {
    it('should not flush immediately on enqueue', () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });
      queue.enqueue(makeItem('Hello'));
      expect(onFlush).not.toHaveBeenCalled();
    });

    it('should flush after debounceTime elapses', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });
      queue.enqueue(makeItem('Hello'));

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith([makeItem('Hello')]);
    });

    it('should reset debounce timer on subsequent enqueues', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      queue.enqueue(makeItem('Hello'));
      vi.advanceTimersByTime(150);
      expect(onFlush).not.toHaveBeenCalled();

      queue.enqueue(makeItem('World'));
      vi.advanceTimersByTime(150);
      expect(onFlush).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);
      await vi.runAllTimersAsync();

      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith(
        expect.arrayContaining([makeItem('Hello'), makeItem('World')])
      );
    });

    it('should batch all items enqueued within debounce window', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      queue.enqueue(makeItem('A'));
      queue.enqueue(makeItem('B'));
      queue.enqueue(makeItem('C'));

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush.mock.calls[0]![0]).toHaveLength(3);
    });
  });

  describe('batching', () => {
    it('should split items into maxBatchSize chunks', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      for (let i = 0; i < 120; i++) {
        queue.enqueue(makeItem(`item-${i}`));
      }

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(onFlush).toHaveBeenCalledTimes(3);
      expect(onFlush.mock.calls[0]![0]).toHaveLength(50);
      expect(onFlush.mock.calls[1]![0]).toHaveLength(50);
      expect(onFlush.mock.calls[2]![0]).toHaveLength(20);
    });
  });

  describe('deduplication', () => {
    it('should deduplicate items with the same masked key', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      queue.enqueue(makeItem('Hello'));
      queue.enqueue(makeItem('Hello'));
      queue.enqueue(makeItem('Hello'));

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush.mock.calls[0]![0]).toHaveLength(1);
    });

    it('should keep items with different masked keys', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      queue.enqueue(makeItem('Hello'));
      queue.enqueue(makeItem('World'));

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush.mock.calls[0]![0]).toHaveLength(2);
    });
  });

  describe('flush()', () => {
    it('should immediately flush without waiting for debounce', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      queue.enqueue(makeItem('Hello'));
      await queue.flush();

      expect(onFlush).toHaveBeenCalledTimes(1);
    });

    it('should cancel pending debounce timer', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      queue.enqueue(makeItem('Hello'));
      await queue.flush();

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      // Should only have been called once (from flush), not twice
      expect(onFlush).toHaveBeenCalledTimes(1);
    });

    it('should be a no-op if queue is empty', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      await queue.flush();
      expect(onFlush).not.toHaveBeenCalled();
    });
  });

  describe('clear()', () => {
    it('should discard all pending items', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      queue.enqueue(makeItem('Hello'));
      queue.clear();

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(onFlush).not.toHaveBeenCalled();
    });

    it('should cancel debounce timer', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      queue.enqueue(makeItem('Hello'));
      queue.clear();

      vi.advanceTimersByTime(500);
      await vi.runAllTimersAsync();

      expect(onFlush).not.toHaveBeenCalled();
    });
  });

  describe('pending count', () => {
    it('should reflect current queue size', () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      expect(queue.pending).toBe(0);
      queue.enqueue(makeItem('Hello'));
      expect(queue.pending).toBe(1);
      queue.enqueue(makeItem('World'));
      expect(queue.pending).toBe(2);
    });

    it('should reset to 0 after flush', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      queue.enqueue(makeItem('Hello'));
      expect(queue.pending).toBe(1);

      await queue.flush();
      expect(queue.pending).toBe(0);
    });

    it('should not count duplicates', () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      queue.enqueue(makeItem('Hello'));
      queue.enqueue(makeItem('Hello'));
      expect(queue.pending).toBe(1);
    });
  });

  describe('error handling', () => {
    it('should not throw if onFlush throws', async () => {
      const onFlush = vi.fn().mockRejectedValue(new Error('Network error'));
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      queue.enqueue(makeItem('Hello'));

      // Should not throw
      await expect(queue.flush()).resolves.toBeUndefined();
    });

    it('should clear items even if onFlush throws', async () => {
      const onFlush = vi.fn().mockRejectedValue(new Error('Network error'));
      const queue = new Queue({ debounceTime: 200, maxBatchSize: 50, onFlush });

      queue.enqueue(makeItem('Hello'));
      await queue.flush();

      expect(queue.pending).toBe(0);
    });
  });
});
