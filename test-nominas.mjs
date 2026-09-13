/* ═══════════════════════════════════════════════════════════════════════
   Test offline del motor de nóminas (sin Mongo)
   Verifica el cálculo: salario base + complementos de cargo (los anuales
   repartidos en 12) + actividades confirmadas − retención, además del
   plazo global de cierre.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  periodoDe, periodoAnterior, fechaLimite, plazoVencido, esPeriodoValido,
  complementoMensualPz, calcularNomina, normalizarContrato, idPeriodo,
  CONFIG_POR_DEFECTO
} from "./lib/nominas.js";

let ok = 0;
let fail = 0;
function check(cond, label) {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  const igual = JSON.stringify(a) === JSON.stringify(b);
  check(igual, `${label} → ${JSON.stringify(a)}${igual ? "" : ` (esperado ${JSON.stringify(b)})`}`);
}
function aprox(a, b, label) {
  check(Math.abs(Number(a) - Number(b)) < 0.005, `${label} → ${a}${Math.abs(Number(a) - Number(b)) < 0.005 ? "" : ` (esperado ${b})`}`);
}

console.log("\n── Fechas y periodos ──────────────────────────────────────────");
eq(periodoDe(new Date("2026-09-13T10:00:00Z")), "2026-09", "periodoDe septiembre 2026");
eq(periodoDe(new Date("2026-01-01T00:00:00Z")), "2026-01", "periodoDe enero");
eq(periodoAnterior("2026-09"), "2026-08", "periodoAnterior de 2026-09");
eq(periodoAnterior("2026-01"), "2025-12", "periodoAnterior cruza el año");
check(esPeriodoValido("2026-12"), "2026-12 es válido");
check(!esPeriodoValido("2026-13"), "2026-13 NO es válido");
check(!esPeriodoValido("2026/12"), "2026/12 NO es válido");

eq(fechaLimite("2026-09", 25).toISOString(), "2026-09-25T23:59:59.000Z", "fechaLimite día 25");
eq(fechaLimite("2026-02", 31).toISOString(), "2026-02-28T23:59:59.000Z", "fechaLimite se recorta al último día (febrero)");
check(!plazoVencido("2026-09", 25, new Date("2026-09-25T10:00:00Z")), "el 25 por la mañana aún no vence");
check(plazoVencido("2026-09", 25, new Date("2026-09-26T00:00:00Z")), "el 26 ya venció");
check(idPeriodo("2026-09", "pc-1") === "pp-2026-09-pc-1", "idPeriodo es determinista");

console.log("\n── Complementos ──────────────────────────────────────────────");
aprox(complementoMensualPz({ tipo: "cargo", periodicidad: "mensual", importePz: 120 }), 120, "cargo mensual cobra íntegro");
aprox(complementoMensualPz({ tipo: "cargo", periodicidad: "anual", importePz: 600 }), 50, "cargo anual se reparte en 12");
aprox(complementoMensualPz({ tipo: "actividad", importePz: 175 }), 0, "actividad no suma sin confirmar");

console.log("\n── Normalización del contrato ────────────────────────────────");
const contrato = normalizarContrato({
  id: "pc-test", companyAccountId: "empresa-1", employeeAccountId: "emp-1",
  employeeDip: " 12345678z ", employeeName: "Persona A", roleTitle: "Coordinación",
  salarioBasePz: "1000",
  complementos: [
    { concepto: "Dietas de Junta", tipo: "cargo", periodicidad: "mensual", importePz: "120" },
    { concepto: "Responsabilidad", tipo: "cargo", periodicidad: "anual", importePz: 600 },
    { concepto: "Formación", tipo: "actividad", importePz: 175 },
    { concepto: "Antiguo", tipo: "cargo", importePz: 50, activo: false }
  ]
});
aprox(contrato.grossSalaryPz, 1000, "salarioBasePz se normaliza a grossSalaryPz");
eq(contrato.employeeDip, "12345678Z", "el DIP se guarda en mayúsculas");
eq(contrato.complementos.length, 4, "se conservan los 4 complementos");
eq(contrato.complementos[1].periodicidad, "anual", "el complemento anual mantiene periodicidad");
eq(contrato.complementos[2].periodicidad, "unica", "la actividad queda como puntual");

console.log("\n── Cálculo de la nómina ──────────────────────────────────────");
const cfg = { ...CONFIG_POR_DEFECTO, retencionPct: 10 };

const sinConfirmar = calcularNomina(contrato, {}, cfg);
aprox(sinConfirmar.basePz, 1000, "base");
aprox(sinConfirmar.complementosFijosPz, 170, "fijos = 120 (mensual) + 50 (anual/12); el inactivo no cuenta");
aprox(sinConfirmar.complementosActividadPz, 0, "sin confirmar, la actividad no se paga");
aprox(sinConfirmar.brutoPz, 1170, "bruto = 1000 + 170");
aprox(sinConfirmar.retencionesPz, 117, "retención 10% de 1170");
aprox(sinConfirmar.netoPz, 1053, "neto = 1170 − 117");
eq(sinConfirmar.lineas.filter((l) => l.estado === "no_confirmada").length, 1, "la actividad figura como no confirmada");

const conConfirmar = calcularNomina(contrato, { "comp-x": false }, cfg);
aprox(conConfirmar.complementosActividadPz, 0, "un id que no existe no altera el cálculo");

const actividadId = contrato.complementos[2].id;
const confirmada = calcularNomina(contrato, { [actividadId]: true }, cfg);
aprox(confirmada.complementosActividadPz, 175, "actividad confirmada sí se paga");
aprox(confirmada.brutoPz, 1345, "bruto con actividad = 1000 + 170 + 175");
aprox(confirmada.retencionesPz, 134.5, "retención 10% de 1345");
aprox(confirmada.netoPz, 1210.5, "neto con actividad");
eq(confirmada.lineas.filter((l) => l.estado === "confirmada").length, 1, "la actividad figura como confirmada");

const sinRetencion = calcularNomina(contrato, {}, { ...cfg, retencionPct: 0 });
aprox(sinRetencion.retencionesPz, 0, "sin retención no hay descuento");
aprox(sinRetencion.netoPz, 1170, "neto = bruto si la retención es 0");

console.log("\n── Contrato mínimo ───────────────────────────────────────────");
const minimo = normalizarContrato({ id: "pc-2", companyAccountId: "e", employeeDip: "x", grossSalaryPz: 0 });
eq(minimo.complementos, [], "sin complementos queda lista vacía");
aprox(calcularNomina(minimo, {}, cfg).netoPz, 0, "nómina de 0 no genera importe");

console.log(`\n═══ ${ok} correctas · ${fail} fallidas ═══\n`);
process.exit(fail === 0 ? 0 : 1);
