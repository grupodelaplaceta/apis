import { json, methodNotAllowed, readBody } from "../lib/http.js";
import { assertRequestAllowed, throwHttp } from "../lib/security.js";
import { readEntityCollection } from "../lib/bankCollections.js";
import crypto from "crypto";
import { config } from "../lib/config.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    await assertRequestAllowed(req, res, await readBody(req));

    const body = JSON.parse(await readBody(req) || "{}");
    const { paymentLinkId, signature } = body;
    if (!paymentLinkId || !signature) {
      return json(res, 400, { error: "missing_payment_link_id_or_signature", developerCode: "BPL-PAY-VER-001" });
    }

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
        error: "payment_link_already_processed",
        developerCode: "BPL-PAY-VER-004",
        message: "Este enlace de pago ya ha sido procesado."
      });
    }

    const secret = config.appSecrets()[0] || "gdlp-secure-payment-key";
    const sigPayload = [link.id, link.kind, link.creatorAccountId, link.amountPz, link.ivaPz, link.totalPz].join(":");
    const expected = crypto.createHmac("sha256", secret).update(sigPayload, "utf8").digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
      return json(res, 403, {
        error: "invalid_signature_link_tampered",
        developerCode: "BPL-PAY-VER-005",
        message: "Este enlace de pago no es válido o ha sido manipulado."
      });
    }

    return json(res, 200, {
      ok: true,
      link: {
        id: link.id,
        kind: link.kind,
        creatorAccountId: link.creatorAccountId,
        targetIban: link.targetIban,
        amountPz: link.amountPz,
        ivaPz: link.ivaPz,
        totalPz: link.totalPz,
        concept: link.concept,
        status: link.status,
        createdAt: link.createdAt
      }
    });
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: error.message || "internal_error",
      developerCode: "BPL-PAY-VER-500"
    });
  }
}
