/**
 * Banco de La Placeta — Alta de titulares por DIP de PlacetaID
 * -----------------------------------------------------------
 * Cualquier DIP válido de PlacetaID puede darse de alta en el banco por sí
 * mismo (sin pasar por el panel de administración).
 *
 * Regla de oro: ANTES de crear nada se BUSCA por el DIP en el estado real
 * (bank_users + bank_accounts + bank_account_holders). Si el ciudadano ya
 * tiene cuentas —aunque no tuviera usuario del banco, que es el caso de los
 * titulares migrados— NO se duplica nada: se vincula. Solo si no tiene nada se
 * le abre una cuenta corriente ciudadana con IBAN GDLP-AP##-###.
 */
import crypto from "crypto";
import { readBankState, upsertEntity } from "./bankCollections.js";

// DNI (8 dígitos + letra) o NIE (X/Y/Z + 7-8 dígitos + letra).
export const DIP_PATTERN = /^(\d{8}[A-Z]|[XYZ]\d{7,8}[A-Z])$/;

// Cuentas institucionales: nunca pertenecen a un ciudadano de a pie.
const CUENTAS_SISTEMA = new Set([
  "TGLP",
  "AGLDP",
  "FOUNDATION_RBU",
  "CAPITALIA_BANK",
  "VAULT_EMISION",
  "FUND-BLP"
]);

// Tipos de cuenta que puede tener un ciudadano (persona física).
const TIPOS_PERSONALES = new Set(["current", "savings", "personal", "shared", "joint"]);

const EDAD_ADULTO = 18;

export function dipNormalizado(value) {
  return String(value ?? "").trim().toUpperCase();
}

