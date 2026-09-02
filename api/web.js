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

// RSP es el origen de verdad de las facturas de las empresas. El gateway de
// tributos llama a /api/v1/tributos/facturacion con esta clave compartida.
const RSP_URL = (process.env.ADMIN_PLACETA_URL || "https://rsp.laplaceta.org").replace(/\/+$/, "");
const RSP_TRIBUTOS_KEY = process.env.TRIBUTOS_API_KEY || "";
const CUENTA_TRIBUTOS_ID = "TGLP";

async function fetchFacturacionEip(eip, mes) {
  if (!RSP_TRIBUTOS_KEY) return { ok: false, status: 503, body: { error: "tributos_api_key_no_configurada" } };
  try {
    const qs = new URLSearchParams({ eip: String(eip), mes: String(mes) });
    const r = await fetch(`${RSP_URL}/api/v1/tributos/facturacion?${qs}`, {
      headers: { "X-API-Key": RSP_TRIBUTOS_KEY, "X-Platform": "web" },
    });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 502, body: { error: `rsp_facturacion_no_disponible: ${e.message}` } };
  }
}

// Cuentas de empresa (Business) del titular/gestor y sus EIPs únicos.
function empresasDelOwner(owner) {
  const porEip = new Map();
  for (const a of owner.accounts || []) {
    const tipo = String(a.type || a.kind || "").toLowerCase();
    const eip = String(a.eip || "").toUpperCase();
    if (tipo !== "business" && tipo !== "state") continue;
    if (!eip) continue;
    let g = porEip.get(eip);
    if (!g) { g = { eip, nombre: a.displayName || a.name || eip, cuentas: [] }; porEip.set(eip, g); }
    g.cuentas.push({ id: a.id, displayName: a.displayName || a.id, saldo: a.balancePz ?? 0 });
  }
  return Array.from(porEip.values());
}

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

    // ── Facturación: facturas del mes de TUS empresas + IVA pendiente ──
    // Solo lectura (RSP es el origen de verdad). Se devuelven las facturas
    // de las cuentas Business del titular/gestor (regla de oro: solo lo tuyo).
    if (req.method === "GET" && path === "/api/web/facturacion") {
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const mes = String(url.searchParams.get("mes") || new Date().toISOString().slice(0, 7));
      const empresas = empresasDelOwner(owner);
      if (empresas.length === 0) {
        return json(res, 200, { ok: true, mes, empresas: [], mensaje: "No tienes cuentas de empresa con EIP" });
      }
      const conDatos = [];
      for (const emp of empresas) {
        const r = await fetchFacturacionEip(emp.eip, mes);
        if (!r.ok) continue; // si una empresa no está en el ciclo, no la incluimos
        conDatos.push({
          eip: emp.eip,
          nombre: r.body.empresa?.nombre || emp.nombre,
          cuentas: emp.cuentas,
          facturas: r.body.facturas || [],
          totalFacturas: r.body.totalFacturas || 0,
          totalIvaVentas: r.body.totalIvaVentas || 0,
          totalIvaPagado: r.body.totalIvaPagado || 0,
          ivaPendiente: r.body.totalIvaPendiente ?? r.body.ivaAIngresar ?? 0
        });
      }
      return json(res, 200, { ok: true, mes, empresas: conDatos });
    }

    // ── Pagar el IVA de facturas seleccionadas (de golpe) ─────────────
    // Crea una transferencia PENDING de la empresa a TGLP por el IVA de las
    // facturas elegidas (todas pendientes, nunca repetidas). El abono real se
    // ejecuta al confirmarla en PlacetaID Móvil (firma). El concepto lleva las
    // referencias FAC-… para que RSP concilie y marque las facturas pagadas.
    if (req.method === "POST" && path === "/api/web/facturacion/pagar-iva") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const { from, mes } = body;
      const facturaIds = Array.isArray(body.facturaIds)
        ? body.facturaIds.map((x) => String(x)).filter(Boolean)
        : [];
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      if (!from) return json(res, 400, { error: "from_requerido" });
      if (facturaIds.length === 0) return json(res, 400, { error: "facturaIds_requeridos" });

      const fromAcc = owner.accounts.find((a) => a.id === from);
      if (!fromAcc) {
        return json(res, 403, { error: "La cuenta no te pertenece" });
      }
      const eip = String(fromAcc.eip || "").toUpperCase();
      if (!eip) {
        return json(res, 403, { error: "Solo las cuentas de empresa pueden pagar IVA de facturas" });
      }
      const periodo = String(mes || new Date().toISOString().slice(0, 7));
      const r = await fetchFacturacionEip(eip, periodo);
      if (!r.ok) {
        return json(res, r.status === 503 ? 503 : 502, { error: r.body?.error || "rsp_facturacion_no_disponible" });
      }
      const facturas = Array.isArray(r.body.facturas) ? r.body.facturas : [];
      const porId = new Map(facturas.map((f) => [String(f.id), f]));
      const aPagar = facturaIds.filter((id) => {
        const f = porId.get(id);
        return f && !f.ivaPagado; // solo facturas pendientes y de esta empresa
      });
      const invalidas = facturaIds.filter((id) => {
        const f = porId.get(id);
        return !f || f.ivaPagado;
      });
      if (invalidas.length) {
        return json(res, 409, {
          error: "Hay facturas que no existen o cuyo IVA ya está pagado",
          invalidas
        });
      }
      const totalIva = Math.round((aPagar.reduce((s, id) => s + (Number(porId.get(id).iva) || 0), 0)) * 100) / 100;
      if (!(totalIva > 0)) {
        return json(res, 400, { error: "No hay IVA pendiente que pagar" });
      }
      if ((fromAcc.balancePz ?? 0) < totalIva) {
        return json(res, 400, { error: "Saldo insuficiente", saldo: fromAcc.balancePz ?? 0, requerido: totalIva });
      }
      const toAcc = findAccountByIbanOrId(state, CUENTA_TRIBUTOS_ID);
      if (!toAcc) {
        return json(res, 404, { error: "Cuenta de Tributos (TGLP) no encontrada" });
      }

      const now = new Date().toISOString();
      const pendingId = `txw-${crypto.randomBytes(8).toString("hex")}`;
      const executionCode = `GDLP-${crypto.randomBytes(4).toString("hex").toUpperCase()}-${crypto.randomInt(1000, 9999)}`;
      const concepto = `Pago IVA facturas ${periodo} · ${eip} · refs:${aPagar.join(",")}`;

      // Registro pendiente (NO mueve saldos): el IVA viaja como cantidad del
      // abono (ivaPz 0) → es una TRANSFERENCIA al Banco, nunca PlaceZum.
      await upsertEntity("bank_transactions", pendingId, {
        id: pendingId,
        kind: "Transfer",
        fromAccountId: from,
        toAccountId: toAcc.id,
        amountPz: totalIva,
        ivaPz: 0,
        netAmount: totalIva,
        taxAmount: 0,
        concept: concepto,
        status: "Pending",
        firmaRequerida: true,
        executionCode,
        source: "banco-web-facturacion",
        eip,
        mes: periodo,
        refs: aPagar,
        createdAt: now,
        updatedAt: now,
        IBAN_Origin: fromAcc.iban || ""
      });
      await upsertEntity("bank_audit_logs", `aud-${pendingId}`, {
        id: `aud-${pendingId}`,
        action: "pago_iva_web_pendiente",
        admin: req.placetaIdUser.dip,
        cantidad: totalIva,
        accountId: from,
        eip,
        mes: periodo,
        refs: aPagar,
        motivo: concepto,
        createdAt: now
      });

      return json(res, 201, {
        ok: true,
        pago: {
          id: pendingId,
          estado: "Pending",
          executionCode,
          eip,
          mes: periodo,
          importe: totalIva,
          facturas: aPagar,
          mensaje: `Se ordenó el pago de ${aPagar.length} facturas por ${totalIva} Pz a Tributos. Confírmalo en PlacetaID Móvil para ejecutarlo.`
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
