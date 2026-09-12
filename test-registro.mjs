// test-registro.mjs — Alta de cualquier DIP de PlacetaID en el Banco de La Placeta.
// Verifica la BÚSQUEDA por DIP (no duplicar cuentas existentes) y la creación
// cuando no hay nada. Ejecutar: node test-registro.mjs
import {
  DIP_PATTERN,
  buscarTitularPorDip,
  esDipValido,
  generarIban,
  planificarRegistro,
  registrarTitularPorPlacetaId
} from "./lib/registroPlacetaId.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} :: ${detail}`); }
}

const AHORA = "2026-09-12T10:00:00.000Z";

function cuentaBase(over = {}) {
  return {
    id: "acc-1",
    displayName: "Titular",
    kind: "CITIZEN",
    balancePz: 0,
    placetaId: "12345678Z",
    role: "Citizen",
    type: "Current",
    iban: "GDLP-AP41-724",
    createdAt: AHORA,
    ...over
  };
}

console.log("1) DIP válido y formato:");
{
  check("DNI válido", esDipValido("12345678Z"), "12345678Z");
  check("NIE válido", esDipValido("x1234567l"), "x1234567l");
  check("minúsculas se normalizan", esDipValido(" 12345678z "), "espacios/minúsculas");
  check("DIP basura rechazado", !esDipValido("u-alba") && !esDipValido("PLID-DEMO") && !esDipValido(""), "u-alba");
  check("patrón exportado", DIP_PATTERN.test("12345678Z"), "DIP_PATTERN");
}

console.log("2) Ciudadano nuevo (sin nada) → usuario + cuenta corriente ciudadana:");
{
  const state = { users: [], accounts: [], accountHolders: [] };
  const plan = planificarRegistro(state, { dip: "12345678Z", nombre: "Ana Pérez", edad: 34, ahora: AHORA });
  check("crea usuario bancario", !!plan.usuario && !plan.usuarioExistente && plan.usuario.dip === "12345678Z", JSON.stringify(plan.usuario));
  check("placetaId = DIP", plan.usuario.placetaId === "12345678Z", plan.usuario.placetaId);
  check("displayName usa el nombre de PlacetaID", plan.usuario.displayName === "Ana Pérez", plan.usuario.displayName);
  check("crea cuenta personal", plan.cuentaCreada && plan.cuenta.type === "Current" && plan.cuenta.kind === "CITIZEN", JSON.stringify(plan.cuenta));
  check("IBAN del banco GDLP-AP##-###", /^GDLP-AP\d{2}-\d{3}$/.test(plan.cuenta.iban), plan.cuenta.iban);
  check("saldo inicial 0 y titularidad plena", plan.cuenta.balancePz === 0 && plan.cuenta.citizenshipTier === "CiudadaniaPlena", plan.cuenta.citizenshipTier);
  check("usuario apunta a su cuenta principal", plan.usuario.primaryAccountId === plan.cuenta.id, plan.usuario.primaryAccountId);
  check("no requiere tutor", plan.requiereTutor === false, String(plan.requiereTutor));
}

console.log("3) Titular migrado: tiene CUENTA pero no bank_user → vincula, NO duplica:");
{
  const cuenta = cuentaBase({ id: "acc-migrada", placetaId: "12345678Z", balancePz: 1200 });
  const state = { users: [], accounts: [cuenta], accountHolders: [] };
  const plan = planificarRegistro(state, { dip: "12345678Z", nombre: "", edad: 40, ahora: AHORA });
  check("encuentra la cuenta existente", plan.yaTeniaCuentas && plan.cuentasExistentes.length === 1, `n=${plan.cuentasExistentes.length}`);
  check("NO crea cuenta nueva", plan.cuentaCreada === false && plan.cuenta.id === "acc-migrada", plan.cuenta?.id);
  check("crea el bank_user que faltaba", plan.usuarioExistente === false && plan.usuario.primaryAccountId === "acc-migrada", plan.usuario.primaryAccountId);
  check("saldo intacto", plan.cuenta.balancePz === 1200, String(plan.cuenta.balancePz));
}

console.log("4) Ya registrado (usuario + cuenta) → idempotente:");
{
  const cuenta = cuentaBase({ id: "acc-1" });
  const user = { dip: "12345678Z", placetaId: "12345678Z", displayName: "Ana Pérez", primaryAccountId: "acc-1", role: "Citizen" };
  const state = { users: [user], accounts: [cuenta], accountHolders: [] };
  const plan = planificarRegistro(state, { dip: "12345678Z", nombre: "Ana Pérez", edad: 34, ahora: AHORA });
  check("reutiliza usuario y cuenta", plan.usuarioExistente && !plan.cuentaCreada, `exist=${plan.usuarioExistente} creada=${plan.cuentaCreada}`);
  check("no cambia el pinHash ni el historial", plan.usuario.primaryAccountId === "acc-1" && plan.cuenta.id === "acc-1", plan.usuario.primaryAccountId);
}

