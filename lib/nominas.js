/* ═══════════════════════════════════════════════════════════════════════
   Banco de La Placeta · Motor de nóminas

   Modelo (extiende lo que ya existía en bank_payroll_contracts /
   bank_payroll_periods, que la app sincroniza):

     contrato  = salario base + complementos
     complemento:
       · tipo "cargo"      → se cobra por tener un cargo / hacer algo de
                             forma continuada. Nunca necesita confirmación.
                             periodicidad "anual" → se reparte en 12 meses.
       · tipo "actividad"  → actividad puntual. SOLO se paga si la empresa
                             confirma, antes del PLAZO GLOBAL, que el
                             trabajador la ha hecho.

     Ciclo mensual:
       1. Durante el mes la empresa confirma actividades (hasta el plazo).
       2. Al llegar el plazo (día global configurable, por defecto 25) el
          periodo se CIERRA solo: se generan las nóminas pendientes.
       3. Si `autoPago` está activo, se PAGAN automáticamente desde la
          cuenta de la empresa al trabajador (kind PayrollLoan, que ya
          aplica la retención del trabajador y la liquida a TGLP).

   El cierre es idempotente (el id del periodo es determinista) y además
   es "perezoso": cualquier lectura del estado de nóminas comprueba los
   vencimientos, de modo que el sistema funciona aunque el cron no corra.
   ═══════════════════════════════════════════════════════════════════════ */

import { mongo } from "./mongo.js";
import { stripEmptyMongoKeys } from "./sanitizeMongo.js";
import { readBankState, writeBankState } from "./bankCollections.js";
import crypto from "crypto";

export const NOMINAS = {
  contratos: "bank_payroll_contracts",
  periodos: "bank_payroll_periods",
  confirmaciones: "bank_payroll_confirmations",
  config: "bank_payroll_config",
  auditoria: "bank_audit_logs"
};

export const CONFIG_POR_DEFECTO = {
  cutoffDay: 25,     // día del mes en que se cierra el periodo (global)
  autoPago: true,    // pagar automáticamente al cerrar (desde la cuenta de la empresa)
  retencionPct: 10,  // cotización del trabajador (se liquida a TGLP)
  activo: true
};

const uuid = () => crypto.randomUUID();
const red2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ── Fechas y periodos (UTC, sin sorpresas de zona horaria) ────────── */

export function periodoDe(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(fecha || Date.now());
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function periodoAnterior(periodo) {
  const [y, m] = String(periodo).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return periodoDe(d);
}

export function esPeriodoValido(periodo) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(periodo || ""));
}

