/**
 * Strip any of the given secret values out of a string before it reaches a
 * log sink. Used for top-level error logging, where the underlying HTTP
 * client (or loot-core) occasionally echoes request details -- including
 * ACTUAL_PASSWORD / ACTUAL_BUDGET_ENCRYPTION_PASSWORD -- back into thrown
 * error messages.
 */
export function redactSecrets(message: string, secrets: readonly (string | undefined)[]): string {
  let redacted = message;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function formatActualError(error: unknown): string {
  // loot-core sometimes throws plain objects; String() would yield the
  // useless "[object Object]" our old wrapper was infamous for.
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null
        ? JSON.stringify(error)
        : String(error);

  if (message.includes("unknown problem opening")) {
    return `${message} The local budget cache is likely stale relative to the sync server (this happens after resetting the budget cache or re-uploading the file in the Actual UI). Run the actual_reload_budget tool to delete the cache and re-download.`;
  }

  if (message.includes("No budget file is open")) {
    return `${message} The engine lost its budget file. Run the actual_reload_budget tool.`;
  }

  if (message.toLowerCase().includes("password") || message.toLowerCase().includes("unauthorized")) {
    return `${message} Check ACTUAL_PASSWORD (server login) and, for encrypted files, ACTUAL_BUDGET_ENCRYPTION_PASSWORD.`;
  }

  return `Actual API error: ${message}`;
}
