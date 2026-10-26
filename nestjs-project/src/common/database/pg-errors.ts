import { QueryFailedError } from 'typeorm';

export const PG_UNIQUE_VIOLATION = '23505';

interface PgDriverError {
  code?: string;
  detail?: string;
}

/** True when `err` is a PostgreSQL unique violation whose detail mentions `column`. */
export function isPgUniqueViolationOnColumn(
  err: unknown,
  column: string,
): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err.driverError as PgDriverError;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}
