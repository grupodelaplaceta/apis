import { json, methodNotAllowed, readBody } from "../lib/http.js";
import { assertRequestAllowed, throwHttp } from "../lib/security.js";
import { readBankState, upsertEntity } from "../lib/bankCollections.js";
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
    const ivaPz = (isPayment && creatorAccount.type === "Business")
      ? Math.ceil(parsedAmount * 0.12)
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
