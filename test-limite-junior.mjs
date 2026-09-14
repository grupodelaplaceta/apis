// test-limite-junior.mjs — Límite Junior de 500 Pz/mes + whitelist de contraparte.
// Ejecutar: node test-limite-junior.mjs
import {
  esJunior,
  contrapartePermitida,
  movimientosMensualesJunior,
  validarTransferenciaJunior,
  LIMITE_MENSUAL_JUNIOR
} from "./lib/limite-junior.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} :: ${detail}`); }
}

const MES = "2026-09";
const junior = { id: "u-nino", type: "Child", citizenshipTier: "JuniorBasica", cotitularDip: "11111111D" };
const junior2 = { id: "u-otro", type: "Child", citizenshipTier: "JuniorBasica", cotitularDip: "22222222E" };
const organismo = { id: "CAPITALIA_BANK", type: "Business" };
const entidad = { id: "TGLP", type: "State" };
const tutor = { id: "u-tutor", type: "Current", placetaId: "11111111D" };
const ciudadano = { id: "u-adulto", type: "Current", placetaId: "99999999R" };

console.log("1) Detección de cuenta Junior:");
{
  check("type Child es Junior", esJunior(junior), "Child");
  check("citizenshipTier Junior* es Junior", esJunior({ type: "Savings", citizenshipTier: "JuniorBasica" }), "JuniorBasica");
  check("cuenta Current no es Junior", !esJunior(ciudadano), "Current");
  check("cuenta Business no es Junior", !esJunior(organismo), "Business");
  check("nulo no es Junior", !esJunior(null), "null");
}

console.log("2) Whitelist de contraparte no-Junior:");
{
  check("organismo permitido", contrapartePermitida(organismo, junior), "CAPITALIA_BANK");
  check("entidad (State) permitida", contrapartePermitida(entidad, junior), "TGLP");
  check("cotitular (tutor) permitido", contrapartePermitida(tutor, junior), "tutor");
  check("ciudadano cualquiera NO permitido", !contrapartePermitida(ciudadano, junior), "adulto ajeno");
}

console.log("3) Suma mensual Junior ↔ no-Junior:");
{
  const state = {
    accounts: [junior, junior2, organismo, ciudadano],
    transactions: [
      { fromAccountId: "CAPITALIA_BANK", toAccountId: "u-nino", amountPz: 100, status: "Settled", createdAt: `${MES}-01T00:00:00Z`, kind: "Transfer" },
      { fromAccountId: "u-nino", toAccountId: "u-otro", amountPz: 300, status: "Settled", createdAt: `${MES}-02T00:00:00Z`, kind: "Transfer" }, // Junior↔Junior: exento
      { fromAccountId: "u-nino", toAccountId: "u-adulto", amountPz: 50, status: "Settled", createdAt: `${MES}-03T00:00:00Z`, kind: "Transfer" },
      { fromAccountId: "u-nino", toAccountId: "TGLP", amountPz: 10, status: "Settled", createdAt: `${MES}-04T00:00:00Z`, kind: "Tax" }, // Tax: exento
      { fromAccountId: "CAPITALIA_BANK", toAccountId: "u-nino", amountPz: 999, status: "Settled", createdAt: "2026-08-15T00:00:00Z", kind: "Transfer" } // mes anterior: exento
    ]
  };
  check("suma 150 (100 + 50, ignora Junior↔Junior, Tax y mes anterior)", movimientosMensualesJunior(state, "u-nino", MES) === 150, String(movimientosMensualesJunior(state, "u-nino", MES)));
}

console.log("4) Validación de transferencia Junior:");
{
  const base = { accounts: [junior, junior2, organismo, entidad, tutor, ciudadano], transactions: [] };
  // Junior ↔ Junior: exento
  check("Junior→Junior exento", validarTransferenciaJunior(base, "u-nino", "u-otro", 1000, MES).ok, "junior-junior");
  // Organismo → Junior permitido
  check("organismo→Junior permitido", validarTransferenciaJunior(base, "CAPITALIA_BANK", "u-nino", 100, MES).ok, "organismo");
  // Ciudadano → Junior: whitelist rechaza
  const whitelist = validarTransferenciaJunior(base, "u-adulto", "u-nino", 10, MES);
  check("ciudadano→Junior rechazado (whitelist)", !whitelist.ok && whitelist.error === "contraparte_no_permitida", JSON.stringify(whitelist));
  // Tutor → Junior permitido (cotitular)
  check("tutor→Junior permitido (cotitular)", validarTransferenciaJunior(base, "u-tutor", "u-nino", 200, MES).ok, "tutor");
  // Exceso de 500/mes
  const conAcumulado = {
    accounts: [junior, organismo],
    transactions: [{ fromAccountId: "CAPITALIA_BANK", toAccountId: "u-nino", amountPz: 400, status: "Settled", createdAt: `${MES}-01T00:00:00Z`, kind: "Transfer" }]
  };
  const exceso = validarTransferenciaJunior(conAcumulado, "CAPITALIA_BANK", "u-nino", 200, MES);
  check("excede 500/mes → rechazado", !exceso.ok && exceso.error === "limite_mensual_junior_excedido", JSON.stringify(exceso));
  check("acumulado reportado correcto", exceso.acumulado === 400, String(exceso.acumulado));
  // Justo en el límite permitido
  check("justo en 500 permitido", validarTransferenciaJunior(conAcumulado, "CAPITALIA_BANK", "u-nino", 100, MES).ok, "400+100=500");
  // Salida Junior → ciudadano rechazada (whitelist)
  const salida = validarTransferenciaJunior(base, "u-nino", "u-adulto", 10, MES);
  check("Junior→ciudadano rechazado (whitelist)", !salida.ok && salida.error === "contraparte_no_permitida", JSON.stringify(salida));
}

console.log("5) Límite configurable y acumulado de lote:");
{
  const state = { accounts: [junior, organismo], transactions: [] };
  check("límite personalizado rechaza exceso", !validarTransferenciaJunior(state, "CAPITALIA_BANK", "u-nino", 300, MES, 200).ok, "300>200");
  check("dentro de límite personalizado ok", validarTransferenciaJunior(state, "CAPITALIA_BANK", "u-nino", 150, MES, 200).ok, "150<200");
  // 400 ya acumulados en el lote + 200 = 600 > 500
  const lote = validarTransferenciaJunior(state, "CAPITALIA_BANK", "u-nino", 200, MES, 500, 400);
  check("acumuladoExtra bloquea el lote", !lote.ok && lote.error === "limite_mensual_junior_excedido", JSON.stringify(lote));
  check("devuelve juniorId para acumular", validarTransferenciaJunior(state, "CAPITALIA_BANK", "u-nino", 100, MES).juniorId === "u-nino", "juniorId");
}

console.log(`\n${pass} OK, ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);
