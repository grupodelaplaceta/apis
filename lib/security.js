import crypto from "crypto";
import { config } from "./config.js";
import { nonceCollection } from "./mongo.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value || "", "utf8").digest("hex");
}

function timingSafeEqualHex(left, right) {
  const a = Buffer.from(left || "", "hex");
  const b = Buffer.from(right || "", "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function assertRequestAllowed(req, body) {
  assertOrigin(req);

  const appId = req.headers["x-placeta-app-id"];
  const timestamp = req.headers["x-placeta-timestamp"];
  const nonce = req.headers["x-placeta-nonce"];
  const signature = req.headers["x-placeta-signature"];

  if (!config.appIds().includes(appId)) throwHttp(401, "invalid_app_id");
  if (!timestamp || !nonce || !signature) throwHttp(401, "missing_signature_headers");

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs)) throwHttp(401, "invalid_timestamp");
  if (Math.abs(Date.now() - timestampMs) > FIVE_MINUTES_MS) throwHttp(401, "stale_timestamp");

  const path = req.url.split("?")[0];
  const bodyHash = sha256Hex(body);
  const signedPayload = [req.method, path, timestamp, nonce, bodyHash].join("\n");
  const validSignature = config.appSecrets().some((secret) => {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(signedPayload, "utf8")
      .digest("hex");
    return timingSafeEqualHex(expected, signature);
  });

  if (!validSignature) throwHttp(401, "invalid_signature");
  await rememberNonce(appId, nonce);
}

function assertOrigin(req) {
  const allowed = config.allowedOrigins();
  const origin = req.headers.origin;
  if (!origin) return;
  if (allowed.length === 0 && process.env.NODE_ENV === "production") throwHttp(403, "origin_policy_not_configured");
  if (allowed.length === 0) return;
  if (!allowed.includes(origin)) throwHttp(403, "origin_not_allowed");
}

async function rememberNonce(appId, nonce) {
  try {
    const collection = await nonceCollection();
    await collection.insertOne({
      appId,
      nonce,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + FIVE_MINUTES_MS)
    });
  } catch (error) {
    if (error?.code === 11000) throwHttp(401, "replayed_nonce");
    throw error;
  }
}

export function throwHttp(statusCode, error) {
  const exception = new Error(error);
  exception.statusCode = statusCode;
  throw exception;
}