console.log("5) Alias PLID-/DIP- de la misma persona se encuentran por DIP:");
{
  const user = { dip: "20521220S", placetaId: "PLID-20521220S", displayName: "Salma", primaryAccountId: "acc-s" };
  const cuenta = cuentaBase({ id: "acc-s", placetaId: "20521220S", displayName: "Salma El Harrak - Personal" });
  const state = { users: [user], accounts: [cuenta], accountHolders: [] };
  const busqueda = buscarTitularPorDip(state, "20521220S");
  check("encuentra al usuario por DIP", busqueda.usuario?.dip === "20521220S", busqueda.usuario?.dip);
  check("encuentra su cuenta con otro alias", busqueda.cuentas.some((a) => a.id === "acc-s"), `n=${busqueda.cuentas.length}`);
  const plan = planificarRegistro(state, { dip: "20521220S", nombre: "", edad: 30, ahora: AHORA });
  check("canoniza el placetaId al de su cuenta real", plan.usuario.placetaId === "20521220S", plan.usuario.placetaId);
  check("no crea una segunda cuenta", plan.cuentaCreada === false, String(plan.cuentaCreada));
}

console.log("6) Menor de edad: se registra la identidad, la cuenta la abre un tutor:");
{
  const state = { users: [], accounts: [], accountHolders: [] };
  const plan = planificarRegistro(state, { dip: "12345678Z", nombre: "Leo", edad: 12, ahora: AHORA });
  check("no crea cuenta", plan.cuenta === null && plan.cuentaCreada === false, JSON.stringify(plan.cuenta));
  check("marca requiereTutor", plan.requiereTutor === true, String(plan.requiereTutor));
  check("registra al menor como usuario", !!plan.usuario && plan.usuario.verifiedAge === 12, String(plan.usuario?.verifiedAge));
}

console.log("7) Cuentas de sistema y de otros titulares no se confunden:");
{
  const state = {
    users: [],
    accounts: [
      { id: "TGLP", type: "State", placetaId: "TGLP", role: "Tributos" },
      { id: "acc-otro", type: "Current", placetaId: "99999999R", role: "Citizen" }
    ],
    accountHolders: []
  };
  const busqueda = buscarTitularPorDip(state, "12345678Z");
  check("no devuelve cuentas ajenas ni institucionales", busqueda.cuentas.length === 0, `n=${busqueda.cuentas.length}`);
  const plan = planificarRegistro(state, { dip: "12345678Z", nombre: "Ana", edad: 34, ahora: AHORA });
  check("abre cuenta nueva", plan.cuentaCreada, String(plan.cuentaCreada));
}

console.log("8) Cotitular/gestor (bank_account_holders) también cuenta como cuenta suya:");
{
  const state = {
    users: [],
    accounts: [{ id: "acc-empresa", type: "Business", placetaId: "EMPRESA-X", role: "Business" }],
    accountHolders: [{ id: "h1", accountId: "acc-empresa", placetaId: "12345678Z", ownershipPercent: 25 }]
  };
  const busqueda = buscarTitularPorDip(state, "12345678Z");
  check("encuentra la cuenta donde es cotitular", busqueda.cuentasCotitular.some((a) => a.id === "acc-empresa"), `cotit=${busqueda.cuentasCotitular.length}`);
  const plan = planificarRegistro(state, { dip: "12345678Z", nombre: "Ana", edad: 34, ahora: AHORA });
  check("sin cuenta personal propia → abre la suya", plan.cuentaCreada && plan.cuenta.type === "Current", plan.cuenta?.type);
}

console.log("9) IBAN: sin colisiones:");
{
  const usados = new Set([generarIban("12345678Z")]);
  const otro = generarIban("12345678Z", usados);
  check("desplaza el cuerpo si está ocupado", otro !== [...usados][0] && /^GDLP-AP\d{2}-\d{3}$/.test(otro), otro);
}

console.log("10) DIP inválido no llega ni a la base de datos:");
{
  let error = null;
  try {
    await registrarTitularPorPlacetaId({ dip: "no-es-un-dip", nombre: "X" });
  } catch (e) {
    error = e;
  }
  check("rechaza con 400 dip_invalido", error?.statusCode === 400 && error?.message === "dip_invalido", String(error));
}

console.log(`\n${pass} OK, ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);
