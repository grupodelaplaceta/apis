// Banco de La Placeta — Pago de IVA por facturas (mecanismo compartido)
// ─────────────────────────────────────────────────────────────────────────────
// El IVA repercutido de una empresa se ingresa a Tributos (TGLP) cuando la
// empresa paga SUS FACTURAS. El pago SIEMPRE es una TRANSFERENCIA del Banco a
// TGLP (nunca PlaceZum) y, para que sea seguro, se crea como operación
// PENDING (sin mover saldos) que la app de PlacetaID Móvil confirma con su
// flujo de firma (execution-code). El concepto referencia las facturas
// (`refs:FAC-…`) para que RSP las marque como pagadas al conciliar.
//
// Este módulo es la ÚNICA vía de creación de ese pago desde las superficies
// ciudadanas (banco-web y app). web.js lo usa tras validar propiedad con
// PlacetaID; el gateway v1 (app) lo usa con el mismo contrato de confianza
// que el resto de consultas por EIP (sin token: solo crea Pending, que exige
// firma del dueño para ejecutarse).
import crypto from "crypto";
import { readBankState, upsertEntity } from "./bankCollections.js";

const RSP_URL = (process.env.ADMIN_PLACETA_URL || "https://rsp.laplaceta.org").replace(/\/+$/, "");
const RSP_KEY = process.env.TRIBUTOS_API_KEY || "";
const TGLP_ID = "TGLP";
const TGLP_IBAN = "GDLP-AP98-605";

function redondear2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Consulta en RSP las facturas del mes de una empresa (por EIP). */
export async function consultarFacturacionRsp(eip, mes) {
  if (!RSP_KEY) return { ok: false, status: 503, body: { error: "tributos_api_key_no_configurada" } };
  try {
    const qs = new URLSearchParams({ eip: String(eip), mes: String(mes) });
    const r = await fetch(`${RSP_URL}/api/v1/tributos/facturacion?${qs}`, {
      headers: { "X-API-Key": RSP_KEY, "X-Platform": "banco" },
    });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 502, body: { error: `rsp_facturacion_no_disponible: ${e.message}` } };
  }
}

/**
 * Crea la transferencia PENDING de la empresa a TGLP por el IVA de las
 * facturas seleccionadas (todas pendientes; nunca repite pagadas).
 *
 * Devuelve:
 *   { ok:true, pago:{ id, estado:'Pending', executionCode, eip, mes, importe,
 *                     facturas[], mensaje } }
 * o un error { status, error, ... }.
 */
export async function crearPagoIvaPendiente({
  from,
  eip,
  mes,
  facturaIds,
  origen = "banco-web-facturacion",
  actorDip = "",
}) {
  const ids = Array.isArray(facturaIds) ? facturaIds.map((x) => String(x)).filter(Boolean) : [];
  const eipUp = String(eip || "").toUpperCase();
  if (!from) return { status: 400, error: "from_requerido" };
  if (!eipUp) return { status: 400, error: "eip_requerido" };
  if (ids.length === 0) return { status: 400, error: "facturaIds_requeridos" };

  const state = await readBankState();
  const fromAcc = (state.accounts || []).find((a) => a && String(a.id || a.accountId || "") === String(from));
  if (!fromAcc) return { status: 404, error: "Cuenta no encontrada" };

  const tipo = String(fromAcc.type || fromAcc.kind || "").toLowerCase();
  if (tipo !== "business" && tipo !== "state") {
    return { status: 403, error: "Solo las cuentas de empresa pueden pagar IVA de facturas" };
  }
  if (String(fromAcc.eip || "").toUpperCase() !== eipUp) {
    return { status: 403, error: "El EIP no corresponde a esta cuenta" };
  }

  const periodo = String(mes || new Date().toISOString().slice(0, 7));
  const r = await consultarFacturacionRsp(eipUp, periodo);
  if (!r.ok) {
    return { status: r.status === 503 ? 503 : 502, error: r.body?.error || "rsp_facturacion_no_disponible" };
  }
  const facturas = Array.isArray(r.body.facturas) ? r.body.facturas : [];
  const porId = new Map(facturas.map((f) => [String(f.id), f]));
  const invalidas = ids.filter((id) => {
    const f = porId.get(id);
    return !f || f.ivaPagado; // no existe o su IVA ya está pagado
  });
  if (invalidas.length) {
    return { status: 409, error: "Hay facturas que no existen o cuyo IVA ya está pagado", invalidas };
  }
  const aPagar = ids.filter((id) => porId.has(id));
  const totalIva = redondear2(aPagar.reduce((s, id) => s + (Number(porId.get(id).iva) || 0), 0));
  if (!(totalIva > 0)) return { status: 400, error: "No hay IVA pendiente que pagar" };

  const saldo = Number(fromAcc.balancePz ?? fromAcc.saldo ?? 0);
  if (saldo < totalIva) {
    return { status: 400, error: "Saldo insuficiente", saldo, requerido: totalIva };
  }

  const toAcc = (state.accounts || []).find(
    (a) => a && (String(a.id || "") === TGLP_ID || String(a.iban || "").toUpperCase() === TGLP_IBAN)
  );
  if (!toAcc) return { status: 404, error: "Cuenta de Tributos (TGLP) no encontrada" };

  const now = new Date().toISOString();
  const pendingId = `txw-${crypto.randomBytes(8).toString("hex")}`;
  const executionCode = `GDLP-${crypto.randomBytes(4).toString("hex").toUpperCase()}-${crypto.randomInt(1000, 9999)}`;
  const concepto = `Pago IVA facturas ${periodo} · ${eipUp} · refs:${aPagar.join(",")}`;

  // Registro pendiente (NO mueve saldos): el IVA viaja como cantidad del abono
  // (ivaPz 0) → es una TRANSFERENCIA del Banco, nunca PlaceZum.
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
    source: origen,
    eip: eipUp,
    mes: periodo,
    refs: aPagar,
    createdAt: now,
    updatedAt: now,
    IBAN_Origin: fromAcc.iban || "",
  });
  await upsertEntity("bank_audit_logs", `aud-${pendingId}`, {
    id: `aud-${pendingId}`,
    action: "pago_iva_pendiente",
    admin: actorDip || undefined,
    cantidad: totalIva,
    accountId: from,
    eip: eipUp,
    mes: periodo,
    refs: aPagar,
    motivo: concepto,
    origen,
    createdAt: now,
  });

  return {
    ok: true,
    pago: {
      id: pendingId,
      estado: "Pending",
      executionCode,
      eip: eipUp,
      mes: periodo,
      importe: totalIva,
      facturas: aPagar,
      mensaje: `Se ordenó el pago de ${aPagar.length} facturas por ${totalIva} Pz a Tributos. Confímalo en PlacetaID Móvil para ejecutarlo.`,
    },
  };
}
