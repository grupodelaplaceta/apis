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
  check("no queda Pending engañoso", out.transactions.find((t) => t.id === "tx-x")?.status === "Cancelled", JSON.stringify(out.transactions.find((t) => t.id === "tx-x")));
  check("la cancelación conserva el motivo", out.transactions.find((t) => t.id === "tx-x")?.cancellationReason === "source_insufficient_balance", JSON.stringify(out.transactions.find((t) => t.id === "tx-x")));
}

console.log("6) Pending sin fondos se cancela, también para inversiones:");
{
  const investment = {
    id: "tx-investment-no-funds",
    kind: "InvestmentBuy",
    fromAccountId: "b",
    toAccountId: "b",
    amountPz: 50,
    ivaPz: 0,
    status: "Pending",
    createdAt: NOW
  };
  const out = reconcileIncomingState(
    { accounts: [A, B, TGLP], transactions: [], auditLogs: [] },
    { accounts: [A, B, TGLP], transactions: [investment], auditLogs: [] },
    NOW
  );
  const saved = out.transactions.find((t) => t.id === investment.id);
  check("se registra como Cancelled", saved?.status === "Cancelled", JSON.stringify(saved));
  check("motivo explícito de falta de fondos", saved?.cancellationReason === "source_insufficient_balance", JSON.stringify(saved));
  check("no altera saldos", bal(out, "b") === 0, `b=${bal(out, "b")}`);
}

console.log("7) Impuesto dependiente de transferencia fantasma se revierte:");
{
  const principal = { id: "tx-phantom", kind: "Transfer", fromAccountId: "a", toAccountId: "b", amountPz: 999, ivaPz: 0, status: "Settled", createdAt: NOW, IBAN_Origin: A.iban };
  const iva = { id: "tx-phantom-iva", kind: "Tax", fromAccountId: "a", toAccountId: "TGLP", amountPz: 50, ivaPz: 0, taxAmount: 0, status: "Settled", originalTransactionId: "tx-phantom", createdAt: NOW };
  const out = reconcileIncomingState(
    { accounts: [A, B, TGLP], transactions: [], auditLogs: [] },
    { accounts: [A, B, TGLP], transactions: [iva, principal], auditLogs: [] },
    NOW
  );
  const main = out.transactions.find((t) => t.id === principal.id);
  const side = out.transactions.find((t) => t.id === iva.id);
  check("transferencia fantasma cancelada", main?.status === "Cancelled", JSON.stringify(main));
  check("impuesto huérfano cancelado", side?.status === "Cancelled", JSON.stringify(side));
  check("no se cobra impuesto ni se mueven saldos", bal(out, "a") === 100 && bal(out, "TGLP") === 0, `a=${bal(out, "a")} tglp=${bal(out, "TGLP")}`);
  check("queda auditoría de rechazo/reversión", out.auditLogs.some((x) => x.action === "reverted_orphaned_transaction" || x.action === "rejected_transaction"), JSON.stringify(out.auditLogs));
}

console.log("8) Un impuesto ya guardado sobre una transferencia cancelada se revierte:");
{
  const cancelled = { id: "tx-cancelled", kind: "Transfer", fromAccountId: "a", toAccountId: "b", amountPz: 999, status: "Cancelled", cancellationReason: "source_insufficient_balance", createdAt: NOW };
  const iva = { id: "tx-cancelled-iva", kind: "Tax", fromAccountId: "a", toAccountId: "TGLP", amountPz: 50, status: "Settled", originalTransactionId: "tx-cancelled", createdAt: NOW };
  const out = reconcileIncomingState(
    { accounts: [{ ...A, balancePz: 50 }, B, { ...TGLP, balancePz: 50 }], transactions: [cancelled, iva], auditLogs: [] },
    { accounts: [{ ...A, balancePz: 50 }, B, { ...TGLP, balancePz: 50 }], transactions: [cancelled, iva], auditLogs: [] },
    NOW
  );
  check("impuesto guardado queda cancelado", out.transactions.find((t) => t.id === iva.id)?.status === "Cancelled", JSON.stringify(out.transactions));
  check("se devuelve el importe al origen", bal(out, "a") === 100 && bal(out, "TGLP") === 0, `a=${bal(out, "a")} tglp=${bal(out, "TGLP")}`);
  check("se registra la reversión", out.auditLogs.some((x) => x.action === "reverted_orphaned_transaction"), JSON.stringify(out.auditLogs));
}

console.log(`\nResultado: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