/** Identificador de titular sin espacios ni signos: "PLID-X" -> "PLIDX". */
export function normalizeOwnerId(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Identidad "core" de un titular: "PLID-12345678Z", "DIP-12345678Z" y
 * "12345678Z" son la MISMA persona. El banco guarda el DIP en `placetaId`
 * (a veces con prefijo antiguo) y en `dip`, así que comparamos por el núcleo.
 */
export function ownerIdCore(value) {
  return normalizeOwnerId(value).replace(/^(PLID|DIP)/, "");
}

/** ¿Dos identificadores apuntan al mismo titular? (nunca compara vacíos). */
export function mismosTitulares(a, b) {
  const core = ownerIdCore(a);
  return core.length >= 8 && core === ownerIdCore(b);
}

export function esDipValido(value) {
  return DIP_PATTERN.test(dipNormalizado(value));
}

export function esCuentaDeSistema(account) {
  return !account || CUENTAS_SISTEMA.has(String(account.id || "")) || CUENTAS_SISTEMA.has(String(account.placetaId || ""));
}

/** Cuenta personal viva: ni cerrada, ni de sistema, ni de empresa/estado. */
export function esCuentaPersonalViva(account) {
  if (!account || account.closedAt || esCuentaDeSistema(account)) return false;
  const tipo = String(account.type || "Current").toLowerCase();
  return TIPOS_PERSONALES.has(tipo);
}

/**
 * IBAN del Banco de La Placeta (formato APP GDLP-AP##-###), determinista a
 * partir del DIP y desplazado si el cuerpo calculado ya está en uso.
 */
export function generarIban(dip, usados = new Set()) {
  const seed = normalizeOwnerId(dip) || "0000";
  let base = 17;
  for (const ch of seed) base = (base * 31 + ch.charCodeAt(0)) % 1000;
  for (let i = 0; i < 1000; i += 1) {
    const cuerpo = (base + i) % 1000;
    const control = ((cuerpo * 97) + 13) % 100;
    const iban = `GDLP-AP${String(control).padStart(2, "0")}-${String(cuerpo).padStart(3, "0")}`;
    if (!usados.has(iban)) return iban;
  }
  throw new Error("iban_no_disponible");
}

/**
 * Busca por DIP todo lo que ya existe en el banco para ese ciudadano.
 * Devuelve usuarios del banco, cuentas propias y cuentas de las que solo es
 * cotitular/gestor (bank_account_holders).
 */
export function buscarTitularPorDip(state, dip) {
  const dipLimpio = dipNormalizado(dip);
  const usuarios = (state.users || []).filter(
    (u) => u && (mismosTitulares(u.dip, dipLimpio) || mismosTitulares(u.placetaId, dipLimpio))
  );

  // Alias con los que el banco puede haber guardado a esta persona: el DIP y
  // los placetaIds de sus usuarios ya localizados.
  const cores = new Set(
    [dipLimpio, ...usuarios.flatMap((u) => [u.dip, u.placetaId])]
      .map(ownerIdCore)
      .filter((core) => core.length >= 8)
  );
  const enAlias = (value) => {
    const core = ownerIdCore(value);
    return core.length >= 8 && cores.has(core);
  };

  // Las cuentas pueden estar guardadas con un alias distinto al del usuario
  // (p. ej. el DIP sin prefijo en los titulares migrados): por eso ampliamos
  // los alias con el placetaId de cada cuenta que va apareciendo.
  const cuentas = [];
  for (let pasada = 0; pasada < 3; pasada += 1) {
    let nueva = false;
    for (const a of state.accounts || []) {
      if (!a || esCuentaDeSistema(a) || cuentas.includes(a)) continue;
      if (!enAlias(a.placetaId) && !enAlias(a.dip) && !enAlias(a.titularDip) && !enAlias(a.cotitularDip)) continue;
      cuentas.push(a);
      const core = ownerIdCore(a.placetaId);
      if (core.length >= 8 && !cores.has(core)) {
        cores.add(core);
        nueva = true;
      }
    }
    if (!nueva) break;
  }

  // Cotitulares/gestores (bank_account_holders) y cuenta principal del usuario.
  const holderIds = (state.accountHolders || [])
    .filter((h) => h && enAlias(h.placetaId))
    .map((h) => String(h.accountId || "").trim())
    .filter(Boolean);
  const primaryIds = usuarios
    .map((u) => String(u.primaryAccountId || "").trim())
    .filter(Boolean);

  for (const a of state.accounts || []) {
    if (!a || esCuentaDeSistema(a) || cuentas.includes(a)) continue;
    if (holderIds.includes(String(a.id || "")) || primaryIds.includes(String(a.id || ""))) cuentas.push(a);
  }

  const esTitular = (a) => enAlias(a.placetaId) || enAlias(a.dip) || enAlias(a.titularDip);
  return {
    dip: dipLimpio,
    usuarios,
    usuario: usuarios[0] || null,
    cuentas,
    cuentasTitular: cuentas.filter(esTitular),
    cuentasCotitular: cuentas.filter((a) => !esTitular(a))
  };
}

/**
 * Decide QUÉ hay que crear para dar de alta al titular, sin tocar la base de
 * datos (función pura → fácil de probar). El llamante persiste el plan.
 */
export function planificarRegistro(state, { dip, nombre = "", edad = null, ahora = new Date().toISOString() }) {
  const dipLimpio = dipNormalizado(dip);
  const busqueda = buscarTitularPorDip(state, dipLimpio);
  const edadNum = Number.isFinite(Number(edad)) && edad !== null && edad !== "" ? Number(edad) : null;
  const menor = edadNum !== null && edadNum < EDAD_ADULTO;

  // Cuenta principal: la personal viva que ya tuviera (propia primero).
  const principalExistente =
    busqueda.cuentasTitular.find(esCuentaPersonalViva) ||
    busqueda.cuentas.find(esCuentaPersonalViva) ||
    busqueda.cuentasTitular[0] ||
    null;

  // El placetaId canónico es el que usan sus cuentas reales (para que
  // resolveOwner() lo encuentre); si no hay cuentas, el propio DIP.
  const placetaIdCanonico = principalExistente?.placetaId || busqueda.usuario?.placetaId || dipLimpio;

  const usuario = busqueda.usuario
    ? {
        ...busqueda.usuario,
        dip: dipLimpio,
        placetaId: placetaIdCanonico,
        displayName: busqueda.usuario.displayName || nombre || principalExistente?.displayName || dipLimpio
      }
    : {
        dip: dipLimpio,
        placetaId: placetaIdCanonico,
        displayName: nombre || dipLimpio,
        role: "Citizen",
        banned: false,
        registroOrigen: "placetaid",
        createdAt: ahora
      };
  if (edadNum !== null && usuario.verifiedAge == null) usuario.verifiedAge = edadNum;

  let cuenta = principalExistente;
  let cuentaCreada = false;

  // Los menores no abren cuenta corriente por sí solos (necesitan tutor): se
  // registra su identidad y se les vincula lo que ya tuvieran.
  if (!cuenta && !menor) {
    const usados = new Set((state.accounts || []).map((a) => a.iban).filter(Boolean));
    const accountId = `acc-${Date.now()}-${crypto.randomInt(100, 999)}`;
    cuenta = {
      id: accountId,
      displayName: `${nombre || dipLimpio} - Personal (Banco de La Placeta)`,
      kind: "CITIZEN",
      balancePz: 0,
      placetaId: dipLimpio,
      role: "Citizen",
      type: "Current",
      iban: generarIban(dipLimpio, usados),
      huchaLocked: false,
      citizenshipTier: "CiudadaniaPlena",
      complianceStatus: "Clear",
      fundsJustificationApproved: false,
      listedInvestmentFund: false,
      investmentRiskLevel: 3,
      createdAt: ahora
    };
    cuentaCreada = true;
  }

  if (cuenta) usuario.primaryAccountId = cuenta.id;
  else delete usuario.primaryAccountId;

  return {
    dip: dipLimpio,
    menor,
    requiereTutor: menor && !cuenta,
    usuario,
    usuarioExistente: !!busqueda.usuario,
    cuenta,
    cuentaCreada,
    cuentas: busqueda.cuentas,
    cuentasExistentes: busqueda.cuentas,
    cuentasCotitular: busqueda.cuentasCotitular,
    yaTeniaCuentas: busqueda.cuentas.length > 0
  };
}

/**
 * Alta real del titular (idempotente): busca por DIP, vincula lo existente y
 * solo crea cuenta/usuario cuando faltan. Registra auditoría.
 */
export async function registrarTitularPorPlacetaId({ dip, nombre = "", edad = null, origen = "placetaid" }) {
  if (!esDipValido(dip)) {
    const error = new Error("dip_invalido");
    error.statusCode = 400;
    throw error;
  }

  const ahora = new Date().toISOString();
  const state = await readBankState();
  const plan = planificarRegistro(state, { dip, nombre, edad, ahora });

  if (plan.cuentaCreada && plan.cuenta) {
    await upsertEntity("bank_accounts", plan.cuenta.id, plan.cuenta);
  }

  const usuarioGuardado = { ...plan.usuario, updatedAt: ahora };
  await upsertEntity("bank_users", usuarioGuardado.dip || usuarioGuardado.placetaId, usuarioGuardado);

  const logId = crypto.randomUUID();
  await upsertEntity("bank_audit_logs", logId, {
    id: logId,
    action: "registro_placetaid",
    admin: plan.dip,
    dip: plan.dip,
    accountId: plan.cuenta?.id || null,
    iban: plan.cuenta?.iban || null,
    usuarioCreado: !plan.usuarioExistente,
    cuentaCreada: plan.cuentaCreada,
    cuentasEncontradas: plan.cuentasExistentes.length,
    origen,
    createdAt: ahora,
    updatedAt: ahora
  });

  return {
    ...plan,
    usuario: usuarioGuardado,
    usuarioCreado: !plan.usuarioExistente,
    auditLogId: logId
  };
}
