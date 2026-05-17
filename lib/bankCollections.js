import { mongo } from "./mongo.js";
import { stripEmptyMongoKeys } from "./sanitizeMongo.js";

export const bankCollections = {
  meta: "bank_meta",
  users: "bank_users",
  accounts: "bank_accounts",
  transactions: "bank_transactions",
  subsidyRequests: "bank_subsidy_requests",
  investmentHoldings: "bank_investment_holdings",
  investmentOperations: "bank_investment_operations",
  digitalCards: "bank_digital_cards",
  savedContacts: "bank_saved_contacts",
  promoSlides: "bank_promo_slides",
  complianceFlags: "bank_compliance_flags",
  auditLogs: "bank_audit_logs",
  supportTickets: "bank_support_tickets",
  paymentLinks: "bank_payment_links",
  gdlpSharedNews: "bank_gdlp_shared_news",
  periodicoNews: "bank_periodico_news",
  donationRewards: "bank_donation_rewards",
  treasuryConfig: "bank_treasury_config"
};

const listSpecs = [
  ["users", bankCollections.users, "dip"],
  ["accounts", bankCollections.accounts, "id"],
  ["transactions", bankCollections.transactions, "id"],
  ["subsidyRequests", bankCollections.subsidyRequests, "id"],
  ["investmentHoldings", bankCollections.investmentHoldings, "id"],
  ["investmentOperations", bankCollections.investmentOperations, "id"],
  ["digitalCards", bankCollections.digitalCards, "id"],
  ["savedContacts", bankCollections.savedContacts, "id"],
  ["promoSlides", bankCollections.promoSlides, "id"],
  ["complianceFlags", bankCollections.complianceFlags, "id"],
  ["auditLogs", bankCollections.auditLogs, "id"],
  ["supportTickets", bankCollections.supportTickets, "id"],
  ["paymentLinks", bankCollections.paymentLinks, "id"],
  ["gdlpSharedNews", bankCollections.gdlpSharedNews, "slug"],
  ["periodicoNews", bankCollections.periodicoNews, "slug"],
  ["donationRewards", bankCollections.donationRewards, "id"]
];

const TGLP_ID = "TGLP";
const AGLDP_ID = "AGLDP";
const VAULT_EMISION = "VAULT_EMISION";
const RBU_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const MINIMUM_INCOME_SHIELD_PZ = 5;

export async function readBankState() {
  const db = await mongo();
  const state = {};
  for (const [stateKey, collectionName, idKey] of listSpecs) {
    state[stateKey] = dedupeBy(await db
      .collection(collectionName)
      .find({})
      .project({ _id: 0 })
      .toArray(), idKey);
  }
  const config = await db.collection(bankCollections.treasuryConfig).findOne({ _id: "treasuryConfig" });
  if (config) {
    delete config._id;
    state.treasuryConfig = config;
  }
  const meta = await db.collection(bankCollections.meta).findOne({ _id: "state" });
  state.schemaSeedVersion = meta?.schemaSeedVersion ?? 2;
  state.updatedAt = meta?.updatedAt ?? null;
  return state;
}

export async function writeBankState(state) {
  const db = await mongo();
  const updatedAt = state.updatedAt || new Date().toISOString();
  const lockToken = await acquireStateLock(db);
  try {
    const current = await readBankState();
    const guarded = stripEmptyMongoKeys(reconcileIncomingState(current, state, updatedAt));

    for (const [stateKey, collectionName, idKey] of listSpecs) {
      const docs = Array.isArray(guarded[stateKey]) ? guarded[stateKey] : [];
      const collection = db.collection(collectionName);
      if (docs.length > 0) {
        const operations = docs
          .filter((doc) => doc && doc[idKey])
          .map((doc) => ({
            replaceOne: {
              filter: { _id: doc[idKey] },
              replacement: { _id: doc[idKey], ...doc },
              upsert: true
            }
          }));
        if (operations.length > 0) await collection.bulkWrite(operations, { ordered: false });
      }
    }

    if (guarded.treasuryConfig && typeof guarded.treasuryConfig === "object") {
      await db.collection(bankCollections.treasuryConfig).replaceOne(
        { _id: "treasuryConfig" },
        { _id: "treasuryConfig", ...guarded.treasuryConfig },
        { upsert: true }
      );
    }

    await db.collection(bankCollections.meta).replaceOne(
      { _id: "state" },
      {
        _id: "state",
        schemaSeedVersion: guarded.schemaSeedVersion ?? 2,
        updatedAt
      },
      { upsert: true }
    );

    return { ok: true, updatedAt };
  } finally {
    await releaseStateLock(db, lockToken);
  }
}

