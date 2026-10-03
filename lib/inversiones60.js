import crypto from "crypto";

export const INVESTMENT_DURATION_MS = 60_000;
export const GLOBAL_MAX_RETURN_RATE = 0.20;
export const DEFAULT_INVESTMENT_LIMITS = {
  maxPercentOfAvailable: 0.25,
  maxPerEntityPz: 5_000,
  maxGlobalActivePz: 10_000
};

const RISK_PROFILES = {
  1: { label: "Muy bajo", randomMaxPct: 1, lossMaxPct: 2 },
  2: { label: "Bajo", randomMaxPct: 2, lossMaxPct: 4 },
  3: { label: "Moderado", randomMaxPct: 4, lossMaxPct: 7 },
  4: { label: "Alto", randomMaxPct: 7, lossMaxPct: 12 },
  5: { label: "Muy alto", randomMaxPct: 12, lossMaxPct: 20 }
};

export function riskProfile(level) {
  return RISK_PROFILES[Math.min(5, Math.max(1, Math.round(Number(level) || 3)))] || RISK_PROFILES[3];
}

export function normalizeRisk(level) {
  return Math.min(5, Math.max(1, Math.round(Number(level) || 3)));
}

export function calculateInvestmentResult({ id, entity, riskLevel, createdAt }) {
  const risk = normalizeRisk(riskLevel);
  const profile = riskProfile(risk);
  const seed = `${id}|${entity.id}|${entity.eip || ""}|${createdAt}|${risk}`;
  const digest = crypto.createHash("sha256").update(seed).digest("hex");
  const seedNumber = Number.parseInt(digest.slice(0, 8), 16);
  const randomUnit = seedNumber / 0xffffffff;
  const randomComponent = Number(((randomUnit * 2 - 1) * profile.randomMaxPct).toFixed(4));
  const compliance = String(entity.complianceStatus || "Clear").toLowerCase();
  const entityComponent = Number((compliance === "clear" ? 2.4 : compliance === "review" ? 0 : -1.5).toFixed(4));
  const marketComponent = 0.8;
  const rawRate = entityComponent + marketComponent + randomComponent;
  const ratePct = Number(Math.max(-profile.lossMaxPct, Math.min(20, rawRate)).toFixed(4));
  return {
    seedHash: digest,
    entityComponentPct: entityComponent,
    marketComponentPct: marketComponent,
    randomComponentPct: randomComponent,
    resultRatePct: ratePct,
    riskLevel: risk,
    riskLabel: profile.label,
    randomMaxPct: profile.randomMaxPct,
    lossMaxPct: profile.lossMaxPct
  };
}

export function activeInvestments(operations = []) {
  return operations.filter((operation) => operation && ["ACTIVE", "Active", "Pending"].includes(operation.status) && !operation.settledAt);
}

export function investmentLimits({ balancePz, operations, entityId }) {
  const active = activeInvestments(operations);
  const globalActivePz = active.reduce((sum, item) => sum + Number(item.amountPz || 0), 0);
  const entityActivePz = active.filter((item) => item.entityId === entityId || item.companyId === entityId).reduce((sum, item) => sum + Number(item.amountPz || 0), 0);
  return {
    maxAmountPz: Math.floor(Math.max(0, Number(balancePz || 0)) * DEFAULT_INVESTMENT_LIMITS.maxPercentOfAvailable),
    entityRemainingPz: Math.max(0, DEFAULT_INVESTMENT_LIMITS.maxPerEntityPz - entityActivePz),
    globalRemainingPz: Math.max(0, DEFAULT_INVESTMENT_LIMITS.maxGlobalActivePz - globalActivePz)
  };
}

export function assertInvestmentAmount({ amountPz, balancePz, operations, entityId }) {
  const amount = Math.round(Number(amountPz));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("investment_amount_invalid");
  const limits = investmentLimits({ balancePz, operations, entityId });
  if (amount > limits.maxAmountPz) throw new Error(`investment_limit_balance:${limits.maxAmountPz}`);
  if (amount > limits.entityRemainingPz) throw new Error(`investment_limit_entity:${limits.entityRemainingPz}`);
  if (amount > limits.globalRemainingPz) throw new Error(`investment_limit_global:${limits.globalRemainingPz}`);
  return { amount, limits };
}