function diasEnMes(periodo) {
  const [y, m] = String(periodo).split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Fecha límite del periodo: día `cutoffDay` (recortado al último día del mes). */
export function fechaLimite(periodo, cutoffDay) {
  const [y, m] = String(periodo).split("-").map(Number);
  const dia = Math.min(Math.max(1, Number(cutoffDay) || CONFIG_POR_DEFECTO.cutoffDay), diasEnMes(periodo));
  return new Date(Date.UTC(y, m - 1, dia, 23, 59, 59));
}

/** ¿Ha llegado ya el plazo de ese periodo? */
export function plazoVencido(periodo, cutoffDay, hoy = new Date()) {
  return new Date(hoy).getTime() >= fechaLimite(periodo, cutoffDay).getTime();
}

/* ── Acceso directo a colecciones propias de nóminas ───────────────── */

async function upsertDoc(coleccion, id, doc) {
  const limpio = stripEmptyMongoKeys({ ...doc, id });
  await (await mongo()).collection(coleccion).replaceOne(
    { _id: id },
    stripEmptyMongoKeys({ _id: id, ...limpio }),
    { upsert: true }
  );
  return limpio;
}

async function leerDoc(coleccion, id) {
  return (await mongo()).collection(coleccion).findOne({ _id: id }, { projection: { _id: 0 } });
}

async function listarDocs(coleccion, filtro = {}) {
  return (await mongo()).collection(coleccion).find(filtro).project({ _id: 0 }).toArray();
}

async function borrarDoc(coleccion, id) {
  return (await mongo()).collection(coleccion).deleteOne({ _id: id });
}

async function auditar(doc) {
  const id = `AUD-${uuid()}`;
  await upsertDoc(NOMINAS.auditoria, id, { id, createdAt: new Date().toISOString(), ...doc });
  return id;
}

/* ── Configuración global ─────────────────────────────────────────── */

export async function leerConfig() {
  const guardada = await leerDoc(NOMINAS.config, "payrollConfig");
  return { ...CONFIG_POR_DEFECTO, ...(guardada || {}) };
}

export async function guardarConfig(patch = {}) {
  const actual = await leerConfig();
  const fusion = { ...actual, ...patch };
  fusion.cutoffDay = Math.min(28, Math.max(1, Number(fusion.cutoffDay) || CONFIG_POR_DEFECTO.cutoffDay));
  fusion.retencionPct = Math.min(35, Math.max(0, Number(fusion.retencionPct) || 0));
  fusion.autoPago = fusion.autoPago !== false;
  fusion.activo = fusion.activo !== false;
  fusion.actualizadoEn = new Date().toISOString();
  await upsertDoc(NOMINAS.config, "payrollConfig", fusion);
  return fusion;
}

/* ── Contratos ────────────────────────────────────────────────────── */

function normalizarComplemento(c, i) {
  const tipo = c.tipo === "actividad" ? "actividad" : "cargo";
  const importe = red2(c.importePz ?? c.importe);
  return {
    id: c.id || `comp-${uuid().slice(0, 8)}`,
    concepto: String(c.concepto || c.tarea || "").trim() || (tipo === "actividad" ? `Actividad ${i + 1}` : `Complemento ${i + 1}`),
    tipo,
    // Un complemento por actividad es puntual: se paga entero al confirmarse.
    periodicidad: tipo === "actividad" ? "unica" : (c.periodicidad === "anual" ? "anual" : "mensual"),
    importePz: importe,
    activo: c.activo !== false
  };
}

export function normalizarContrato(c) {
  return {
    id: c.id || `pc-${uuid().slice(0, 8)}`,
    companyAccountId: c.companyAccountId || "",
    employeeAccountId: c.employeeAccountId || "",
    employeeDip: String(c.employeeDip || "").trim().toUpperCase(),
    employeeName: c.employeeName || "",
    roleTitle: c.roleTitle || "",
    // `grossSalaryPz` es el salario base (nombre histórico que ya usa la app).
    grossSalaryPz: red2(c.grossSalaryPz ?? c.salarioBasePz),
    frequency: c.frequency || "Monthly",
    status: c.status || "Active",
    startDate: c.startDate || periodoDe(new Date()) + "-01",
    endDate: c.endDate || null,
    complementos: (Array.isArray(c.complementos) ? c.complementos : []).map(normalizarComplemento),
    updatedAt: new Date().toISOString()
  };
}

export async function listarContratos(filtro = {}) {
  const todos = await listarDocs(NOMINAS.contratos);
  return todos.filter((c) =>
    (!filtro.companyAccountId || c.companyAccountId === filtro.companyAccountId) &&
    (!filtro.employeeDip || c.employeeDip === String(filtro.employeeDip).toUpperCase()) &&
    (!filtro.activos || c.status === "Active")
  );
}

export async function obtenerContrato(id) {
  return leerDoc(NOMINAS.contratos, id);
}

export async function guardarContrato(datos) {
  const previo = datos.id ? await leerDoc(NOMINAS.contratos, datos.id) : null;
  const contrato = normalizarContrato({ ...(previo || {}), ...datos });
  if (!contrato.companyAccountId) throw new Error("Se requiere la cuenta de la empresa");
  if (!contrato.employeeDip) throw new Error("Se requiere el DIP del trabajador");
  if (contrato.companyAccountId === contrato.employeeAccountId) throw new Error("La empresa y el trabajador no pueden ser la misma cuenta");
  contrato.createdAt = previo?.createdAt || new Date().toISOString();
  await upsertDoc(NOMINAS.contratos, contrato.id, contrato);
  return contrato;
}

export async function borrarContrato(id) {
  await borrarDoc(NOMINAS.contratos, id);
  return { deleted: true, id };
}

/* ── Confirmación de actividades (la empresa) ─────────────────────── */

const idConfirmacion = (periodo, contractId, complementoId) => `${periodo}:${contractId}:${complementoId}`;

export async function listarConfirmaciones(filtro = {}) {
  const todos = await listarDocs(NOMINAS.confirmaciones);
  return todos.filter((c) =>
    (!filtro.periodo || c.periodo === filtro.periodo) &&
    (!filtro.contractId || c.contractId === filtro.contractId)
  );
}

/** Mapa { complementoId: true } de las actividades confirmadas del contrato/periodo. */
export async function mapaConfirmadas(periodo, contractId) {
  const filas = await listarConfirmaciones({ periodo, contractId });
  const mapa = {};
  for (const f of filas) if (f.hecha) mapa[f.complementoId] = true;
  return mapa;
}

export async function confirmarActividad(datos) {
  const { periodo, contractId, complementoId, hecha, autor, nota } = datos;
  if (!esPeriodoValido(periodo)) throw new Error("Periodo inválido (formato YYYY-MM)");
  const contrato = await obtenerContrato(contractId);
  if (!contrato) throw new Error("Contrato no encontrado");
  const complemento = (contrato.complementos || []).find((c) => c.id === complementoId);
  if (!complemento) throw new Error("Complemento no encontrado en el contrato");
  if (complemento.tipo !== "actividad") throw new Error("Solo se confirman complementos de actividad puntual");

  const config = await leerConfig();
  const yaCerrado = await leerDoc(NOMINAS.periodos, idPeriodo(periodo, contractId));
  if (yaCerrado && yaCerrado.status !== "Pending") {
    throw new Error("El periodo ya está cerrado: no se pueden cambiar las confirmaciones");
  }
  if (plazoVencido(periodo, config.cutoffDay)) {
    throw new Error(`El plazo de confirmación de ${periodo} venció el día ${config.cutoffDay}`);
  }

  const doc = {
    id: idConfirmacion(periodo, contractId, complementoId),
    periodo, contractId, complementoId,
    employeeDip: contrato.employeeDip,
    companyAccountId: contrato.companyAccountId,
    hecha: !!hecha,
    autor: autor || "empresa",
    nota: nota || "",
    confirmadoEn: new Date().toISOString()
  };
  await upsertDoc(NOMINAS.confirmaciones, doc.id, doc);
  return doc;
}

/* ── Cálculo de la nómina (puro) ──────────────────────────────────── */

/** Importe mensual de un complemento de cargo (los anuales se reparten en 12). */
export function complementoMensualPz(comp) {
  const importe = Number(comp?.importePz) || 0;
  if (comp?.tipo === "actividad") return 0; // depende de la confirmación
  return comp?.periodicidad === "anual" ? red2(importe / 12) : red2(importe);
}

/**
 * Calcula una nómina: base + complementos de cargo + actividades confirmadas,
 * menos la retención del trabajador.
 * @param contrato normalizado
 * @param confirmadas mapa { complementoId: true } del periodo
 */
export function calcularNomina(contrato, confirmadas = {}, config = CONFIG_POR_DEFECTO) {
  const lineas = [];
  const basePz = red2(contrato.grossSalaryPz);
  lineas.push({
    concepto: contrato.roleTitle ? `Salario base · ${contrato.roleTitle}` : "Salario base",
    tipo: "base", aplicado: true, importePz: basePz
  });

  let fijosPz = 0;
  let actividadPz = 0;

  for (const comp of contrato.complementos || []) {
    if (comp.activo === false) continue;
    if (comp.tipo === "actividad") {
      const hecha = !!confirmadas[comp.id];
      const importe = red2(comp.importePz);
      lineas.push({
        complementoId: comp.id, concepto: comp.concepto, tipo: "actividad",
        aplicado: hecha, estado: hecha ? "confirmada" : "no_confirmada", importePz: importe
      });
      if (hecha) actividadPz += importe;
    } else {
      const importeMes = complementoMensualPz(comp);
      fijosPz += importeMes;
      lineas.push({
        complementoId: comp.id, concepto: comp.concepto, tipo: "cargo",
        periodicidad: comp.periodicidad, aplicado: true,
        importePz: importeMes,
        importeAnualPz: comp.periodicidad === "anual" ? red2(comp.importePz) : null
      });
    }
  }

  fijosPz = red2(fijosPz);
  actividadPz = red2(actividadPz);
  const brutoPz = red2(basePz + fijosPz + actividadPz);
  const retencionPct = Number(config.retencionPct) || 0;
  const retencionesPz = red2(brutoPz * retencionPct / 100);
  const netoPz = red2(brutoPz - retencionesPz);

  return { basePz, complementosFijosPz: fijosPz, complementosActividadPz: actividadPz, brutoPz, retencionPct, retencionesPz, netoPz, lineas };
}

/** Resumen de un contrato para el periodo (lo que la empresa ve antes del cierre). */
export async function resumenContrato(contrato, periodo, config) {
  const cfg = config || await leerConfig();
  const confirmadas = await mapaConfirmadas(periodo, contrato.id);
  const n = calcularNomina(contrato, confirmadas, cfg);
  const periodoDoc = await leerDoc(NOMINAS.periodos, idPeriodo(periodo, contrato.id));
  return {
    contrato, periodo,
    cutoffDay: cfg.cutoffDay,
    fechaLimite: fechaLimite(periodo, cfg.cutoffDay).toISOString(),
    plazoVencido: plazoVencido(periodo, cfg.cutoffDay),
    confirmadas: Object.keys(confirmadas),
    ...n,
    estado: periodoDoc?.status || "Open",
    periodoDoc: periodoDoc || null
  };
}

/* ── Periodos: cierre y pago ──────────────────────────────────────── */

export const idPeriodo = (periodo, contractId) => `pp-${periodo}-${contractId}`;

export async function listarPeriodos(filtro = {}) {
  const todos = await listarDocs(NOMINAS.periodos);
  return todos
    .filter((p) =>
      (!filtro.periodo || p.periodo === filtro.periodo) &&
      (!filtro.companyAccountId || p.companyAccountId === filtro.companyAccountId) &&
      (!filtro.employeeDip || p.employeeDip === String(filtro.employeeDip).toUpperCase()) &&
      (!filtro.status || p.status === filtro.status))
    .sort((a, b) => String(b.periodo).localeCompare(String(a.periodo)));
}

/** Genera (o devuelve) la nómina del contrato para el periodo, sin pagarla. */
export async function generarPeriodo(contrato, periodo, config) {
  const cfg = config || await leerConfig();
  const id = idPeriodo(periodo, contrato.id);
  const existente = await leerDoc(NOMINAS.periodos, id);
  if (existente && existente.status === "Paid") return existente;

  const confirmadas = await mapaConfirmadas(periodo, contrato.id);
  const n = calcularNomina(contrato, confirmadas, cfg);
  const doc = {
    id,
    periodo,
    contractId: contrato.id,
    companyAccountId: contrato.companyAccountId,
    employeeAccountId: contrato.employeeAccountId,
    employeeDip: contrato.employeeDip,
    employeeName: contrato.employeeName,
    roleTitle: contrato.roleTitle,
    label: `Nómina ${periodo}`,
    periodoInicio: `${periodo}-01`,
    periodoFin: `${periodo}-${String(diasEnMes(periodo)).padStart(2, "0")}`,
    ...n,
    status: existente?.status === "Paid" ? "Paid" : "Pending",
    cutoffDay: cfg.cutoffDay,
    fechaLimite: fechaLimite(periodo, cfg.cutoffDay).toISOString(),
    generadoEn: existente?.generadoEn || new Date().toISOString(),
    closedAt: existente?.closedAt || new Date().toISOString(),
    paidAt: existente?.paidAt || null,
    transactionId: existente?.transactionId || null,
    motivo: existente?.motivo || null
  };
  await upsertDoc(NOMINAS.periodos, id, doc);
  return doc;
}

/**
 * Paga una nómina ya generada: mueve el neto desde la cuenta de la empresa
 * al trabajador. El kind `PayrollLoan` es la ruta de nómina que ya valida el
 * servidor (Business → Current, retención a TGLP y suelo de liquidez).
 */
export async function pagarPeriodo(periodoDoc, autor = "cron") {
  if (periodoDoc.status === "Paid") return { ok: true, yaPagado: true, periodo: periodoDoc };
  const neto = red2(periodoDoc.netoPz);
  if (neto <= 0) {
    const doc = { ...periodoDoc, status: "Paid", paidAt: new Date().toISOString(), motivo: "importe_cero" };
    await upsertDoc(NOMINAS.periodos, doc.id, doc);
    return { ok: true, importeCero: true, periodo: doc };
  }

  const state = await readBankState();
  const empresa = (state.accounts || []).find((a) => a.id === periodoDoc.companyAccountId);
  const empleado = (state.accounts || []).find((a) => a.id === periodoDoc.employeeAccountId)
    || (state.accounts || []).find((a) => a.placetaId === periodoDoc.employeeDip);
  if (!empresa) return marcarFallo(periodoDoc, `cuenta_empresa_no_encontrada:${periodoDoc.companyAccountId}`);
  if (!empleado) return marcarFallo(periodoDoc, `cuenta_trabajador_no_encontrada:${periodoDoc.employeeDip}`);

  const txId = uuid();
  const tx = {
    id: txId,
    kind: "PayrollLoan",
    fromAccountId: empresa.id,
    toAccountId: empleado.id,
    amountPz: red2(periodoDoc.brutoPz),
    netAmount: neto,
    taxAmount: red2(periodoDoc.retencionesPz),
    ivaPz: 0,
    concept: `Nómina ${periodoDoc.periodo} · ${periodoDoc.employeeName || periodoDoc.employeeDip}`,
    note: `Nómina automática del Banco de La Placeta · ${periodoDoc.label} · Bruto ${red2(periodoDoc.brutoPz)} Pz · Retención ${periodoDoc.retencionPct}%`,
    status: "Settled",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    IBAN_Origin: empresa.iban || "",
    originalTransactionId: null,
    periodoId: periodoDoc.id,
    contratoId: periodoDoc.contractId,
    dip: periodoDoc.employeeDip
  };

  state.transactions = [...(state.transactions || []), tx];
  let confirmado;
  try {
    confirmado = await writeBankState(state, { includeState: true });
  } catch (e) {
    return marcarFallo(periodoDoc, `error_banco:${e.message}`);
  }

  const doc = {
    ...periodoDoc,
    status: "Paid",
    paidAt: new Date().toISOString(),
    transactionId: txId,
    motivo: null,
    pagoDetalle: {
      fromAccountId: empresa.id,
      toAccountId: empleado.id,
      brutoPz: red2(periodoDoc.brutoPz),
      retencionesPz: red2(periodoDoc.retencionesPz),
      netoPz: neto,
      autor
    }
  };
  await upsertDoc(NOMINAS.periodos, doc.id, doc);
  await auditar({
    action: "nomina-pagar",
    admin: autor,
    periodoId: doc.id,
    periodo: doc.periodo,
    contratoId: doc.contractId,
    dip: doc.employeeDip,
    cuantia: neto,
    fromAccountId: empresa.id,
    toAccountId: empleado.id,
    transactionId: txId,
    motivo: doc.label
  });
  return { ok: true, periodo: doc, transactionId: txId, state: confirmado?.state };
}

async function marcarFallo(periodoDoc, motivo) {
  const doc = { ...periodoDoc, status: periodoDoc.status === "Paid" ? "Paid" : "Pending", motivo, intentadoEn: new Date().toISOString() };
  await upsertDoc(NOMINAS.periodos, doc.id, doc);
  await auditar({ action: "nomina-pago-fallido", admin: "cron", periodoId: doc.id, motivo });
  return { ok: false, motivo, periodo: doc };
}

/**
 * Cierra (genera) y, si procede, paga las nóminas de un periodo.
 * Idempotente: repetirlo no duplica ni vuelve a pagar.
 */
export async function cerrarPeriodo(periodo, opciones = {}) {
  if (!esPeriodoValido(periodo)) throw new Error("Periodo inválido (formato YYYY-MM)");
  const cfg = opciones.config || await leerConfig();
  const contratos = (await listarContratos()).filter((c) => c.status === "Active" && c.frequency !== "Ended");
  const pagar = opciones.pagar !== undefined ? !!opciones.pagar : cfg.autoPago;
  const autor = opciones.autor || "cron";
  const resultados = [];

  for (const contrato of contratos) {
    if (contrato.frequency && contrato.frequency !== "Monthly" && !opciones.forzar) {
      resultados.push({ contratoId: contrato.id, omitido: `frecuencia_${contrato.frequency}` });
      continue;
    }
    let doc = await generarPeriodo(contrato, periodo, cfg);
    doc = await leerDoc(NOMINAS.periodos, doc.id);
    if (pagar && doc.status !== "Paid") {
      const r = await pagarPeriodo(doc, autor);
      resultados.push({ contratoId: contrato.id, periodoId: r.periodo.id, pagado: !!r.ok, motivo: r.motivo || null, netoPz: r.periodo.netoPz });
    } else {
      resultados.push({ contratoId: contrato.id, periodoId: doc.id, pagado: false, estado: doc.status, netoPz: doc.netoPz });
    }
  }
  return { periodo, pagar, contratos: contratos.length, resultados };
}

/**
 * Comprueba los plazos vencidos y cierra/paga lo que toque.
 * Se llama de forma perezosa en cada lectura y también desde el cron.
 */
export async function procesarVencimientos(hoy = new Date(), opciones = {}) {
  const cfg = await leerConfig();
  if (!cfg.activo) return { omitido: "nominas_desactivadas" };
  const actual = periodoDe(hoy);
  const anterior = periodoAnterior(actual);
  const procesados = [];

  for (const periodo of [anterior, actual]) {
    if (!plazoVencido(periodo, cfg.cutoffDay, hoy)) continue;
    const abiertos = (await listarPeriodos({ periodo })).filter((p) => p.status !== "Paid");
    const contratos = (await listarContratos()).filter((c) => c.status === "Active");
    const pendienteDeGenerar = contratos.some((c) => !abiertos.some((p) => p.contractId === c.id) || c.status === "Active");
    if (!pendienteDeGenerar && abiertos.length === 0) continue;
    const r = await cerrarPeriodo(periodo, { config: cfg, autor: opciones.autor || "auto", pagar: cfg.autoPago });
    const pagados = r.resultados.filter((x) => x.pagado).length;
    if (pagados > 0 || r.resultados.length > 0) procesados.push({ periodo, ...r, pagados });
  }
  return { hoy: new Date(hoy).toISOString(), cutoffDay: cfg.cutoffDay, autoPago: cfg.autoPago, procesados };
}

/** Vista completa para la web/app: config + contratos + resúmenes del periodo. */
export async function estadoNominas(filtro = {}) {
  await procesarVencimientos(new Date(), { autor: "lazy" }).catch(() => null);
  const config = await leerConfig();
  const periodo = esPeriodoValido(filtro.periodo) ? filtro.periodo : periodoDe(new Date());
  const contratos = await listarContratos(filtro);
  const resumenes = [];
  for (const c of contratos) resumenes.push(await resumenContrato(c, periodo, config));
  return {
    config,
    periodo,
    fechaLimite: fechaLimite(periodo, config.cutoffDay).toISOString(),
    plazoVencido: plazoVencido(periodo, config.cutoffDay),
    contratos,
    resumenes,
    periodos: await listarPeriodos(filtro)
  };
}
