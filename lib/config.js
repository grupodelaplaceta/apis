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
    (process.env.PLACETA_APP_IDS || process.env.PLACETA_APP_ID || "")
      .split(",")
      .map((appId) => appId.trim())
      .filter(Boolean),
  appSecret: () => requiredEnv("PLACETA_APP_SECRET"),
  allowedOrigins: () =>
    (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
};
