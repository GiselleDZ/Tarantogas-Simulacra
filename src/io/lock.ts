import { promises as fs } from "fs";
import path from "path";

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 50;

/**
 * Advisory lock using a `.lock` sentinel file.
 *
 * Callers acquire the lock before mutating shared state files and
 * release it when done. If the lock is held for longer than
 * LOCK_TIMEOUT_MS (e.g. a crashed process), it is treated as stale
 * and forcibly released.
 */
export class FileLock {
  readonly #lockPath: string;

  constructor(targetPath: string) {
    this.#lockPath = `${targetPath}.lock`;
  }

  /**
   * Acquire the lock, waiting up to LOCK_TIMEOUT_MS.
   * Throws if the lock cannot be acquired within the timeout.
   */
  async acquire(): Promise<void> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (await this.#tryAcquire()) {
        return;
      }
      await sleep(LOCK_POLL_MS);
    }

    // Stale lock — forcibly remove and acquire
    await this.#forceRelease();
    if (!await this.#tryAcquire()) {
      throw new Error(`Failed to acquire lock: ${this.#lockPath}`);
    }
  }

  /** Release the lock. Safe to call even if not currently held. */
  async release(): Promise<void> {
    await fs.unlink(this.#lockPath).catch(() => undefined);
  }

  /**
   * Run fn while holding the lock. Always releases the lock on exit,
   * even if fn throws.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  async #tryAcquire(): Promise<boolean> {
    try {
      const dir = path.dirname(this.#lockPath);
      await fs.mkdir(dir, { recursive: true });
      // O_EXCL ensures only one process creates the file
      const handle = await fs.open(this.#lockPath, "wx");
      await handle.writeFile(String(process.pid), "utf-8");
      await handle.close();
      return true;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "EEXIST") {
        return false;
      }
      throw err;
    }
  }

  async #forceRelease(): Promise<void> {
    await fs.unlink(this.#lockPath).catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
