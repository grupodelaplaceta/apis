export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var ${name}`);
  }
  return value;
}

export const config = {
  mongoUri: () => requiredEnv("MONGODB_URI"),
  dbName: () => process.env.MONGODB_DB || "TestBanco",
  stateCollection: () => process.env.MONGODB_STATE_COLLECTION || "bank_state",
  nonceCollection: () => process.env.MONGODB_NONCE_COLLECTION || "api_nonces",
  appId: () => requiredEnv("PLACETA_APP_ID"),
  appSecret: () => requiredEnv("PLACETA_APP_SECRET"),
  allowedOrigins: () =>
    (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
};
