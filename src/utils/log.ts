/**
 * Logging utility for the Adobe OCR plugin.
 *
 * Wraps Zotero.debug() with a consistent prefix and maps semantic log
 * levels to Zotero's numeric scale. All plugin modules should import
 * from here rather than calling Zotero.debug() directly.
 */

const PREFIX = "[Adobe OCR]";

/**
 * Log at info level (3) -- normal operational flow.
 *
 * Use for: pipeline start/end, per-item outcomes, lifecycle events.
 *
 * @param msg - The message to log.
 */
export function logInfo(msg: string): void {
  Zotero.debug(`${PREFIX} ${msg}`, 3);
}

/**
 * Log at warn level (2) -- recoverable issues and fallbacks.
 *
 * Use for: token refresh, missing optional data, degraded behavior.
 *
 * @param msg - The message to log.
 */
export function logWarn(msg: string): void {
  Zotero.debug(`${PREFIX} ${msg}`, 2);
}

/**
 * Log at error level (1) and report to the Zotero Error Console.
 *
 * Always pass the original error when available so the stack trace
 * is preserved in the Error Console.
 *
 * @param msg - A contextual message describing what failed.
 * @param err - The original error, if available.
 */
export function logError(msg: string, err?: Error): void {
  Zotero.debug(`${PREFIX} ${msg}`, 1);
  if (err) {
    Zotero.logError(err);
  }
}

/**
 * Log at debug level (4) -- detailed operational info.
 *
 * Use for: API call boundaries, HTTP status codes, step transitions.
 *
 * @param msg - The message to log.
 */
export function logDebug(msg: string): void {
  Zotero.debug(`${PREFIX} ${msg}`, 4);
}

/**
 * Log at trace level (5) -- maximum verbosity.
 *
 * Use for: polling iterations, response sizes, data that is only
 * useful when actively investigating a specific issue.
 *
 * @param msg - The message to log.
 */
export function logTrace(msg: string): void {
  Zotero.debug(`${PREFIX} ${msg}`, 5);
}
