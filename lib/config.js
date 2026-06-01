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

function splitEnvList(...values) {
  return values
    .filter(Boolean)
    .join(",")
    .split(/[,\r\n]+/)
    .map((value) => String(value || "").trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

export const config = {
  mongoUri: () => requiredEnv("MONGODB_URI"),
  dbName: () => process.env.MONGODB_DB || "TestBanco",
  stateCollection: () => process.env.MONGODB_STATE_COLLECTION || "bank_state",
  nonceCollection: () => process.env.MONGODB_NONCE_COLLECTION || "api_nonces",
  appIds: () => splitEnvList(process.env.PLACETA_APP_IDS, process.env.PLACETA_APP_ID),
  appSecrets: () => {
    const raw = [process.env.PLACETA_APP_SECRETS, process.env.PLACETA_API_SECRETS, process.env.PLACETA_APP_SECRET, process.env.PLACETA_API_SECRET]
      .filter(Boolean)
      .join(",");
    if (!raw) {
      throw new Error("Missing env var PLACETA_APP_SECRET or PLACETA_API_SECRET");
    }
    const secrets = splitEnvList(raw);
    if (secrets.length === 0) {
      throw new Error("Empty env var PLACETA_APP_SECRET or PLACETA_API_SECRET");
    }
    return secrets;
  },
  placetaIdJwtSecrets: () => splitEnvList(process.env.PLACETA_ID_JWT_SECRETS, process.env.PLACETA_ID_JWT_SECRET, process.env.JWT_SECRET),
  allowedOrigins: () => splitEnvList(process.env.ALLOWED_ORIGINS)
};
