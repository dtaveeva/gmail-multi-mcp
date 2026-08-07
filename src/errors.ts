/**
 * Errors that are safe to surface verbatim to the model and the user.
 * Anything not wrapped in this type is treated as internal and redacted,
 * so we never leak token material or raw API payloads into a transcript.
 */
export class UserFacingError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "UserFacingError";
    this.hint = hint;
  }
}

export class PermissionError extends UserFacingError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = "PermissionError";
  }
}

export class RateLimitError extends UserFacingError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = "RateLimitError";
  }
}

export class ConfirmationError extends UserFacingError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = "ConfirmationError";
  }
}

/** Render any thrown value as safe tool-result text. */
export function renderError(err: unknown): string {
  if (err instanceof UserFacingError) {
    return err.hint ? `${err.name}: ${err.message}\n\nHint: ${err.hint}` : `${err.name}: ${err.message}`;
  }
  if (err instanceof Error) {
    // Deliberately terse: upstream Google errors can echo request bodies.
    return `Error: ${err.message}`;
  }
  return "Error: unknown failure";
}
