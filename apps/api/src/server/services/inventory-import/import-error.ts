/**
 * Normalizes any thrown value into the small, typed shape the import pipeline
 * reports back to users and logs. Postgres details can be attached to the error
 * itself, to its `cause` (how Drizzle wraps driver errors), or to a
 * `driverError` property, so the chain is walked once and the first value found
 * for each field wins.
 */

interface PostgresErrorFields {
  code?: string;
  detail?: string;
  hint?: string;
  constraint?: string;
  table?: string;
  column?: string;
  schema?: string;
}

interface ErrorChainLink extends PostgresErrorFields {
  message?: string;
  cause?: unknown;
  driverError?: unknown;
}

export interface ImportError extends PostgresErrorFields {
  message: string;
  stack?: string;
}

const POSTGRES_FIELDS = ['code', 'detail', 'hint', 'constraint', 'table', 'column', 'schema'] as const;

function asChainLink(value: unknown): ErrorChainLink | undefined {
  return value && typeof value === 'object' ? (value as ErrorChainLink) : undefined;
}

export function toImportError(err: unknown): ImportError {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }

  const result: ImportError = { message: err.message, stack: err.stack };

  const pending: unknown[] = [err];
  const visited = new Set<unknown>();
  while (pending.length) {
    const link = asChainLink(pending.shift());
    if (!link || visited.has(link)) continue;
    visited.add(link);

    for (const field of POSTGRES_FIELDS) {
      if (result[field] === undefined && typeof link[field] === 'string') {
        result[field] = link[field];
      }
    }

    pending.push(link.cause, link.driverError);
  }

  return result;
}

/** Single-line summary shown to the user for a failed row. */
export function describeImportError(error: ImportError): string {
  return [
    error.message,
    error.code ? `code=${error.code}` : null,
    error.constraint ? `constraint=${error.constraint}` : null,
    error.detail ?? null,
    error.hint ?? null,
  ]
    .filter(Boolean)
    .join(' | ');
}