async function acquireStateLock(db) {
  const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const expiresAt = new Date(Date.now() + 10_000);
  await db.collection(bankCollections.meta).updateOne(
    { _id: "state-lock" },
    { $setOnInsert: { lockUntil: new Date(0) } },
    { upsert: true }
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await db.collection(bankCollections.meta).findOneAndUpdate(
      {
        _id: "state-lock",
        $or: [
          { lockUntil: { $exists: false } },
          { lockUntil: { $lt: new Date() } }
        ]
      },
      { $set: { lockToken: token, lockUntil: expiresAt } },
      { returnDocument: "after" }
    );
    if (result?.lockToken === token || result?.value?.lockToken === token) return token;
    await sleep(120);
  }
  const error = new Error("state_write_locked");
  error.statusCode = 409;
  throw error;
}

async function releaseStateLock(db, token) {
  await db.collection(bankCollections.meta).updateOne(
    { _id: "state-lock", lockToken: token },
    { $unset: { lockToken: "", lockUntil: "" } }
  );
}

function reconcileIncomingState(current, incoming, updatedAt) {
  if (!current.accounts?.length) return { ...incoming, updatedAt };

  const currentAccounts = byId(current.accounts || [], "id");
  const currentTransactions = byId(current.transactions || [], "id");
  const currentOperations = byId(current.investmentOperations || [], "id");
  const nextTransactions = [...(current.transactions || [])];
  const nextAccounts = new Map(currentAccounts);
  const auditLogs = [...(current.auditLogs || [])];
  const treasuryConfig = incoming.treasuryConfig || current.treasuryConfig || {};

  for (const account of incoming.accounts || []) {
    const currentAccount = nextAccounts.get(account.id);
    if (!currentAccount) {
      nextAccounts.set(account.id, account);
    } else {
      nextAccounts.set(account.id, {
        ...currentAccount,
        ...account,
        balancePz: currentAccount.balancePz,
        lastRbuClaim: currentAccount.lastRbuClaim
      });
    }
  }

  const newTransactions = (incoming.transactions || [])
    .filter((transaction) => transaction?.id && !currentTransactions.has(transaction.id))
    .sort((left, right) => Date.parse(left.createdAt || updatedAt) - Date.parse(right.createdAt || updatedAt));

  for (const transaction of newTransactions) {
    const result = applyServerTransaction(nextAccounts, currentTransactions, currentOperations, transaction, treasuryConfig);
    if (!result.ok) {
      auditLogs.push(auditLog("rejected_transaction", transaction.id, result.reason));
      continue;
    }
    currentTransactions.set(transaction.id, transaction);
    nextTransactions.push(transaction);
    if (result.operationId) {
      const operation = currentOperations.get(result.operationId);
      if (operation) {
        currentOperations.set(result.operationId, { ...operation, settledAt: transaction.createdAt || updatedAt });
      }
    }
  }

  const incomingOperations = byId(incoming.investmentOperations || [], "id");
  const nextOperations = mergeById(current.investmentOperations || [], incoming.investmentOperations || [])
    .map((operation) => {
      const guarded = currentOperations.get(operation.id);
      const incomingOperation = incomingOperations.get(operation.id);
      if (guarded?.settledAt) return { ...operation, ...incomingOperation, settledAt: guarded.settledAt };
      return incomingOperation || guarded || operation;
    })
    .filter((operation, index, all) => all.findIndex((item) => item.id === operation.id) === index);

  return {
    ...incoming,
    accounts: [...nextAccounts.values()],
    transactions: nextTransactions.sort((a, b) => Date.parse(b.createdAt || updatedAt) - Date.parse(a.createdAt || updatedAt)),
    investmentOperations: nextOperations.sort((a, b) => Date.parse(b.createdAt || updatedAt) - Date.parse(a.createdAt || updatedAt)),
    digitalCards: mergeById(current.digitalCards || [], incoming.digitalCards || []),
    savedContacts: dedupeByComposite(mergeById(current.savedContacts || [], incoming.savedContacts || []), (contact) => `${contact.ownerPlacetaId}:${contact.accountId}`),
    promoSlides: mergeById(current.promoSlides || [], incoming.promoSlides || []),
    complianceFlags: mergeById(current.complianceFlags || [], incoming.complianceFlags || []),
    supportTickets: mergeById(current.supportTickets || [], incoming.supportTickets || []),
    paymentLinks: mergeById(current.paymentLinks || [], incoming.paymentLinks || []),
    gdlpSharedNews: mergeById(current.gdlpSharedNews || [], incoming.gdlpSharedNews || [], "slug"),
    periodicoNews: mergeById(current.periodicoNews || [], incoming.periodicoNews || [], "slug"),
    donationRewards: mergeById(current.donationRewards || [], incoming.donationRewards || []),
    auditLogs,
    treasuryConfig,
    updatedAt
  };
}

