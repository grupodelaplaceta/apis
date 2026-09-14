// test-emision.mjs — Guardrail de emisión/quema de PLACETAS.
// Verifica que la emisión es fail-closed: sin clave configurada o con una
// clave distinta a la esperada, NUNCA se autoriza. Ejecutar: node test-emision.mjs
import { autorizarEmision } from "./lib/emision.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} :: ${detail}`); }
}

const CLAVE = "emision-solo-rsp-2026";

console.log("1) Autorización de emisión (clave dedicada):");
{
  check("clave correcta autoriza", autorizarEmision(CLAVE, CLAVE), "clave correcta");
  check("clave incorrecta rechaza", !autorizarEmision("otra-clave", CLAVE), "clave incorrecta");
  check("clave vacía rechaza", !autorizarEmision("", CLAVE), "clave vacía");
  check("clave no configurada rechaza", !autorizarEmision(CLAVE, ""), "sin configurar");
  check("clave nula rechaza", !autorizarEmision(null, CLAVE), "null");
  check("clave con espacios no coincide", !autorizarEmision(` ${CLAVE} `, CLAVE), "espacios");
  check("comparación sensible a mayúsculas", !autorizarEmision(CLAVE.toUpperCase(), CLAVE), "mayúsculas");
  check("clave distinta pero misma longitud rechaza", !autorizarEmision("xxxxxxxxxxxxxxxxxxx", CLAVE), "misma longitud distinta");
}

console.log("\n2) Sin clave de emisión configurada (fail-closed):");
{
  check("header presente pero sin configurar → rechaza", !autorizarEmision(CLAVE, ""), "sin clave config");
  check("ambos vacíos → rechaza", !autorizarEmision("", ""), "ambos vacíos");
}

console.log(`\n${pass} OK, ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);
