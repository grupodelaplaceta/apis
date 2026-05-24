export function requiredEnv(name) {
  const value = process.env[name];
  if (value == null) {
    throw new Error(`Missing env var ${name}`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Empty env var ${name}`);
  }
  return trimmed;
}

export const config = {
  mongoUri: () => requiredEnv("MONGODB_URI"),
  dbName: () => process.env.MONGODB_DB || "TestBanco",
  stateCollection: () => process.env.MONGODB_STATE_COLLECTION || "bank_state",
  nonceCollection: () => process.env.MONGODB_NONCE_COLLECTION || "api_nonces",
  appIds: () =>
    [process.env.PLACETA_APP_IDS, process.env.PLACETA_APP_ID]
      .filter(Boolean)
      .join(",")
      .split(",")
      .map((appId) => appId.trim())
      .filter(Boolean),
  appSecrets: () => {
    const raw = [process.env.PLACETA_APP_SECRETS, process.env.PLACETA_APP_SECRET, process.env.PLACETA_API_SECRET]
      .filter(Boolean)
      .join(",");
    if (!raw) {
      throw new Error("Missing env var PLACETA_APP_SECRET or PLACETA_API_SECRET");
    }
    const secrets = raw
      .split(",")
      .map((secret) => secret.trim())
      .filter(Boolean);
    if (secrets.length === 0) {
      throw new Error("Empty env var PLACETA_APP_SECRET or PLACETA_API_SECRET");
    }
    return secrets;
  },
  placetaIdJwtSecrets: () =>
    [process.env.PLACETA_ID_JWT_SECRETS, process.env.PLACETA_ID_JWT_SECRET, process.env.JWT_SECRET]
      .filter(Boolean)
      .join(",")
      .split(",")
      .map((secret) => secret.trim())
      .filter(Boolean),
  allowedOrigins: () =>
    (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
};
