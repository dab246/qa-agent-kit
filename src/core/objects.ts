/** Drops keys whose value is undefined, so optional fields stay absent from records and JSON. */
export function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
