import type { QueueConfig, TranslationItem } from './types';

export class Queue {
  private items = new Map<string, TranslationItem>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private debounceTime: number;
  private maxBatchSize: number;
  private onFlush: (items: TranslationItem[]) => Promise<void>;

  constructor(config: QueueConfig) {
    this.debounceTime = config.debounceTime;
    this.maxBatchSize = config.maxBatchSize;
    this.onFlush = config.onFlush;
  }

  enqueue(item: TranslationItem): void {
    this.items.set(item.masked, item);
    this.restartTimer();
  }

  async flush(): Promise<void> {
    this.cancelTimer();

    if (this.items.size === 0) {
      return;
    }

    const allItems = Array.from(this.items.values());
    this.items.clear();

    // Split into chunks and flush sequentially
    for (let i = 0; i < allItems.length; i += this.maxBatchSize) {
      const chunk = allItems.slice(i, i + this.maxBatchSize);
      try {
        await this.onFlush(chunk);
      } catch {
        // Log but don't re-throw to prevent breaking the observation pipeline
        console.error('auto-html-i18n: onFlush error');
      }
    }
  }

  clear(): void {
    this.cancelTimer();
    this.items.clear();
  }

  get pending(): number {
    return this.items.size;
  }

  private restartTimer(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.debounceTime);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
