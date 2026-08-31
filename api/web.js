/**
 * Banco de La Placeta — API ciudadana scoped (FASE 2.3)
 * -------------------------------------------------------
 * Endpoints para el nuevo banco-web. TODOS autenticados con Bearer
 * PlacetaID (JWT verificado en lib/security.js -> req.placetaIdUser.dip).
 * Regla de oro: SOLO se devuelven datos del titular autenticado (o de sus
 * cuentas). Nunca datos de terceros. IBAN/tarjetas enmascarados. No-store.
 */
import { json, methodNotAllowed, readBody } from "../lib/http.js";
import { assertPlacetaIdBearer } from "../lib/security.js";
import { readBankState, upsertEntity } from "../lib/bankCollections.js";
import crypto from "crypto";

const CENSUS_REQUIRED_ACTION = "censo pendiente";

// Normaliza un IBAN/identificador para compararlo de forma tolerante:
// mayúsculas, sin espacios ni guiones opcionales. Acepta formatos APP
// (GDLP-AP##-### / CAPI-AP##-###) y WEB (GDLP-W###-#### / numérico).
function normalizeIban(value) {
  return String(value || "").toUpperCase().replace(/\s+/g, "");
}

// Busca una cuenta destino por IBAN (APP o WEB) o por ID interno.
// Prioridad: 1) ID interno exacto, 2) IBAN normalizado, 3) número de cuenta.
function findAccountByIbanOrId(state, to) {
  const raw = String(to || "").trim();
  if (!raw) return null;
  const target = normalizeIban(raw);
  const accounts = state.accounts || [];
  return (
    accounts.find((a) => a && String(a.id || "") === raw) ||
    accounts.find((a) => a && normalizeIban(a.iban) === target) ||
    accounts.find((a) => a && normalizeIban(a.id) === target) ||
    null
  );
}