function applyServerTransaction(accounts, currentTransactions, currentOperations, transaction, config = {}) {
  const from = accounts.get(transaction.fromAccountId);
  const to = accounts.get(transaction.toAccountId);
  if (!from) return denied(`source_not_found:${transaction.fromAccountId}`);
  if (transaction.IBAN_Origin && normalize(transaction.IBAN_Origin) !== normalize(from.iban)) return denied("invalid_source_iban");
  if (transaction.status && transaction.status !== "Settled") return { ok: true };

  const amount = safeAmount(transaction.amountPz);
  const tax = safeAmount(transaction.ivaPz ?? transaction.taxAmount);
  if (amount <= 0) return denied("invalid_amount");

  if (transaction.kind === "Rbu") {
    const lastRbu = [...currentTransactions.values()].find((item) =>
      item.kind === "Rbu" &&
      item.toAccountId === transaction.toAccountId &&
      Date.parse(transaction.createdAt || new Date().toISOString()) - Date.parse(item.createdAt || "1970-01-01") < RBU_COOLDOWN_MS
    );
    if (lastRbu) return denied("rbu_cooldown_active");
  }

  if (transaction.concept === "DEVELOPER_PAYMENT") {
    if (!transaction.originalTransactionId) return denied("developer_payment_id_required");
    const duplicatePayment = [...currentTransactions.values()].some((item) =>
      item.concept === "DEVELOPER_PAYMENT" &&
      item.originalTransactionId === transaction.originalTransactionId
    );
    if (duplicatePayment) return denied("developer_payment_already_captured");
    const expectedVat = Math.ceil(amount * 0.12);
    if (tax !== expectedVat) return denied("developer_payment_invalid_iva");
  }

  if (["PAYMENT_LINK", "PLACETA_SEND_LINK"].includes(transaction.concept)) {
    if (!transaction.originalTransactionId) return denied("payment_link_id_required");
    const duplicateLink = [...currentTransactions.values()].some((item) => item.originalTransactionId === transaction.originalTransactionId);
    if (duplicateLink) return denied("payment_link_already_used");
    const expectedVat = Math.ceil(amount * 0.12);
    if (transaction.concept === "PAYMENT_LINK" && tax > 0 && tax !== expectedVat) return denied("payment_link_invalid_iva");
  }

  if (transaction.kind === "InvestmentBuy") {
    if (!to) return denied(`target_not_found:${transaction.toAccountId}`);
    const limits = investmentRiskLimits(config, to.investmentRiskLevel || 3);
    if (amount > limits.maxAmountPz) return denied(`investment_amount_over_risk_limit:R${limits.riskLevel}`);
    const day = String(transaction.createdAt || new Date().toISOString()).slice(0, 10);
    const dailyCount = [...currentTransactions.values()].filter((item) =>
      item.kind === "InvestmentBuy" &&
      item.fromAccountId === transaction.fromAccountId &&
      item.toAccountId === transaction.toAccountId &&
      String(item.createdAt || "").slice(0, 10) === day
    ).length;
    if (dailyCount >= limits.dailyLimit) return denied(`investment_daily_company_limit:R${limits.riskLevel}`);
  }

  if (transaction.kind === "InvestmentSell") {
    const operation = findOpenInvestmentOperation(currentOperations, transaction);
    if (!operation) return denied("investment_operation_not_open");
    const duplicateSettlement = [...currentTransactions.values()].some((item) =>
      item.kind === "InvestmentSell" &&
      (
        (transaction.originalTransactionId && item.originalTransactionId === transaction.originalTransactionId) ||
        item.note === transaction.note
      )
    );
    if (duplicateSettlement) return denied("investment_already_settled");
    if (!to) return denied(`target_not_found:${transaction.toAccountId}`);
    if (from.balancePz < amount) return denied("source_insufficient_liquidity");
    from.balancePz -= amount;
    to.balancePz += amount;
    return { ok: true, operationId: operation.id };
  }

  if (!to && ![TGLP_ID, AGLDP_ID].includes(transaction.toAccountId)) return denied(`target_not_found:${transaction.toAccountId}`);

  if (transaction.kind === "PayrollLoan") {
    if (!to) return denied(`target_not_found:${transaction.toAccountId}`);
    if (from.type !== "Business" || to.type !== "Current") return denied("invalid_payroll_route");
    const net = safeAmount(transaction.netAmount || amount);
    const totalDebit = amount + tax;
    if (from.balancePz < totalDebit) return denied("source_insufficient_balance");
    if (from.balancePz - totalDebit < MINIMUM_INCOME_SHIELD_PZ) return denied("minimum_income_shield");
    from.balancePz -= totalDebit;
    to.balancePz += net;
    const tglp = accounts.get(TGLP_ID);
    if (tax > 0 && tglp) tglp.balancePz += tax;
    return { ok: true };
  }

  const totalDebit = debitFor(transaction.kind, amount, tax);
  const bypassShield = ["Tax", "Fine", "ForcedVatRegularization", "MonetaryEmission", "Rbu"].includes(transaction.kind);
  if (![VAULT_EMISION].includes(from.id)) {
    if (from.balancePz < totalDebit) return denied("source_insufficient_balance");
    if (!bypassShield && from.balancePz - totalDebit < MINIMUM_INCOME_SHIELD_PZ) return denied("minimum_income_shield");
    from.balancePz -= totalDebit;
  }

  if (to) to.balancePz += amount;
  const tglp = accounts.get(TGLP_ID);
  if (tax > 0 && ["Consumption", "Placezum", "InvestmentBuy"].includes(transaction.kind) && tglp) tglp.balancePz += tax;
  if (transaction.kind === "Rbu" && to) to.lastRbuClaim = (transaction.createdAt || new Date().toISOString()).slice(0, 10);
  return { ok: true };
}

