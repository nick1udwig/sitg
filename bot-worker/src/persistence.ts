import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ScheduledDeadline } from "./types.js";

type RepoInstallation = {
  installationId: number;
  fullName?: string;
  updatedAt: string;
};

type BotState = {
  version: 1;
  dedupKeys: Record<string, number>;
  deadlines: Record<string, ScheduledDeadline>;
  repoInstallations: Record<string, RepoInstallation>;
};

const emptyState = (): BotState => ({
  version: 1,
  dedupKeys: {},
  deadlines: {},
  repoInstallations: {},
});

export class BotStateStore {
  private readonly path: string;
  private state: BotState;

  constructor(path: string) {
    this.path = path;
    this.state = this.load();
  }

  getPendingDeadlines(): ScheduledDeadline[] {
    return Object.values(this.state.deadlines);
  }

  putDeadline(deadline: ScheduledDeadline): void {
    this.state.deadlines[deadline.challengeId] = deadline;
    this.flush();
  }

  removeDeadline(challengeId: string): void {
    if (!this.state.deadlines[challengeId]) {
      return;
    }
    delete this.state.deadlines[challengeId];
    this.flush();
  }

  hasDedupKey(key: string): boolean {
    this.gcDedup();
    return key in this.state.dedupKeys;
  }

  putDedupKey(key: string, ttlMs: number): void {
    this.gcDedup();
    this.state.dedupKeys[key] = Date.now() + ttlMs;
    this.flush();
  }

  rememberRepoInstallation(repoId: number, installationId: number, fullName?: string): void {
    this.state.repoInstallations[String(repoId)] = {
      installationId,
      fullName,
      updatedAt: new Date().toISOString(),
    };
    this.flush();
  }

  getRepoInstallation(repoId: number): RepoInstallation | null {
    return this.state.repoInstallations[String(repoId)] ?? null;
  }

  private gcDedup(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, expiresAt] of Object.entries(this.state.dedupKeys)) {
      if (expiresAt <= now) {
        delete this.state.dedupKeys[key];
        changed = true;
      }
    }
    if (changed) {
      this.flush();
    }
  }

  private load(): BotState {
    try {
      const content = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(content) as Partial<BotState>;
      return {
        version: 1,
        dedupKeys: parsed.dedupKeys ?? {},
        deadlines: parsed.deadlines ?? {},
        repoInstallations: parsed.repoInstallations ?? {},
      };
    } catch {
      return emptyState();
    }
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmpPath = `${this.path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.state));
    renameSync(tmpPath, this.path);
  }
}
