/**
 * Elimina claves vacías y nulas en profundidad para evitar el error
 * "Empty key" de MongoDB (MongoServerError: key must not be empty string).
 * 
 * Además elimina valores null/undefined que MongoDB no acepta en updates.
 */
export function stripEmptyMongoKeys(value) {
  if (Array.isArray(value)) {
    const mapped = value.map(stripEmptyMongoKeys);
    return mapped.filter(v => v !== null && v !== undefined);
  }

  if (!value || typeof value !== "object" || value instanceof Date || value instanceof RegExp) {
    return value;
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    // Saltar claves vacías o nulas
    if (!key || key.trim() === "" || key === null || key === undefined) continue;
    // Saltar valores null/undefined
    if (entry === null || entry === undefined) continue;
    const cleaned = stripEmptyMongoKeys(entry);
    if (cleaned !== null && cleaned !== undefined) {
      // No guardar objetos vacíos a menos que sea un array
      if (typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) continue;
      result[key] = cleaned;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
