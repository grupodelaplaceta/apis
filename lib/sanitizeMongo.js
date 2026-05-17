export function stripEmptyMongoKeys(value) {
  if (Array.isArray(value)) {
    return value.map(stripEmptyMongoKeys);
  }

  if (!value || typeof value !== "object" || value instanceof Date) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key.trim() !== "")
      .map(([key, entry]) => [key, stripEmptyMongoKeys(entry)])
  );
}
