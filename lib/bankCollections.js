import { mongo } from "./mongo.js";
import { stripEmptyMongoKeys } from "./sanitizeMongo.js";
import { ivaPorcentajeSync, overlayTreasuryConfigNormativa } from "./valores-bop.js";

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
  payrollContracts: "bank_payroll_contracts",
  payrollPeriods: "bank_payroll_periods",
  promoSlides: "bank_promo_slides",
  complianceFlags: "bank_compliance_flags",
  auditLogs: "bank_audit_logs",
  supportTickets: "bank_support_tickets",
  paymentLinks: "bank_payment_links",
  gdlpSharedNews: "bank_gdlp_shared_news",
  periodicoNews: "bank_periodico_news",
  donationRewards: "bank_donation_rewards",
  treasuryConfig: "bank_treasury_config",
  userModulePreferences: "bank_user_module_preferences",
  productContractTemplates: "bank_product_contract_templates",
  signedProductContracts: "bank_signed_product_contracts",
  accountHolders: "bank_account_holders",
  guardianRenewalDecisions: "bank_guardian_renewal_decisions",
  executionCodes: "bank_execution_codes"
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
  ["payrollContracts", bankCollections.payrollContracts, "id"],
  ["payrollPeriods", bankCollections.payrollPeriods, "id"],
  ["promoSlides", bankCollections.promoSlides, "id"],
  ["complianceFlags", bankCollections.complianceFlags, "id"],
  ["auditLogs", bankCollections.auditLogs, "id"],
  ["supportTickets", bankCollections.supportTickets, "id"],
  ["paymentLinks", bankCollections.paymentLinks, "id"],
  ["gdlpSharedNews", bankCollections.gdlpSharedNews, "slug"],
  ["periodicoNews", bankCollections.periodicoNews, "slug"],
  ["donationRewards", bankCollections.donationRewards, "id"],
  ["userModulePreferences", bankCollections.userModulePreferences, "placetaId"],
  ["productContractTemplates", bankCollections.productContractTemplates, "id"],
  ["signedProductContracts", bankCollections.signedProductContracts, "id"],
  ["accountHolders", bankCollections.accountHolders, "id"],
  ["guardianRenewalDecisions", bankCollections.guardianRenewalDecisions, "id"],
  ["executionCodes", bankCollections.executionCodes, "id"]
];

const TGLP_ID = "TGLP";
const TGLP_LEGACY_ID = "sys-lottery";
const TGLP_OFFICIAL_IBAN = "GDLP-AP98-605";
const AGLDP_ID = "AGLDP";
const FOUNDATION_RBU_ID = "FOUNDATION_RBU";
const CAPITALIA_BANK_ID = "CAPITALIA_BANK";
const VAULT_EMISION = "VAULT_EMISION";
const FONDO_APOYO_ID = "FUND-BLP";
const FONDO_APOYO_IBAN = "GDLP-AP71-601";
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
  // Configuración del Banco con los valores NORMATIVOS (CNIC) vigentes del
  // BOLP superpuestos en vivo (IVA, RBU, SMI, límites…) para que apps/web
  // nunca usen valores desactualizados o hardcodeados.
  state.treasuryConfig = await leerTreasuryConfigConNormativa(db);
  const meta = await db.collection(bankCollections.meta).findOne({ _id: "state" });
  state.schemaSeedVersion = meta?.schemaSeedVersion ?? 2;
  state.updatedAt = meta?.updatedAt ?? null;
  return normalizeTreasuryIdentity(state);
}

