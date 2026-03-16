import chokidar, { type FSWatcher } from "chokidar";
import path from "path";

export type WatchEvent = "add" | "change" | "unlink";

export interface FileWatchHandler {
  (event: WatchEvent, filePath: string): void | Promise<void>;
}

/**
 * Thin wrapper around chokidar for watching state/ directories.
 * The orchestrator uses this to react to sentinel files and
 * drift self-check files written by agents.
 */
export class Watcher {
  readonly #watcher: FSWatcher;

  private constructor(watcher: FSWatcher) {
    this.#watcher = watcher;
  }

  /**
   * Watch one or more glob patterns.
   * @param patterns  Glob patterns to watch (e.g. "state/tasks/**\/*.md")
   * @param handler   Called for each add/change/unlink event
   * @param options   Optional chokidar options (usePolling etc.)
   */
  static create(
    patterns: readonly string[],
    handler: FileWatchHandler,
    options: { usePolling?: boolean; cwd?: string } = {},
  ): Watcher {
    const watcher = chokidar.watch([...patterns], {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
      usePolling: options.usePolling ?? false,
      cwd: options.cwd ?? process.cwd(),
    });

    const handle = (event: WatchEvent) => (rawPath: string): void => {
      const resolved = options.cwd
        ? path.resolve(options.cwd, rawPath)
        : path.resolve(rawPath);
      void Promise.resolve(handler(event, resolved)).catch((err: unknown) => {
        console.error(`[Watcher] handler error for ${event} ${resolved}:`, err);
      });
    };

    watcher
      .on("add", handle("add"))
      .on("change", handle("change"))
      .on("unlink", handle("unlink"))
      .on("error", (err: unknown) => {
        console.error("[Watcher] chokidar error:", err);
      });

    return new Watcher(watcher);
  }

  /** Stop watching and release resources. */
  async close(): Promise<void> {
    await this.#watcher.close();
  }
}