function debitFor(kind, amount, tax) {
  if (["Consumption", "Placezum", "InvestmentBuy"].includes(kind)) return amount + tax;
  return amount + (kind === "OperationalFee" ? 0 : 0);
}

function investmentRiskLimits(config, riskLevel) {
  const safeRisk = Math.min(7, Math.max(1, Math.round(Number(riskLevel) || 3)));
  const allowedPercent = Math.min(100, Math.max(40, 100 - (safeRisk - 1) * 10));
  const maxInvestmentAmountPz = safeAmount(config.maxInvestmentAmountPz || 1200) || 1200;
  const dailyInvestmentLimit = Math.max(1, Math.floor(Number(config.dailyInvestmentLimit || 15)));
  return {
    riskLevel: safeRisk,
    allowedPercent,
    maxAmountPz: Math.max(1, Math.floor((maxInvestmentAmountPz * allowedPercent) / 100)),
    dailyLimit: Math.max(1, Math.floor((dailyInvestmentLimit * allowedPercent) / 100))
  };
}

function findOpenInvestmentOperation(operations, transaction) {
  const linkedBuyId = transaction.originalTransactionId || "";
  if (linkedBuyId) {
    const linked = operations.get(`op-${linkedBuyId}`);
    if (linked && !linked.settledAt) return linked;
  }
  const operationId = settlementOperationId(transaction);
  if (!operationId) return null;
  return [...operations.values()].find((operation) =>
    !operation.settledAt &&
    operation.accountId === transaction.toAccountId &&
    operation.companyId === transaction.fromAccountId &&
    operation.id === operationId
  );
}

