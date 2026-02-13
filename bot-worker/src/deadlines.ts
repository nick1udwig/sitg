import type { ScheduledDeadline } from "./types.js";

type TriggerFn = (challengeId: string) => Promise<void>;

type ScheduledTask = {
  timeout: NodeJS.Timeout;
  context: ScheduledDeadline;
};

export class DeadlineScheduler {
  private readonly trigger: TriggerFn;
  private readonly tasks = new Map<string, ScheduledTask>();

  constructor(trigger: TriggerFn) {
    this.trigger = trigger;
  }

  ensure(context: ScheduledDeadline): void {
    if (this.tasks.has(context.challengeId)) {
      return;
    }

    const delayMs = Math.max(0, new Date(context.deadlineAt).getTime() - Date.now());
    const timeout = setTimeout(async () => {
      try {
        await this.trigger(context.challengeId);
      } finally {
        this.tasks.delete(context.challengeId);
      }
    }, delayMs);
    timeout.unref?.();
    this.tasks.set(context.challengeId, { timeout, context });
  }

  get(challengeId: string): ScheduledDeadline | null {
    return this.tasks.get(challengeId)?.context ?? null;
  }

  cancel(challengeId: string): void {
    const existing = this.tasks.get(challengeId);
    if (!existing) {
      return;
    }
    clearTimeout(existing.timeout);
    this.tasks.delete(challengeId);
  }
}
