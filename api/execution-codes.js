import { json, methodNotAllowed, readBody } from "../lib/http.js";
import { assertRequestAllowed, throwHttp } from "../lib/security.js";
import { readEntityCollection, upsertEntity } from "../lib/bankCollections.js";
import crypto from "crypto";

export default async function handler(req, res) {
  try {
    const body = req.method !== "GET" ? await readBody(req) : "";
    await assertRequestAllowed(req, res, body);

    if (req.method === "GET") {
      const url = new URL(req.url, "https://api.local");
      const code = url.searchParams.get("code");
      if (!code) {
        return json(res, 400, {
          error: "missing_execution_code",
          developerCode: "BPL-EXC-GET-001"
        });
      }

      const codes = await readEntityCollection("executionCodes");
      const found = (codes || []).find((ec) => ec.code === code && !ec.usedAt);

      if (!found) {
        return json(res, 404, {
          error: "execution_code_not_found_or_used",
          developerCode: "BPL-EXC-GET-002",
          message: "El código de ejecución no es válido o ya ha sido utilizado."
        });
      }

      const now = new Date();
      if (new Date(found.expiresAt) < now) {
        return json(res, 410, {
          error: "execution_code_expired",
          developerCode: "BPL-EXC-GET-003",
          message: "El código de ejecución ha expirado."
        });
      }

      return json(res, 200, {
        ok: true,
        executionCode: {
          id: found.id,
          code: found.code,
          issuedByAccountId: found.issuedByAccountId,
          targetAccountId: found.targetAccountId,
          amountPz: found.amountPz,
          paymentMode: found.paymentMode,
          expiresAt: found.expiresAt,
          issuedByAdminRef: found.issuedByAdminRef || null
        }
      });
    }

    if (req.method === "POST") {
      const payload = JSON.parse(body || "{}");
      const {
        issuedByAccountId,
        targetAccountId,
        amountPz,
        paymentMode,
        issuedByAdminRef
      } = payload;

      if (!issuedByAccountId || !targetAccountId || !amountPz || !paymentMode) {
        return json(res, 400, {
          error: "missing_required_fields",
          developerCode: "BPL-EXC-POST-001"
        });
      }

      if (!["Immediate", "OnTaxCollection"].includes(paymentMode)) {
        return json(res, 400, {
          error: "invalid_payment_mode",
          developerCode: "BPL-EXC-POST-002"
        });
      }

      const parsedAmount = Math.round(Number(amountPz));
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return json(res, 400, {
          error: "invalid_amount",
          developerCode: "BPL-EXC-POST-003"
        });
      }

      const id = `exc-${crypto.randomBytes(8).toString("hex")}`;
      const code = `GDLP-${crypto.randomBytes(4).toString("hex").toUpperCase()}-${crypto.randomInt(1000, 9999)}`;
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 días

      const executionCode = {
        id,
        code,
        issuedByAccountId,
        targetAccountId,
        amountPz: parsedAmount,
        paymentMode,
        expiresAt,
        usedAt: null,
        transactionId: null,
        issuedByAdminRef: issuedByAdminRef || null
      };

      await upsertEntity("executionCodes", id, executionCode);

      return json(res, 201, {
        ok: true,
        executionCode: {
          id,
          code,
          amountPz: parsedAmount,
          paymentMode,
          expiresAt
        }
      });
    }

    return methodNotAllowed(res, ["GET", "POST"]);
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: error.message || "internal_error",
      developerCode: "BPL-EXC-500"
    });
  }
}