function settlementOperationId(transaction) {
  if (transaction.originalTransactionId) return `op-${transaction.originalTransactionId}`;
  const match = String(transaction.note || "").match(/\[(op-[^\]\s]+)\]/);
  return match?.[1] || null;
}

function byId(items, key) {
  return new Map((items || []).filter((item) => item?.[key]).map((item) => [item[key], { ...item }]));
}

function mergeById(current, incoming, key = "id") {
  const merged = byId(current, key);
  for (const item of incoming || []) {
    if (item?.[key]) merged.set(item[key], item);
  }
  return [...merged.values()];
}

function dedupeBy(items, key) {
  const seen = new Map();
  for (const item of items || []) {
    if (!item?.[key]) continue;
    seen.set(item[key], item);
  }
  return [...seen.values()];
}

function dedupeByComposite(items, keyFn) {
  const seen = new Map();
  for (const item of items || []) {
    seen.set(keyFn(item), item);
  }
  return [...seen.values()];
}

function safeAmount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function normalize(value) {
  return String(value || "").trim().toUpperCase();
}

function denied(reason) {
  return { ok: false, reason };
}

function auditLog(action, targetId, reason) {
  return {
    id: `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    action,
    targetId,
    reason,
    createdAt: new Date().toISOString()
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readEntityCollection(name) {
  const collectionName = bankCollections[name];
  if (!collectionName || name === "meta" || name === "treasuryConfig") return null;
  return (await mongo()).collection(collectionName).find({}).project({ _id: 0 }).toArray();
}

export async function upsertEntity(name, id, payload) {
  const spec = listSpecs.find(([stateKey]) => stateKey === name);
  if (!spec) return null;
  const [, collectionName, idKey] = spec;
  const doc = stripEmptyMongoKeys({ ...payload, [idKey]: id });
  await (await mongo()).collection(collectionName).replaceOne(
    { _id: id },
    { _id: id, ...doc },
    { upsert: true }
  );
  await touchMeta();
  return doc;
}

export async function deleteEntity(name, id) {
  const spec = listSpecs.find(([stateKey]) => stateKey === name);
  if (!spec) return false;
  const [, collectionName] = spec;
  await (await mongo()).collection(collectionName).deleteOne({ _id: id });
  await touchMeta();
  return true;
}

export async function writeTreasuryConfig(payload) {
  const config = stripEmptyMongoKeys(payload);
  await (await mongo()).collection(bankCollections.treasuryConfig).replaceOne(
    { _id: "treasuryConfig" },
    { _id: "treasuryConfig", ...config },
    { upsert: true }
  );
  await touchMeta();
  return config;
}

export async function readTreasuryConfig() {
  const config = await (await mongo())
    .collection(bankCollections.treasuryConfig)
    .findOne({ _id: "treasuryConfig" });
  if (!config) return {};
  delete config._id;
  return config;
}

async function touchMeta() {
  await (await mongo()).collection(bankCollections.meta).updateOne(
    { _id: "state" },
    { $set: { schemaSeedVersion: 2, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
}
