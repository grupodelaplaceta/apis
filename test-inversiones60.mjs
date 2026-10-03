import assert from "node:assert/strict";
import {
  calculateInvestmentResult,
  investmentLimits,
  assertInvestmentAmount,
  INVESTMENT_DURATION_MS
} from "./lib/inversiones60.js";

const entity = { id: "ENT-042", eip: "EIP-042", complianceStatus: "Clear" };
const input = { id: "INV-2026-000184", entity, riskLevel: 3, createdAt: "2026-09-16T21:48:00.000Z" };
const first = calculateInvestmentResult(input);
const second = calculateInvestmentResult(input);

assert.equal(INVESTMENT_DURATION_MS, 60_000);
assert.deepEqual(second, first, "el resultado debe ser inmutable para la misma semilla");
assert.ok(first.resultRatePct >= -7 && first.resultRatePct <= 20);
assert.ok(Math.abs(first.randomComponentPct) <= 4);

const operations = [
  { id: "op-1", status: "ACTIVE", entityId: entity.id, amountPz: 2_000 },
  { id: "op-2", status: "ACTIVE", entityId: "ENT-999", amountPz: 3_000 },
  { id: "op-3", status: "SETTLED", entityId: entity.id, amountPz: 4_000 }
];
const limits = investmentLimits({ balancePz: 20_000, operations, entityId: entity.id });
assert.equal(limits.maxAmountPz, 5_000);
assert.equal(limits.entityRemainingPz, 3_000);
assert.equal(limits.globalRemainingPz, 5_000);
assert.throws(
  () => assertInvestmentAmount({ amountPz: 3_001, balancePz: 20_000, operations, entityId: entity.id }),
  /investment_limit_entity:3000/
);
assert.equal(
  assertInvestmentAmount({ amountPz: 3_000, balancePz: 20_000, operations, entityId: entity.id }).amount,
  3_000
);

console.log("Inversiones 60s: 7 comprobaciones OK");
