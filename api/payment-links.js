import { json, methodNotAllowed, readBody } from "../lib/http.js";
import { assertRequestAllowed, throwHttp } from "../lib/security.js";
import { readBankState, upsertEntity, readEntityCollection } from "../lib/bankCollections.js";
import { leerNumero } from "../lib/valores-bop.js";
import crypto from "crypto";
import { config } from "../lib/config.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return methodNotAllowed(res, ["POST"]);
    }

    const body = await readBody(req);
    await assertRequestAllowed(req, res, body);

    const payload = JSON.parse(body || "{}");

    // ── Verificar pago (verify-payment) ────────────────────────────────
    if (payload.paymentLinkId && payload.signature) {
      const { paymentLinkId, signature } = payload;
      const links = await readEntityCollection("paymentLinks");
      if (!links?.length) {
        return json(res, 404, { error: "payment_link_not_found", developerCode: "BPL-PAY-VER-002" });
      }
      const link = links.find((l) => l.id === paymentLinkId);
      if (!link) {
        return json(res, 404, { error: "payment_link_not_found", developerCode: "BPL-PAY-VER-003" });
      }
      if (link.status !== "Pending") {
        return json(res, 400, {
          error: "payment_link_already_processed", developerCode: "BPL-PAY-VER-004",
          message: "Este enlace de pago ya ha sido procesado."
        });
      }
      const secret = config.appSecrets()[0] || "gdlp-secure-payment-key";
      const sigPayload = [link.id, link.kind, link.creatorAccountId, link.amountPz, link.ivaPz, link.totalPz].join(":");
      const expected = crypto.createHmac("sha256", secret).update(sigPayload, "utf8").digest("hex");
      if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
        return json(res, 403, {
          error: "invalid_signature_link_tampered", developerCode: "BPL-PAY-VER-005",
          message: "Este enlace de pago no es válido o ha sido manipulado."
        });
      }
      return json(res, 200, {
        ok: true,
        link: {
          id: link.id, kind: link.kind, creatorAccountId: link.creatorAccountId,
          targetIban: link.targetIban, amountPz: link.amountPz, ivaPz: link.ivaPz,
          totalPz: link.totalPz, concept: link.concept, status: link.status, createdAt: link.createdAt
        }
      });
    }

    // ── Crear link de pago ─────────────────────────────────────────────
    const { kind, creatorAccountId, targetIban, amountPz, concept } = payload;

    if (!creatorAccountId) {
      return json(res, 400, { error: "missing_creator_account_id" });
    }

    const parsedAmount = Math.round(Number(amountPz));
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return json(res, 400, { error: "invalid_amount" });
    }

    const state = await readBankState();
    const creatorAccount = (state.accounts || []).find((a) => a.id === creatorAccountId);
    if (!creatorAccount) {
      return json(res, 404, { error: "creator_account_not_found" });
    }

    const isPayment = kind === "Payment" || kind === "payment";
    // Tipo de IVA vigente del BOLP (CNIC-IVA, CNI-BANCO Art. 4) con fallback 12 %.
    const ivaPorcentaje = await leerNumero("CNIC-IVA", 12);
    const ivaPz = (isPayment && creatorAccount.type === "Business")
      ? Math.ceil(parsedAmount * Number(ivaPorcentaje) / 100)
      : 0;
    const totalPz = parsedAmount + ivaPz;

    const id = `link-${crypto.randomBytes(8).toString("hex")}`;
    const cleanConcept = String(concept || "").trim() || (isPayment ? "Pago seguro" : "Envío de Placetas");

    const link = {
      id,
      kind: isPayment ? "Payment" : "Send",
      creatorAccountId,
      targetIban: targetIban || creatorAccount.iban || null,
      amountPz: parsedAmount,
      ivaPz,
      totalPz,
      concept: cleanConcept,
      status: "Pending",
      createdAt: new Date().toISOString()
    };

    const secret = config.appSecrets()[0] || "gdlp-secure-payment-key";
    const sigPayload = [id, link.kind, creatorAccountId, parsedAmount, ivaPz, totalPz].join(":");
    const signature = crypto.createHmac("sha256", secret).update(sigPayload, "utf8").digest("hex");
    link.signature = signature;

    await upsertEntity("paymentLinks", id, link);

    return json(res, 201, { link, signature });
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: error.message || "internal_error"
    });
  }
}
