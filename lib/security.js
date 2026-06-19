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

function signedPathCandidates(req) {
  const rawPath = String(req.url || "").split("?")[0] || "/api/state";
  const candidates = new Set([rawPath]);
  try {
    candidates.add(new URL(req.url, `https://${req.headers.host || "api.banco.laplaceta.org"}`).pathname);
  } catch {}
  if (rawPath.endsWith("/")) candidates.add(rawPath.replace(/\/+$/, "") || "/");
  else candidates.add(`${rawPath}/`);
  candidates.add("/api/state");
  return [...candidates];
}

export async function assertRequestAllowed(req, res, body) {
  assertOrigin(req);

  if (await assertPlacetaIdBearer(req, res)) return;

  const appId = req.headers["x-placeta-app-id"];
  if (!config.appIds().includes(appId)) throwHttp(401, "invalid_app_id");

  const timestamp = req.headers["x-placeta-timestamp"];
  const nonce = req.headers["x-placeta-nonce"];
  const signature = req.headers["x-placeta-signature"];

  if (!timestamp || !nonce || !signature) throwHttp(401, "missing_signature_headers");

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs)) throwHttp(401, "invalid_timestamp");
  if (Math.abs(Date.now() - timestampMs) > FIVE_MINUTES_MS) throwHttp(401, "stale_timestamp");

  const bodyHash = sha256Hex(body);
  const validSignature = config.appSecrets().some((secret) =>
    signedPathCandidates(req).some((path) => {
      const signedPayload = [req.method, path, timestamp, nonce, bodyHash].join("\n");
      const expected = crypto
        .createHmac("sha256", secret)
        .update(signedPayload, "utf8")
        .digest("hex");
      return timingSafeEqualHex(expected, signature);
    })
  );

  if (!validSignature) throwHttp(401, "invalid_signature");
  await rememberNonce(appId, nonce);
}

async function assertPlacetaIdBearer(req, res) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length).trim();
  if (!token) throwHttp(401, "missing_bearer_token");
  const secrets = config.placetaIdJwtSecrets();
  if (secrets.length === 0) {
    const payload = await validatePlacetaIdTokenRemotely(token);
    if (payload) {
      req.placetaIdUser = payload;
      return true;
    }
    throwHttp(500, "placeta_id_jwt_secret_not_configured");
  }

  for (const secret of secrets) {
    try {
      const payload = verifyHs256Jwt(token, secret);
      req.placetaIdUser = normalizePlacetaPayload(payload);

      // Renovación automática: si el token tiene más de 1 día, emitimos uno nuevo en el header
      const now = Math.floor(Date.now() / 1000);
      if (payload.iat && (now - payload.iat) > 24 * 60 * 60) {
        const newTokenPayload = {
          ...payload,
          iat: now,
          exp: now + (5 * 24 * 60 * 60) // 5 días
        };
        const newToken = signHs256Jwt(newTokenPayload, secret);
        res.setHeader("X-New-Token", newToken);
        res.setHeader("Access-Control-Expose-Headers", "X-New-Token");
      }

      return true;
    } catch (error) {
      if (error?.statusCode) throw error;
    }
  }

  const payload = await validatePlacetaIdTokenRemotely(token);
  if (payload) {
    req.placetaIdUser = payload;
    return true;
  }
  throwHttp(401, "invalid_placeta_id_token");
}

function signHs256Jwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signed = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac("sha256", secret).update(signed, "utf8").digest("base64url");
  return `${signed}.${signature}`;
}

function normalizePlacetaPayload(payload) {
  const dip = String(payload?.dip || "").trim().toUpperCase();
  const registroId = String(payload?.registroId || payload?.sub || "").trim();
  if (!dip || !registroId) throwHttp(401, "invalid_placeta_id_token");
  return {
    registroId,
    dip,
    role: String(payload.rol || payload.role || "")
  };
}

async function validatePlacetaIdTokenRemotely(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const normalized = normalizePlacetaPayload(payload);
  const allowed = config.adminBearerDips();
  if (!allowed.includes(normalized.dip)) return null;

  try {
    const response = await fetch(`${config.placetaIdBaseUrl()}/api/auth/session`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    const sessionDip = String(data?.registro?.dip || "").trim().toUpperCase();
    return sessionDip === normalized.dip ? normalized : null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token) {
  try {
    const [, encodedPayload] = token.split(".");
    if (!encodedPayload) return null;
    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && Number(payload.exp) <= now) return null;
    if (payload.nbf && Number(payload.nbf) > now) return null;
    return payload;
  } catch {
    return null;
  }
}

function verifyHs256Jwt(token, secret) {
  const [encodedHeader, encodedPayload, signature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !signature) throw new Error("invalid_jwt");

  const header = JSON.parse(base64UrlDecode(encodedHeader).toString("utf8"));
  if (header.alg !== "HS256") throw new Error("unsupported_jwt_alg");

  const signed = `${encodedHeader}.${encodedPayload}`;
  const expected = crypto.createHmac("sha256", secret).update(signed, "utf8").digest("base64url");
  if (!timingSafeEqualString(expected, signature)) throw new Error("invalid_jwt_signature");

  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && Number(payload.exp) <= now) throw new Error("expired_jwt");
  if (payload.nbf && Number(payload.nbf) > now) throw new Error("jwt_not_active");
  return payload;
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url");
}

function timingSafeEqualString(left, right) {
  const a = Buffer.from(left || "");
  const b = Buffer.from(right || "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