export async function writeBankState(state, options = {}) {
  const db = await mongo();
  const updatedAt = state.updatedAt || new Date().toISOString();
  const lockToken = await acquireStateLock(db);
  try {
    const current = await readBankState();
    const guarded = stripEmptyMongoKeys(normalizeTreasuryIdentity(reconcileIncomingState(current, state, updatedAt)));

    for (const [stateKey, collectionName, idKey] of listSpecs) {
      const docs = Array.isArray(guarded[stateKey]) ? guarded[stateKey] : [];
      const collection = db.collection(collectionName);
      if (docs.length > 0) {
        const operations = docs
          .filter((doc) => doc && doc[idKey])
          .map((doc) => ({
            replaceOne: {
              filter: { _id: doc[idKey] },
              replacement: stripEmptyMongoKeys({ _id: doc[idKey], ...doc }),
              upsert: true
            }
          }));
        if (operations.length > 0) await collection.bulkWrite(operations, { ordered: false });
      }
    }

    if (guarded.treasuryConfig && typeof guarded.treasuryConfig === "object") {
      await db.collection(bankCollections.treasuryConfig).replaceOne(
        { _id: "treasuryConfig" },
        stripEmptyMongoKeys({ _id: "treasuryConfig", ...guarded.treasuryConfig }),
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

    const result = { ok: true, updatedAt };
    // Incluir el estado ya reconciliado (con saldos aplicados) evita que el
    // llamante haga una segunda lectura completa del estado (2x más rápido).
    if (options.includeState) result.state = guarded;
    return result;
  } finally {
    await releaseStateLock(db, lockToken);
  }
}

function normalizeTreasuryIdentity(state) {
  const accounts = Array.isArray(state.accounts) ? state.accounts.map((account) => {
    // Reparación permanente de cuentas Junior antiguas: CAPI-* no es un IBAN
    // del Banco de La Placeta y rompe pagos/conciliación.
    if (account.type === "Child" && !String(account.iban || "").toUpperCase().startsWith("GDLP-")) {
      const seed = String(account.titularDip || account.dip || account.placetaId || account.id || "0000").toUpperCase().replace(/[^A-Z0-9]/g, "");
      let body = 17;
      for (const ch of seed) body = (body * 31 + ch.charCodeAt(0)) % 1000;
      const control = ((body * 97) + 13) % 100;
      account = { ...account, iban: `GDLP-AP${String(control).padStart(2, "0")}-${String(body).padStart(3, "0")}` };
    }
    if (isTglpAccount(account)) return {
      ...account,
      id: TGLP_ID,
      kind: "TGLP",
      role: "Tributos",
      type: account.type || "State",
      iban: TGLP_OFFICIAL_IBAN,
      displayName: account.displayName || "TGLP Tributos"
    };
    if (isFoundationRbuAccount(account)) return {
      ...account,
      id: FOUNDATION_RBU_ID,
      kind: "AGLDP",
      role: "Administracion",
      type: account.type || "State",
      displayName: "Fundación Banco de La Placeta"
    };
    if (isAgldpAccount(account)) return {
      ...account,
      id: AGLDP_ID,
      kind: "AGLDP",
      role: "Administracion",
      type: account.type || "State",
      displayName: account.displayName || "AGLDP Administración"
    };
    if (isCapitaliaBankAccount(account)) return {
      ...account,
      id: CAPITALIA_BANK_ID,
      type: "Business",
      placetaId: account.placetaId || "CAPITALIA-BANK",
      citizenshipTier: account.citizenshipTier || "Institucion",
      displayName: account.displayName || "Capitália Empresa"
    };
    if (isFondoApoyoAccount(account)) return {
      ...account,
      id: FONDO_APOYO_ID,
      kind: "FONDO_APOYO",
      role: "Tributos",
      type: account.type || "State",
      iban: FONDO_APOYO_IBAN,
      displayName: "Fondo de Apoyo a la Participación Económica y Social (Fundación)"
    };
    return account;
  }) : [];
  return {
    ...state,
    accounts: dedupeBy(accounts, "id"),
    transactions: Array.isArray(state.transactions) ? state.transactions.map((transaction) => ({
      ...transaction,
      fromAccountId: canonicalSystemAccountId(transaction.fromAccountId),
      toAccountId: canonicalSystemAccountId(transaction.toAccountId),
      IBAN_Origin: canonicalSystemAccountId(transaction.fromAccountId) === TGLP_ID ? TGLP_OFFICIAL_IBAN : transaction.IBAN_Origin
    })) : state.transactions
  };
}

function isTglpAccount(account = {}) {
  return account.id === TGLP_ID ||
    account.id === TGLP_LEGACY_ID ||
    account.kind === "TGLP" ||
    account.role === "Tributos" ||
    String(account.iban || "").toUpperCase() === TGLP_OFFICIAL_IBAN;
}

function isFoundationRbuAccount(account = {}) {
  const id = normalize(account.id);
  const name = normalize(account.displayName);
  return id === FOUNDATION_RBU_ID ||
    id === "FUNDACION_BANCO_PLACETA" ||
    id === "FUNDACION_BANCO_DE_LA_PLACETA" ||
    name.includes("FUNDACION BANCO DE LA PLACETA") ||
    name.includes("FUNDACIÓN BANCO DE LA PLACETA") ||
    name.includes("RBU");
}

function isAgldpAccount(account = {}) {
  const name = normalize(account.displayName);
  return account.id === AGLDP_ID ||
    (account.kind === "AGLDP" && !isFoundationRbuAccount(account)) ||
    (account.role === "Administracion" && name.includes("AGLDP"));
}

function isCapitaliaBankAccount(account = {}) {
  const id = normalize(account.id);
  return id === CAPITALIA_BANK_ID ||
    normalize(account.placetaId) === "CAPITALIA-BANK" ||
    normalize(account.iban) === "GDLP-AP76-179";
}

function isFondoApoyoAccount(account = {}) {
  const id = normalize(account.id);
  const name = normalize(account.displayName);
  return id === FONDO_APOYO_ID ||
    id === "FONDO_APOYO" ||
    id === "FUND_BLP" ||
    name.includes("FONDO DE APOYO");
}

function canonicalTglpId(id) {
  return id === TGLP_LEGACY_ID ? TGLP_ID : id;
}

function canonicalSystemAccountId(id) {
  const normalized = normalize(id);
  if (id === TGLP_LEGACY_ID || normalized === TGLP_ID) return TGLP_ID;
  if (normalized === "FUNDACION_BANCO_PLACETA" || normalized === "FUNDACION_BANCO_DE_LA_PLACETA") return FOUNDATION_RBU_ID;
  if (normalized === FOUNDATION_RBU_ID) return FOUNDATION_RBU_ID;
  if (normalized === AGLDP_ID) return AGLDP_ID;
  if (normalized === CAPITALIA_BANK_ID) return CAPITALIA_BANK_ID;
  if (normalized === FONDO_APOYO_ID || normalized === "FONDO_APOYO" || normalized === "FUND_BLP") return FONDO_APOYO_ID;
  return id;
}

async function acquireStateLock(db) {
  const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // Ventana de lock: 8s. Si una escritura se cae (timeout de Vercel, crash),
  // el lock se libera solo a los 8s; reducirlo demasiado permitiría que una
  // escritura lenta en curso se vea interrumpida por otra.
  const expiresAt = new Date(Date.now() + 8_000);
  await db.collection(bankCollections.meta).updateOne(
    { _id: "state-lock" },
    { $setOnInsert: { lockUntil: new Date(0) } },
    { upsert: true }
  );
  // Espera máxima ~1s (antes 2.4s) → menos retraso percibido en escrituras concurrentes.
  for (let attempt = 0; attempt < 10; attempt += 1) {
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
    await sleep(100);
  }
  const error = new Error("state_write_locked: otra escritura está en curso, reintenta en unos segundos");
  error.statusCode = 409;
  throw error;
}

async function releaseStateLock(db, token) {
  await db.collection(bankCollections.meta).updateOne(
    { _id: "state-lock", lockToken: token },
    { $unset: { lockToken: "", lockUntil: "" } }
  );
}

/**
 * ¿Una transacción necesita ser procesada por el servidor?
 * - Nunca vista → sí (nueva).
 * - Vista como Pending/no-Settled y ahora llega Settled → sí (liquidación):
 *   aquí es donde el dinero se mueve. Antes esta transición se perdía porque
 *   el id ya existía en la BD y el filtro la descartaba → transferencias que
 *   nunca se abonaban.
 * - Ya Settled → no (ya aplicada; evita dobles abonos).
 */
function transactionNeedsProcessing(currentTransactions, transaction) {
  const known = currentTransactions.get(transaction.id);
  if (!known) return true;
  if (known.status !== "Settled" && transaction.status === "Settled") return true;
  return false;
}

export function reconcileIncomingState(current, incoming, updatedAt) {
  if (!current.accounts?.length) return { ...incoming, updatedAt };

  const currentAccounts = byId(current.accounts || [], "id");
  const currentTransactions = byId(current.transactions || [], "id");
  const currentOperations = byId(current.investmentOperations || [], "id");
  const nextTransactions = [...(current.transactions || [])];
  const nextAccounts = new Map(currentAccounts);
  // Conserva los auditLogs entrantes (antes se descartaban en cada escritura).
  const auditLogs = mergeById(current.auditLogs || [], incoming.auditLogs || [], "id");
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
    .filter((transaction) => transaction?.id && transactionNeedsProcessing(currentTransactions, transaction))
    .sort((left, right) => Date.parse(left.createdAt || updatedAt) - Date.parse(right.createdAt || updatedAt));

  const paymentLinksMap = byId(mergeById(current.paymentLinks || [], incoming.paymentLinks || []), "id");
  for (const transaction of newTransactions) {
    const result = applyServerTransaction(nextAccounts, currentTransactions, currentOperations, paymentLinksMap, transaction, treasuryConfig);
    if (!result.ok) {
      auditLogs.push(auditLog("rejected_transaction", transaction.id, result.reason));
      continue;
    }
    // Si era Pending y ahora es Settled, sustituir la versión anterior (nunca duplicar).
    if (currentTransactions.has(transaction.id)) {
      const idx = nextTransactions.findIndex((item) => item.id === transaction.id);
      if (idx >= 0) nextTransactions.splice(idx, 1);
    }
    // Persistir SIEMPRE (Pending o Settled) para no perder operaciones en curso.
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
    users: mergeById(current.users || [], incoming.users || [], "dip"),
    digitalCards: mergeById(current.digitalCards || [], incoming.digitalCards || []),
    savedContacts: dedupeByComposite(mergeById(current.savedContacts || [], incoming.savedContacts || []), (contact) => `${contact.ownerPlacetaId}:${contact.accountId}`),
    payrollContracts: mergeById(current.payrollContracts || [], incoming.payrollContracts || []),
    payrollPeriods: mergeById(current.payrollPeriods || [], incoming.payrollPeriods || []),
    promoSlides: mergeById(current.promoSlides || [], incoming.promoSlides || []),
    complianceFlags: mergeById(current.complianceFlags || [], incoming.complianceFlags || []),
    supportTickets: mergeById(current.supportTickets || [], incoming.supportTickets || []),
    paymentLinks: mergeById(current.paymentLinks || [], incoming.paymentLinks || []),
    gdlpSharedNews: mergeById(current.gdlpSharedNews || [], incoming.gdlpSharedNews || [], "slug"),
    periodicoNews: mergeById(current.periodicoNews || [], incoming.periodicoNews || [], "slug"),
    donationRewards: mergeById(current.donationRewards || [], incoming.donationRewards || []),
    userModulePreferences: mergeById(current.userModulePreferences || [], incoming.userModulePreferences || [], "placetaId"),
    productContractTemplates: mergeById(current.productContractTemplates || [], incoming.productContractTemplates || [], "id"),
    signedProductContracts: mergeById(current.signedProductContracts || [], incoming.signedProductContracts || [], "id"),
    accountHolders: mergeById(current.accountHolders || [], incoming.accountHolders || [], "id"),
    guardianRenewalDecisions: mergeById(current.guardianRenewalDecisions || [], incoming.guardianRenewalDecisions || [], "id"),
    executionCodes: mergeById(current.executionCodes || [], incoming.executionCodes || [], "id"),
    auditLogs,
    treasuryConfig,
    updatedAt
  };
}

export function applyServerTransaction(accounts, currentTransactions, currentOperations, paymentLinks, transaction, config = {}) {
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
    // IVA esperado del CNIC-IVA del BOLP (CNI-BANCO Art. 4), fallback 12 %.
    const expectedVat = Math.ceil(amount * ivaPorcentajeSync() / 100);
    
    const link = paymentLinks.get(transaction.originalTransactionId);
    if (!link) return denied("payment_link_not_found");
    if (link.amountPz !== amount) return denied("payment_link_amount_mismatch");
    if (link.ivaPz !== tax) return denied("payment_link_iva_mismatch");
    
    if (transaction.concept === "PAYMENT_LINK") {
      const targetMatchesCreator = transaction.toAccountId === link.creatorAccountId;
      const targetMatchesIban = link.targetIban && to && normalize(to.iban) === normalize(link.targetIban);
      if (!targetMatchesCreator && !targetMatchesIban) return denied("payment_link_recipient_mismatch");
    } else {
      if (transaction.fromAccountId !== link.creatorAccountId) return denied("payment_link_sender_mismatch");
    }
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

  // ── Execution Code Validation for Fines ────────────────────────────
  if (transaction.kind === "Fine" && transaction.concept !== "ADMIN_SANCTION_DIRECT") {
    // Las sanciones estatales requieren un código de ejecución válido
    if (!transaction.executionCodeRef) {
      return denied("execution_code_required_for_fine");
    }
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
  // Art. 6 CNI: PLJUNIOR_PAYMENT (recompensas/juegos de Capitalia para Placeta
  // Junior) está sujeta a tributos (IVA, IRM, IGF): el IVA se liquida a TGLP.
  if (tax > 0 && ["Consumption", "Placezum", "InvestmentBuy", "PLJUNIOR_PAYMENT"].includes(transaction.kind) && tglp) tglp.balancePz += tax;
  if (transaction.kind === "Rbu" && to) to.lastRbuClaim = (transaction.createdAt || new Date().toISOString()).slice(0, 10);
  return { ok: true };
}

function debitFor(kind, amount, tax) {
  if (["Consumption", "Placezum", "InvestmentBuy", "PLJUNIOR_PAYMENT"].includes(kind)) return amount + tax;
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
    // Se devuelve la operación vinculada AUNQUE ya esté settledAt: la app puede
    // marcar la operación como liquidada en un payload previo (race al canjear),
    // y la protección real contra dobles cobros es el check duplicateSettlement
    // de applyServerTransaction. Si la sell nunca se guardó, debe aceptarse.
    if (linked) return linked;
  }
  const operationId = settlementOperationId(transaction);
  if (!operationId) return null;
  return [...operations.values()].find((operation) =>
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
  const spec = listSpecs.find(([stateKey, collectionName]) => stateKey === name || collectionName === name);
  if (!spec || spec[0] === "meta" || spec[0] === "treasuryConfig") return null;
  const [, collectionName] = spec;
  return (await mongo()).collection(collectionName).find({}).project({ _id: 0 }).toArray();
}

export async function upsertEntity(name, id, payload) {
  const spec = listSpecs.find(([stateKey, collectionName]) => stateKey === name || collectionName === name);
  if (!spec) return null;
  const [, collectionName, idKey] = spec;
  const doc = stripEmptyMongoKeys({ ...payload, [idKey]: id });
  await (await mongo()).collection(collectionName).replaceOne(
    { _id: id },
    stripEmptyMongoKeys({ _id: id, ...doc }),
    { upsert: true }
  );
  await touchMeta();
  return doc;
}

export async function deleteEntity(name, id) {
  const spec = listSpecs.find(([stateKey, collectionName]) => stateKey === name || collectionName === name);
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
    stripEmptyMongoKeys({ _id: "treasuryConfig", ...config }),
    { upsert: true }
  );
  await touchMeta();
  return config;
}

/**
 * Lee la configuración guardada y le superpone (en vivo, no bloqueante) los
 * valores NORMATIVOS del BOLP: así el Banco nunca sirve a apps/web un valor
 * de CNIC desactualizado ni hardcodeado.
 */
async function leerTreasuryConfigConNormativa(db) {
  let config = {};
  const raw = await db.collection(bankCollections.treasuryConfig).findOne({ _id: "treasuryConfig" });
  if (raw) {
    delete raw._id;
    config = raw;
  }
  const { config: conNormativa, revision } = overlayTreasuryConfigNormativa(config);
  if (revision) conNormativa._normativaRevision = revision;
  return conNormativa;
}

export async function readTreasuryConfig() {
  const db = await mongo();
  return leerTreasuryConfigConNormativa(db);
}

async function touchMeta() {
  await (await mongo()).collection(bankCollections.meta).updateOne(
    { _id: "state" },
    { $set: { schemaSeedVersion: 2, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
}