// ── Helpers de enmascarado (nunca mostrar datos completos sensibles) ───────
function maskIban(iban) {
  if (!iban) return "";
  const s = String(iban);
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}••••••${s.slice(-4)}`;
}

function maskCardNumber(cardNumber) {
  const digits = String(cardNumber || "").replace(/\D/g, "");
  if (digits.length <= 4) return "••••";
  return `${digits.slice(0, 4)} •••• •••• ${digits.slice(-4)}`;
}

function maskEmail(email) {
  if (!email) return "";
  const [user, domain] = String(email).split("@");
  if (!domain) return "•••@•••";
  return `${user.slice(0, 2)}•••@${domain}`;
}

// ── Resolución de titular + sus cuentas ─────────────────────────────────────
function resolveOwner(state, dip) {
  const user = (state.users || []).find(
    (u) => String(u.dip || "").toUpperCase() === String(dip).toUpperCase()
  );
  if (!user) return null;
  const placetaId = user.placetaId || user.dip;
  const holderIds = (state.accountHolders || [])
    .filter((h) => String(h.placetaId || "").toUpperCase() === String(placetaId).toUpperCase())
    .map((h) => h.accountId);
  const accounts = (state.accounts || []).filter(
    (a) =>
      a &&
      (String(a.placetaId || "").toUpperCase() === String(placetaId).toUpperCase() ||
        (user.primaryAccountId && a.id === user.primaryAccountId) ||
        holderIds.includes(a.id))
  );
  return { user, placetaId, accounts };
}

function accountToView(a) {
  return {
    id: a.id,
    displayName: a.displayName || "Cuenta",
    type: a.type || "Current",
    kind: a.kind || "CITIZEN",
    balancePz: a.balancePz ?? 0,
    iban: maskIban(a.iban),
    ibanFull: a.iban || null, // Solo se expone al propio titular (igual que la app)
    esApp: /-AP\d{2}-\d{3}$/.test(String(a.iban || "")),
    eip: a.eip || null,
    complianceStatus: a.complianceStatus || "Clear",
    citizenshipTier: a.citizenshipTier || null,
    lastRbuClaim: a.lastRbuClaim || null,
    sendLimitPz: a.sendLimitPz ?? null,
    parentAccountId: a.parentAccountId || null,
    closedAt: a.closedAt || null
  };
}

export default async function handler(req, res) {
  try {
    // Autenticación: exige Bearer PlacetaID válido -> req.placetaIdUser.dip
    if (!(await assertPlacetaIdBearer(req, res))) {
      return json(res, 401, { error: "auth_required" });
    }

    const url = new URL(req.url, "https://api.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && path === "/api/web/cuenta") {
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const u = owner.user;
      return json(res, 200, {
        usuario: {
          dip: u.dip,
          placetaId: u.placetaId,
          displayName: u.displayName || "Titular",
          primaryAccountId: u.primaryAccountId || null,
          censado: !!u.tributosCensusDate,
          tributosCensusDate: u.tributosCensusDate || null,
          eip: u.eip || null,
          role: u.role || "Citizen"
        },
        cuentas: owner.accounts.map(accountToView)
      });
    }

    if (req.method === "GET" && path === "/api/web/movimientos") {
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
      const accountIds = new Set(owner.accounts.map((a) => a.id));
      const movs = (state.transactions || [])
        .filter(
          (t) =>
            t &&
            (accountIds.has(t.fromAccountId) || accountIds.has(t.toAccountId))
        )
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
        .slice(0, limit)
        .map((t) => ({
          id: t.id,
          kind: t.kind || "Transfer",
          fromAccountId: t.fromAccountId,
          toAccountId: t.toAccountId,
          amountPz: t.amountPz ?? t.netAmount ?? 0,
          ivaPz: t.ivaPz ?? 0,
          concept: t.concept || t.note || "",
          status: t.status || "Settled",
          createdAt: t.createdAt || null,
          esEntrada: accountIds.has(t.toAccountId)
        }));
      return json(res, 200, { movimientos: movs });
    }

    if (req.method === "GET" && path === "/api/web/tarjetas") {
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const accountIds = new Set(owner.accounts.map((a) => a.id));
      const cards = (state.digitalCards || [])
        .filter((c) => c && accountIds.has(c.accountId))
        .map((c) => ({
          id: c.id,
          accountId: c.accountId,
          alias: c.alias || "Tarjeta",
          tier: c.tier || "Standard",
          frozen: !!c.frozen,
          released: !!c.released,
          cardNumber: maskCardNumber(c.cardNumber)
          // NOTA: el PIN nunca se expone por la web
        }));
      return json(res, 200, { tarjetas: cards });
    }

    if (req.method === "GET" && path === "/api/web/gestores") {
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const accountIds = new Set(owner.accounts.map((a) => a.id));
      const users = state.users || [];
      const gestores = (state.accountHolders || [])
        .filter((h) => h && accountIds.has(h.accountId))
        .map((h) => {
          const holderUser = users.find(
            (u) => String(u.placetaId || "").toUpperCase() === String(h.placetaId || "").toUpperCase()
          );
          return {
            id: h.id,
            accountId: h.accountId,
            placetaId: h.placetaId,
            displayName: holderUser?.displayName || h.placetaId,
            role: h.role || "CoOwner",
            ownershipPercent: h.ownershipPercent ?? 0,
            validUntil: h.validUntil || null,
            linkedAt: h.linkedAt || null
          };
        });
      return json(res, 200, { gestores });
    }

    if (req.method === "GET" && path === "/api/web/cumplimiento") {
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const accountIds = new Set(owner.accounts.map((a) => a.id));
      const flags = (state.complianceFlags || [])
        .filter((f) => f && accountIds.has(f.accountId))
        .map((f) => ({
          id: f.id,
          accountId: f.accountId,
          reason: f.reason || "",
          amountPz: f.amountPz ?? 0,
          status: f.status || "PendingReview",
          createdAt: f.createdAt || null
        }));
      return json(res, 200, {
        censado: !!owner.user.tributosCensusDate,
        flags,
        cuentas: owner.accounts.map((a) => ({
          id: a.id,
          displayName: a.displayName || "Cuenta",
          complianceStatus: a.complianceStatus || "Clear",
          irmOptIn: !!a.irmOptIn,
          irmDueDate: a.irmDueDate || null,
          fundsJustificationApproved: !!a.fundsJustificationApproved
        }))
      });
    }

    if (req.method === "GET" && path === "/api/web/contactos") {
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const contacts = (state.savedContacts || [])
        .filter(
          (c) =>
            c &&
            String(c.ownerPlacetaId || "").toUpperCase() === String(owner.placetaId).toUpperCase()
        )
        .map((c) => ({ id: c.id, accountId: c.accountId, createdAt: c.createdAt || null }));
      return json(res, 200, { contactos: contacts });
    }

    // ── Transferencia firmada: crea operación PENDIENTE (sin mover saldos) ──
    // El abono real se ejecuta tras confirmación en PlacetaID Móvil (flujo
    // existente de firma/execution-code). Aquí solo validamos propiedad,
    // saldo y dejamos la solicitud en estado Pending + código de ejecución.
    if (req.method === "POST" && path === "/api/web/transferencia") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const { from, to, cantidad, concepto } = body;
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });

      const fromAcc = owner.accounts.find((a) => a.id === from);
      if (!fromAcc) {
        return json(res, 403, { error: "No puedes transferir desde una cuenta que no es tuya" });
      }
      // El destino se acepta por ID interno (compatibilidad) o por IBAN
      // (formato APP "GDLP-AP##-###"/"CAPI-AP##-###" o formato WEB
      // "GDLP-W###-####"/numérico), lo que permite transferencias web↔app.
      const toAcc = findAccountByIbanOrId(state, to);
      if (!toAcc) return json(res, 404, { error: "Cuenta destino no encontrada. Revisa el IBAN." });
      if (normalizeIban(toAcc.id) === normalizeIban(fromAcc.id) || normalizeIban(toAcc.iban) === normalizeIban(fromAcc.iban)) {
        return json(res, 400, { error: "No puedes transferir a la misma cuenta" });
      }
      const amount = Math.round(Number(cantidad));
      if (!Number.isFinite(amount) || amount <= 0) {
        return json(res, 400, { error: "Cantidad inválida" });
      }
      if ((fromAcc.balancePz ?? 0) < amount) {
        return json(res, 400, { error: "Saldo insuficiente", saldo: fromAcc.balancePz ?? 0, requerido: amount });
      }

      const now = new Date().toISOString();
      const pendingId = `txw-${crypto.randomBytes(8).toString("hex")}`;
      const executionCode = `GDLP-${crypto.randomBytes(4).toString("hex").toUpperCase()}-${crypto.randomInt(1000, 9999)}`;

      // Registro pendiente (aditivo, NO mueve saldos): status Pending + firma requerida
      await upsertEntity("bank_transactions", pendingId, {
        id: pendingId,
        kind: "Transfer",
        fromAccountId: from,
        toAccountId: to,
        amountPz: amount,
        ivaPz: 0,
        netAmount: amount,
        taxAmount: 0,
        concept: concepto || "Transferencia web (pendiente de firma)",
        status: "Pending",
        firmaRequerida: true,
        executionCode,
        source: "banco-web",
        createdAt: now,
        updatedAt: now,
        IBAN_Origin: fromAcc.iban || ""
      });

      await upsertEntity("bank_audit_logs", `aud-${pendingId}`, {
        id: `aud-${pendingId}`,
        action: "transferencia_web_pendiente",
        admin: req.placetaIdUser.dip,
        cantidad: amount,
        accountId: from,
        motivo: concepto || "Transferencia web",
        createdAt: now
      });

      return json(res, 201, {
        ok: true,
        transferencia: {
          id: pendingId,
          estado: "Pending",
          executionCode,
          mensaje: "Solicitud registrada. Confírmala en PlacetaID Móvil para ejecutarla.",
          amountPz: amount,
          from,
          to,
          createdAt: now
        }
      });
    }

    return methodNotAllowed(res, ["GET", "POST"]);
  } catch (error) {
    if (error?.statusCode) {
      return json(res, error.statusCode, { error: error.message });
    }
    console.error("[web.js]", error);
    return json(res, 500, { error: "internal_error" });
  }
}
