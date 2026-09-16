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
import { buscarTitularPorDip, esCuentaPersonalViva, esDipValido, registrarTitularPorPlacetaId } from "../lib/registroPlacetaId.js";
import * as N from "../lib/nominas.js";
import * as T from "../lib/tributos.js";
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
function cuentasActivas(owner, url) {
  const requested = String(url?.searchParams.get("cuenta") || "").trim();
  if (!requested) return owner.accounts || [];
  const selected = (owner.accounts || []).find((account) => account.id === requested);
  return selected ? [selected] : [];
}

function empresasDelOwner(owner, accounts = owner.accounts) {
  const porEip = new Map();
  for (const a of accounts || []) {
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

// ── PlaceZUM: código de pago temporal (5 dígitos, caduca en 2 min) ─────
// Misma lógica que la app Android (EconomyEngine.generatePlacezumCode): un
// código derivado del IBAN + ventana de 120 s. Se replica el overflow de
// entero de 32 bits de Kotlin con `| 0` para que web y app generen el mismo
// código.
function generatePlacezumCode(account, nowMs = Date.now()) {
  const window = Math.floor(nowMs / 1000 / 120);
  const seed = `${account.iban || account.id}${window}`;
  let raw = 0;
  for (const ch of seed) raw = (raw * 31 + ch.charCodeAt(0)) | 0;
  const code = String(Math.abs(raw) % 100000).padStart(5, "0");
  return { code, accountId: account.id, iban: account.iban || account.id, expiresAt: new Date(nowMs + 120000).toISOString() };
}

function findAccountByPlacezumCode(state, codeText, nowMs = Date.now()) {
  const clean = String(codeText || "").replace(/\D/g, "");
  if (clean.length !== 5) return null;
  // Igual que la app (EconomyEngine.payWithPlacezumCode): solo se puede pagar
  // a cuentas ciudadanas (CITIZEN), nunca a cuentas de empresa/sistema.
  return (state.accounts || []).find((a) => a && (
    String(a.kind || "CITIZEN").toUpperCase() === "CITIZEN"
  ) && (
    generatePlacezumCode(a, nowMs).code === clean ||
    generatePlacezumCode(a, nowMs - 120000).code === clean
  )) || null;
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

// El tipo es metadato técnico; el usuario debe ver siempre un concepto útil.
function descriptiveConcept(transaction, accounts = new Map()) {
  const explicit = String(transaction.concept || transaction.note || transaction.description || "").trim();
  if (explicit && !["transfer", "transferencia", "placezum"].includes(explicit.toLowerCase())) {
    // Evita enseñar códigos internos como DEVELOPER_PAYMENT o RBU como si
    // fueran conceptos; los transforma en una etiqueta legible.
    if (/^[A-Z][A-Z0-9_]+$/.test(explicit)) {
      return explicit.toLowerCase().replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
    }
    return explicit;
  }
  const from = accounts.get(transaction.fromAccountId)?.displayName || transaction.fromAccountId || "cuenta origen";
  const to = accounts.get(transaction.toAccountId)?.displayName || transaction.toAccountId || "cuenta destino";
  const kind = String(transaction.kind || "").toLowerCase();
  if (kind === "placezum") return `Pago a ${to}`;
  if (kind === "rbu") return "Ingreso de renta básica universal";
  if (kind.includes("payroll") || kind.includes("nomina")) return `Ingreso de nómina de ${from}`;
  if (kind.includes("investment")) return `Operación de inversión con ${to}`;
  if (kind.includes("subsid")) return `Ingreso de subvención de ${from}`;
  return transaction.status === "Pending" ? `Transferencia a ${to} (pendiente de firma)` : `Transferencia a ${to}`;
}

// ── Resolución de titular + sus cuentas ─────────────────────────────────────
// Se resuelve por DIP tolerando los alias con los que el banco guarda a la
// misma persona (DIP, PLID-DIP, prefijos antiguos y cotitularías), de modo que
// un titular con cuentas pero sin `bank_user` (migrados) también las vea.
function resolveOwner(state, dip) {
  const busqueda = buscarTitularPorDip(state, dip);
  if (!busqueda.usuario && busqueda.cuentas.length === 0) return null;
  const dipLimpio = String(dip || "").trim().toUpperCase();
  const user = busqueda.usuario || {
    dip: dipLimpio,
    placetaId: busqueda.cuentas[0]?.placetaId || dipLimpio,
    displayName: busqueda.cuentas[0]?.displayName || dipLimpio,
    role: "Citizen"
  };
  const placetaId = user.placetaId || user.dip || dipLimpio;
  return { user, placetaId, accounts: busqueda.cuentas, registrado: !!busqueda.usuario };
}

function dipNormalizadoDe(placetaIdUser) {
  return String(placetaIdUser?.dip || "").trim().toUpperCase();
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
    closedAt: a.closedAt || null,
    titularDip: a.titularDip || a.dip || a.placetaId || null,
    cotitularDip: a.cotitularDip || a.cotitular || null,
    cotitularHastaEdad: a.cotitularHastaEdad || null,
    entityName: a.entityName || a.nombre || null
  };
}

export default async function handler(req, res) {
  try {
    // Los navegadores y proxies pueden comprobar el endpoint con OPTIONS antes
    // de la petición real. Debe responder sin autenticación ni 405.
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("Allow", "GET, POST, OPTIONS");
      res.setHeader("Cache-Control", "no-store");
      return res.end();
    }

    // Autenticación: exige Bearer PlacetaID válido -> req.placetaIdUser.dip
    if (!(await assertPlacetaIdBearer(req, res))) {
      return json(res, 401, { error: "auth_required" });
    }

    const url = new URL(req.url, "https://api.local");
    const rawPath = url.pathname.replace(/\/+$/, "") || "/";
    // Vercel puede entregar al serverless function la URL del destino del
    // rewrite (/api/web) en lugar de la ruta original. El rewrite añade
    // `route`; los headers cubren despliegues antiguos y proxies intermedios.
    const routeQuery = String(url.searchParams.get("route") || "").replace(/^\/+|\/+$/g, "");
    const originalHeader = String(
      req.headers["x-vercel-original-url"] ||
      req.headers["x-invoke-path"] ||
      req.headers["x-matched-path"] ||
      req.headers["x-original-url"] ||
      ""
    );
    const headerPath = originalHeader ? originalHeader.split("?")[0].replace(/\/+$/, "") : "";
    let path = routeQuery
      ? `/api/web/${routeQuery}`
      : (headerPath.startsWith("/api/web/") ? headerPath : rawPath);
    // Compatibilidad con clientes antiguos que usaban singular o guion.
    const aliases = {
      "/api/web/nomina": "/api/web/nominas",
      "/api/web/tributo": "/api/web/tributos",
      "/api/web/subvencion": "/api/web/subvenciones",
      "/api/web/place-zum": "/api/web/placezum"
    };
    path = aliases[path] || path;

    // Ayuda de endpoint para evitar que un cliente mal configurado reciba un
    // 405 opaco al consultar accidentalmente /api/web sin recurso.
    if (req.method === "GET" && path === "/api/web") {
      return json(res, 200, {
        ok: true,
        endpoints: ["cuenta", "registro", "movimientos", "tarjetas", "gestores", "cumplimiento", "nominas", "tributos", "facturacion", "inversiones", "subvenciones", "placezum", "transferencia"]
      });
    }

    // ── Alta por DIP de PlacetaID ─────────────────────────────────────────
    // Cualquier DIP válido de PlacetaID puede registrarse en el banco por sí
    // mismo. Antes de crear nada se BUSCA por el DIP si ya tiene cuentas: si
    // las tiene, se vincula (no se duplica); si no, se le abre cuenta.
    if (path === "/api/web/registro") {
      const dip = dipNormalizadoDe(req.placetaIdUser);
      if (!esDipValido(dip)) {
        return json(res, 400, { error: "dip_invalido", dip });
      }

      if (req.method === "GET") {
        const estado = await readBankState();
        const busqueda = buscarTitularPorDip(estado, dip);
        const principal =
          busqueda.cuentasTitular.find(esCuentaPersonalViva) || busqueda.cuentas[0] || null;
        return json(res, 200, {
          ok: true,
          dip,
          registrado: !!busqueda.usuario,
          yaTeniaCuentas: busqueda.cuentas.length > 0,
          cuentasEncontradas: busqueda.cuentas.length,
          cuentaPrincipalId: busqueda.usuario?.primaryAccountId || principal?.id || null,
          cuentas: busqueda.cuentas.map(accountToView)
        });
      }

      if (req.method === "POST") {
        // El DIP es SIEMPRE el del token PlacetaID (nunca el del cuerpo); se
        // consume el cuerpo igualmente para no dejar la petición a medias.
        await readBody(req).catch(() => "");
        const registro = await registrarTitularPorPlacetaId({
          dip,
          nombre: String(req.placetaIdUser?.nombre || "").trim(),
          edad: req.placetaIdUser?.edad ?? null,
          origen: "banco-web"
        });
        return json(res, registro.cuentaCreada ? 201 : 200, {
          ok: true,
          registro: {
            dip: registro.dip,
            placetaId: registro.usuario.placetaId,
            usuarioCreado: registro.usuarioCreado,
            cuentaCreada: registro.cuentaCreada,
            yaTeniaCuentas: registro.yaTeniaCuentas,
            cuentasEncontradas: registro.cuentasExistentes.length,
            requiereTutor: registro.requiereTutor,
            cuentaPrincipalId: registro.cuenta?.id || null,
            mensaje: registro.requiereTutor
              ? "Identidad registrada. Al ser menor de edad, la cuenta debe abrirla un tutor legal."
              : registro.cuentaCreada
                ? "Cuenta abierta en el Banco de La Placeta."
                : registro.usuarioCreado
                  ? "Se han encontrado tus cuentas existentes y se ha activado tu acceso."
                  : "Tu acceso al banco ya estaba activo."
          },
          usuario: {
            dip: registro.usuario.dip,
            placetaId: registro.usuario.placetaId,
            displayName: registro.usuario.displayName || "Titular",
            primaryAccountId: registro.usuario.primaryAccountId || null,
            censado: !!registro.usuario.tributosCensusDate
          },
          cuentas: (registro.cuentas || []).map(accountToView)
        });
      }

      return methodNotAllowed(res, ["GET", "POST"]);
    }

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
          primaryAccountId: u.primaryAccountId || owner.accounts[0]?.id || null,
          censado: !!u.tributosCensusDate,
          tributosCensusDate: u.tributosCensusDate || null,
          eip: u.eip || null,
          role: u.role || "Citizen",
          registrado: owner.registrado
        },
        cuentas: owner.accounts.map(accountToView)
      });
    }

    // Nóminas del titular (solo lectura): como empleado (por DIP) o como
    // empresa/gestor (por cuentas Business). Nunca se exponen nóminas ajenas.
    if (req.method === "GET" && path === "/api/web/nominas") {
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const dip = dipNormalizadoDe(req.placetaIdUser);
      const scopedAccounts = cuentasActivas(owner, url);
      const accountIds = new Set(scopedAccounts.map((a) => a.id));
      // Una empresa puede tener varias cuentas bancarias, pero todas las
      // cuentas que pagan sus nóminas deben pertenecer al mismo EIP. Al
      // seleccionar una de ellas, ampliamos el alcance a las cuentas hermanas
      // del EIP sin cambiar companyAccountId: ese campo sigue identificando la
      // cuenta concreta que abona cada nómina.
      const selectedEips = new Set(scopedAccounts.map((a) => String(a.eip || "").trim().toUpperCase()).filter(Boolean));
      const eipAccountIds = new Set(
        owner.accounts
          .filter((a) => selectedEips.has(String(a.eip || "").trim().toUpperCase()))
          .map((a) => a.id)
      );
      const payrollAccountIds = selectedEips.size > 0 ? eipAccountIds : accountIds;
      const scopedDips = new Set(scopedAccounts.flatMap((a) => [a.dip, a.titularDip, a.placetaId].filter(Boolean)).map((value) => String(value).toUpperCase()));
      let estado;
      try { estado = await N.estadoNominas({}, { skipAutoProcess: true }); }
      catch { estado = { config: {}, periodo: "", fechaLimite: null, plazoVencido: false, contratos: [], resumenes: [], periodos: [] }; }
      const esMio = (c) => (scopedAccounts.length === 0 ? false : ((scopedDips.has(dip) && String(c.employeeDip || "").toUpperCase() === dip) || payrollAccountIds.has(c.companyAccountId)));
      const contratos = (estado.contratos || []).filter(esMio);
      const ids = new Set(contratos.map((c) => c.id));
      const resumenes = (estado.resumenes || []).filter((r) => ids.has(r.contrato?.id));
      const periodos = (estado.periodos || []).filter(
        (p) => ids.has(p.contractId) || accountIds.has(p.companyAccountId) || String(p.employeeDip || "").toUpperCase() === dip
      );
      return json(res, 200, {
        config: estado.config,
        periodo: estado.periodo,
        fechaLimite: estado.fechaLimite,
        plazoVencido: estado.plazoVencido,
        contratos,
        resumenes,
        periodos,
        soyEmpresa: contratos.some((c) => payrollAccountIds.has(c.companyAccountId)),
        soyEmpleado: contratos.some((c) => String(c.employeeDip || "").toUpperCase() === dip)
      });
    }

    // Declaraciones tributarias del titular (IRM/IGF) y de sus empresas (EIP).
    if (req.method === "GET" && path === "/api/web/tributos") {
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const dip = dipNormalizadoDe(req.placetaIdUser);
      const scopedAccounts = cuentasActivas(owner, url);
      const scopedIsBusiness = scopedAccounts.length > 0 && scopedAccounts.every((account) => ["business", "state"].includes(String(account.type || account.kind || "").toLowerCase()));
      let declaraciones = [];
      const empresas = [];
      try {
        const [propias, porPlaceta] = await Promise.all([
          T.listDeclarationsForContributor({ dip }),
          T.listDeclarationsForContributor({ placetaId: owner.placetaId })
        ]);
        const vistos = new Set();
        declaraciones = scopedIsBusiness ? [] : [...propias, ...porPlaceta].filter((d) => (vistos.has(d.id) ? false : (vistos.add(d.id), true)));
        for (const emp of empresasDelOwner(owner, cuentasActivas(owner, url))) {
          const contrib = await T.findContributorByEip(emp.eip);
          const decl = contrib ? await T.listDeclarationsForContributor({ placetaId: contrib.placeta_id }) : [];
          empresas.push({ eip: emp.eip, nombre: emp.nombre, declaraciones: decl });
        }
      } catch { /* sin registros tributarios: devolvemos vacío */ }
      return json(res, 200, { declaraciones, empresas });
    }

    // Cartera de inversiones del titular (holdings y operaciones).
    if (req.method === "GET" && path === "/api/web/inversiones") {
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const accountIds = new Set(cuentasActivas(owner, url).map((a) => a.id));
      const holdings = (state.investmentHoldings || []).filter((h) => h && accountIds.has(h.accountId));
      const operaciones = (state.investmentOperations || []).filter((o) => o && accountIds.has(o.accountId));
      return json(res, 200, { holdings, operaciones });
    }

    // Subvenciones del titular (solicitudes recibidas por sus cuentas).
    if (req.method === "GET" && path === "/api/web/subvenciones") {
      try {
        const state = await readBankState();
        const owner = resolveOwner(state, req.placetaIdUser.dip);
        if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
        const accountIds = new Set(cuentasActivas(owner, url).map((a) => a.id));
        const solicitudes = (state.subsidyRequests || []).filter((s) => s && accountIds.has(s.targetAccountId));
        return json(res, 200, { solicitudes, degradado: false });
      } catch (error) {
        // Las subvenciones no deben bloquear el banco completo si la colección
        // todavía no existe en un entorno o el proveedor está temporalmente
        // degradado. La UI puede mostrar estado vacío y reintentar.
        console.error("[web/subvenciones] degraded", error?.message || error);
        return json(res, 200, { solicitudes: [], degradado: true, mensaje: "Las subvenciones no están disponibles temporalmente." });
      }
    }

    if (req.method === "GET" && path.startsWith("/api/web/movimientos/") && path.split("/").length === 5) {
      const transactionId = decodeURIComponent(path.slice("/api/web/movimientos/".length));
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const accountIds = new Set(owner.accounts.map((a) => a.id));
      const transaction = (state.transactions || []).find((item) => item?.id === transactionId);
      if (!transaction || (!accountIds.has(transaction.fromAccountId) && !accountIds.has(transaction.toAccountId))) {
        return json(res, 404, { error: "movimiento_no_encontrado" });
      }
      const accounts = new Map((state.accounts || []).map((account) => [account.id, account]));
      return json(res, 200, {
        movimiento: {
          id: transaction.id,
          fromAccountId: transaction.fromAccountId,
          toAccountId: transaction.toAccountId,
          amountPz: transaction.amountPz ?? transaction.netAmount ?? 0,
          ivaPz: transaction.ivaPz ?? 0,
          concept: descriptiveConcept(transaction, accounts),
          status: transaction.status || "Settled",
          createdAt: transaction.createdAt || null,
          esEntrada: accountIds.has(transaction.toAccountId)
        }
      });
    }

    if (req.method === "GET" && path === "/api/web/movimientos") {
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
      const accountIds = new Set(owner.accounts.map((a) => a.id));
      const accounts = new Map((state.accounts || []).map((account) => [account.id, account]));
      const cuenta = url.searchParams.get("cuenta") || "";
      const cuentaValida = !!cuenta && accountIds.has(cuenta);
      const movs = (state.transactions || [])
        .filter((t) => t && (accountIds.has(t.fromAccountId) || accountIds.has(t.toAccountId)))
        .filter((t) => !cuentaValida || t.fromAccountId === cuenta || t.toAccountId === cuenta)
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
        .slice(0, limit)
        .map((t) => ({
          id: t.id,
          fromAccountId: t.fromAccountId,
          toAccountId: t.toAccountId,
          amountPz: t.amountPz ?? t.netAmount ?? 0,
          ivaPz: t.ivaPz ?? 0,
          concept: descriptiveConcept(t, accounts),
          status: t.status || "Settled",
          createdAt: t.createdAt || null,
          esEntrada: cuentaValida ? t.toAccountId === cuenta : accountIds.has(t.toAccountId)
        }));
      return json(res, 200, { movimientos: movs });
    }

    if (req.method === "GET" && path === "/api/web/tarjetas") {
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const accountIds = new Set(owner.accounts.map((a) => a.id));
      const cuenta = url.searchParams.get("cuenta") || "";
      const cuentaValida = !!cuenta && accountIds.has(cuenta);
      const cards = (state.digitalCards || [])
        .filter((c) => c && accountIds.has(c.accountId))
        .filter((c) => !cuentaValida || c.accountId === cuenta)
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
      const accountIds = new Set(cuentasActivas(owner, url).map((a) => a.id));
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
      const scopedAccounts = cuentasActivas(owner, url);
      const accountIds = new Set(scopedAccounts.map((a) => a.id));
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
        cuentas: scopedAccounts.map((a) => ({
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

    // ── PlaceZUM: código de pago temporal (igual que la app) ───────────
    // POST /api/web/placezum/codigo → genera el código del titular
    // POST /api/web/placezum/pagar  → paga introduciendo un código ajeno
    if (req.method === "POST" && path === "/api/web/placezum/codigo") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const account = owner.accounts.find((a) => a.id === body.from) || owner.accounts[0];
      if (!account) return json(res, 404, { error: "cuenta_no_encontrada" });
      const codigo = generatePlacezumCode(account);
      return json(res, 200, { ok: true, codigo });
    }

    if (req.method === "POST" && path === "/api/web/placezum/pagar") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const { from, codigo, cantidad, concepto } = body;
      const state = await readBankState();
      const owner = resolveOwner(state, req.placetaIdUser.dip);
      if (!owner) return json(res, 404, { error: "titular_no_encontrado" });
      const fromAcc = owner.accounts.find((a) => a.id === from);
      if (!fromAcc) return json(res, 403, { error: "No puedes pagar desde una cuenta que no es tuya" });
      const toAcc = findAccountByPlacezumCode(state, codigo);
      if (!toAcc) return json(res, 404, { error: "Código PlaceZUM no localizado o caducado" });
      if (normalizeIban(toAcc.id) === normalizeIban(fromAcc.id) || normalizeIban(toAcc.iban) === normalizeIban(fromAcc.iban)) {
        return json(res, 400, { error: "No puedes pagarte a ti mismo" });
      }
      const amount = Math.round(Number(cantidad));
      if (!Number.isFinite(amount) || amount <= 0) return json(res, 400, { error: "Cantidad inválida" });
      if ((fromAcc.balancePz ?? 0) < amount) {
        return json(res, 400, { error: "Saldo insuficiente", saldo: fromAcc.balancePz ?? 0, requerido: amount });
      }

      const cleanCode = String(codigo || "").replace(/\D/g, "");
      const now = new Date().toISOString();
      const pendingId = `txw-${crypto.randomBytes(8).toString("hex")}`;
      const executionCode = `GDLP-${crypto.randomBytes(4).toString("hex").toUpperCase()}-${crypto.randomInt(1000, 9999)}`;
      await upsertEntity("bank_transactions", pendingId, {
        id: pendingId, kind: "Placezum", fromAccountId: from, toAccountId: toAcc.id,
        amountPz: amount, ivaPz: 0, netAmount: amount, taxAmount: 0,
        concept: `${concepto || "Pago PlaceZUM"} · Código ${cleanCode}`, status: "Pending",
        firmaRequerida: true, executionCode, source: "banco-web",
        createdAt: now, updatedAt: now, IBAN_Origin: fromAcc.iban || ""
      });
      return json(res, 201, {
        ok: true,
        placezum: {
          id: pendingId,
          estado: "Pending",
          executionCode,
          amountPz: amount,
          destinatario: toAcc.displayName || toAcc.id,
          mensaje: `Pago PlaceZUM de ${amount} Pz registrado. Confírmalo en PlacetaID Móvil para ejecutarlo.`
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
      const empresas = empresasDelOwner(owner, cuentasActivas(owner, url));
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
