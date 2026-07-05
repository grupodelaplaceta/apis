import { json, readBody } from "../lib/http.js";
import { readBankState, upsertEntity } from "../lib/bankCollections.js";
import crypto from "crypto";

const CRM_KEY = process.env.CRM_READ_KEY || '';

function uuid() { return crypto.randomUUID(); }

function requireCrmKey(req, res) {
  const key = req.headers["x-crm-key"];
  if (!CRM_KEY || key !== CRM_KEY) {
    json(res, 401, { error: "invalid_crm_key" });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "X-CRM-Key, Content-Type"
      });
      return res.end();
    }

    // ── GET: Leer estado completo del banco ────────────────────────────
    if (req.method === "GET") {
      if (!requireCrmKey(req, res)) return;
      const state = await readBankState();
      if (!state.accounts?.length) return json(res, 404, { error: "state_not_found" });
      return json(res, 200, state);
    }

    // ── POST: Operaciones monetarias (emitir/quemar) ───────────────────
    if (req.method === "POST") {
      if (!requireCrmKey(req, res)) return;
      const body = JSON.parse(await readBody(req) || "{}");
      const { action, cantidad, dip, cuentaId, motivo } = body;

      if (!action || !cantidad || cantidad <= 0) {
        return json(res, 400, { error: "Se requiere action y cantidad positiva" });
      }

      const state = await readBankState();

      if (action === "emitir") {
        if (!dip) return json(res, 400, { error: "Se requiere DIP del destino" });
        const destino = (state.users || []).find(u => u.dip?.toUpperCase() === dip.toUpperCase());
        if (!destino) return json(res, 404, { error: "DIP no encontrado" });
        const cuentaDestino = (state.accounts || []).find(a => a.placetaId === destino.placetaId);
        if (!cuentaDestino) return json(res, 404, { error: "El usuario no tiene cuenta" });

        const txId = uuid();
        const now = new Date().toISOString();
        await upsertEntity("bank_transactions", txId, {
          id: txId, fromAccountId: "TGLP", toAccountId: cuentaDestino.id,
          amountPz: cantidad, kind: "Transfer", note: motivo || "Emisión administrativa",
          status: "Settled", createdAt: now, updatedAt: now
        });
        return json(res, 200, {
          message: `Emitidas ${cantidad} Pz a ${destino.displayName || dip}`,
          transactionId: txId
        });
      }

      if (action === "quemar") {
        if (!cuentaId) return json(res, 400, { error: "Se requiere ID de cuenta" });
        const cuenta = (state.accounts || []).find(a => a.id === cuentaId);
        if (!cuenta) return json(res, 404, { error: "Cuenta no encontrada" });
        if ((cuenta.balancePz || 0) < cantidad) return json(res, 400, { error: "Saldo insuficiente" });

        const txId = uuid();
        const now = new Date().toISOString();
        await upsertEntity("bank_transactions", txId, {
          id: txId, fromAccountId: cuentaId, toAccountId: "TGLP",
          amountPz: cantidad, kind: "Transfer", note: motivo || "Quema administrativa",
          status: "Settled", createdAt: now, updatedAt: now
        });
        return json(res, 200, {
          message: `Quemadas ${cantidad} Pz de ${cuenta.displayName || cuentaId}`,
          transactionId: txId
        });
      }

      return json(res, 400, { error: 'Action debe ser "emitir" o "quemar"' });
    }

    return json(res, 405, { error: "method_not_allowed" });
  } catch (error) {
    return json(res, 500, { error: error.message || "internal_error" });
  }
}
