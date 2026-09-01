// test-reconcile.mjs — Verificación local de la corrección de reconciliación bancaria.
// Ejecutar: node test-reconcile.mjs
import { reconcileIncomingState } from "./lib/bankCollections.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} :: ${detail}`); }
}

const A = { id: "a", type: "Current", balancePz: 100, iban: "GDLP-AP00-001" };
const B = { id: "b", type: "Current", balancePz: 0, iban: "GDLP-AP00-002" };
const TGLP = { id: "TGLP", type: "State", balancePz: 0, iban: "GDLP-AP98-605" };
const NOW = "2026-09-02T10:00:00.000Z";
const bal = (state, id) => state.accounts.find((a) => a.id === id).balancePz;
const txCount = (state, id) => state.transactions.filter((t) => t.id === id).length;

console.log("1) Transición Pending → Settled (transferencia web confirmada en la app):");
{
  const pending = { id: "tx-pend", kind: "Transfer", fromAccountId: "a", toAccountId: "b", amountPz: 30, ivaPz: 0, status: "Pending", createdAt: NOW, IBAN_Origin: A.iban };
  const current = { accounts: [A, B, TGLP], transactions: [pending], auditLogs: [] };
  const settled = { ...pending, status: "Settled", concept: "Transferencia web (firmada)" };
  const out = reconcileIncomingState(current, { accounts: [A, B, TGLP], transactions: [settled], auditLogs: [] }, NOW);
  check("saldo origen baja a 70", bal(out, "a") === 70, `a=${bal(out, "a")}`);
  check("saldo destino sube a 30", bal(out, "b") === 30, `b=${bal(out, "b")}`);
  check("la transacción queda Settled y sin duplicar", txCount(out, "tx-pend") === 1 && out.transactions[0].status === "Settled", `count=${txCount(out, "tx-pend")}`);
}

console.log("2) Nueva transferencia Settled se aplica y es idempotente:");
{
  const current = { accounts: [A, B, TGLP], transactions: [], auditLogs: [] };
  const tx = { id: "tx-1", kind: "Transfer", fromAccountId: "a", toAccountId: "b", amountPz: 30, ivaPz: 0, status: "Settled", createdAt: NOW, IBAN_Origin: A.iban };
  const incoming = { accounts: [A, B, TGLP], transactions: [tx], auditLogs: [] };
  const out1 = reconcileIncomingState(current, incoming, NOW);
  check("se aplica: a=70, b=30", bal(out1, "a") === 70 && bal(out1, "b") === 30, `a=${bal(out1, "a")} b=${bal(out1, "b")}`);
  // Reenvío del mismo estado (idempotencia): no debe aplicar dos veces
  const out2 = reconcileIncomingState(out1, incoming, NOW);
  check("reintento NO aplica dos veces (a=70, b=30)", bal(out2, "a") === 70 && bal(out2, "b") === 30, `a=${bal(out2, "a")} b=${bal(out2, "b")}`);
  check("solo una transacción tx-1", txCount(out2, "tx-1") === 1, `count=${txCount(out2, "tx-1")}`);
}

console.log("3) Nueva transacción Pending se CONSERVA (antes se descartaba):");
{
  const current = { accounts: [A, B, TGLP], transactions: [], auditLogs: [] };
  const pend = { id: "tx-pend2", kind: "Transfer", fromAccountId: "a", toAccountId: "b", amountPz: 30, ivaPz: 0, status: "Pending", createdAt: NOW };
  const out = reconcileIncomingState(current, { accounts: [A, B, TGLP], transactions: [pend], auditLogs: [] }, NOW);
  check("Pending persiste sin mover saldos", txCount(out, "tx-pend2") === 1 && out.transactions[0].status === "Pending", `count=${txCount(out, "tx-pend2")}`);
  check("saldos intactos", bal(out, "a") === 100 && bal(out, "b") === 0, `a=${bal(out, "a")} b=${bal(out, "b")}`);
}

console.log("4) Los auditLogs entrantes se conservan:");
{
  const l1 = { id: "l1", action: "emitir", createdAt: NOW };
  const l2 = { id: "l2", action: "transferir", createdAt: NOW };
  const current = { accounts: [A, B, TGLP], transactions: [], auditLogs: [l1] };
  const out = reconcileIncomingState(current, { accounts: [A, B, TGLP], transactions: [], auditLogs: [l1, l2] }, NOW);
  check("l1 y l2 presentes", out.auditLogs.some((x) => x.id === "l1") && out.auditLogs.some((x) => x.id === "l2"), `logs=${out.auditLogs.length}`);
}

console.log("5) Saldo insuficiente en la liquidación → transacción rechazada y auditada:");
{
  const pending = { id: "tx-x", kind: "Transfer", fromAccountId: "a", toAccountId: "b", amountPz: 999, ivaPz: 0, status: "Pending", createdAt: NOW };
  const current = { accounts: [A, B, TGLP], transactions: [pending], auditLogs: [] };
  const settled = { ...pending, status: "Settled" };
  const out = reconcileIncomingState(current, { accounts: [A, B, TGLP], transactions: [settled], auditLogs: [] }, NOW);
  check("no se aplica (a=100)", bal(out, "a") === 100, `a=${bal(out, "a")}`);
  check("queda auditado como rechazo", out.auditLogs.some((x) => x.reason === "source_insufficient_balance"), `reasons=${out.auditLogs.map((x) => x.reason).join(",")}`);
}

console.log(`\nResultado: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
