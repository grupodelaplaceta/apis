import { mongo } from "./mongo.js";

export const bankCollections = {
  meta: "bank_meta",
  users: "bank_users",
  accounts: "bank_accounts",
  transactions: "bank_transactions",
  subsidyRequests: "bank_subsidy_requests",
  investmentHoldings: "bank_investment_holdings",
  digitalCards: "bank_digital_cards",
  savedContacts: "bank_saved_contacts",
  promoSlides: "bank_promo_slides",
  complianceFlags: "bank_compliance_flags",
  treasuryConfig: "bank_treasury_config"
};

const listSpecs = [
  ["users", bankCollections.users, "dip"],
  ["accounts", bankCollections.accounts, "id"],
  ["transactions", bankCollections.transactions, "id"],
  ["subsidyRequests", bankCollections.subsidyRequests, "id"],
  ["investmentHoldings", bankCollections.investmentHoldings, "id"],
  ["digitalCards", bankCollections.digitalCards, "id"],
  ["savedContacts", bankCollections.savedContacts, "id"],
  ["promoSlides", bankCollections.promoSlides, "id"],
  ["complianceFlags", bankCollections.complianceFlags, "id"]
];

export async function readBankState() {
  const db = await mongo();
  const state = {};
  for (const [stateKey, collectionName] of listSpecs) {
    state[stateKey] = await db
      .collection(collectionName)
      .find({})
      .project({ _id: 0 })
      .toArray();
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

  for (const [stateKey, collectionName, idKey] of listSpecs) {
    const docs = Array.isArray(state[stateKey]) ? state[stateKey] : [];
    const collection = db.collection(collectionName);
    await collection.deleteMany({});
    if (docs.length > 0) {
      await collection.insertMany(
        docs.map((doc) => ({
          _id: doc[idKey],
          ...doc
        })),
        { ordered: false }
      );
    }
  }

  if (state.treasuryConfig && typeof state.treasuryConfig === "object") {
    await db.collection(bankCollections.treasuryConfig).replaceOne(
      { _id: "treasuryConfig" },
      { _id: "treasuryConfig", ...state.treasuryConfig },
      { upsert: true }
    );
  }

  await db.collection(bankCollections.meta).replaceOne(
    { _id: "state" },
    {
      _id: "state",
      schemaSeedVersion: state.schemaSeedVersion ?? 2,
      updatedAt
    },
    { upsert: true }
  );

  return { ok: true, updatedAt };
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
  const doc = { ...payload, [idKey]: id };
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
  await (await mongo()).collection(bankCollections.treasuryConfig).replaceOne(
    { _id: "treasuryConfig" },
    { _id: "treasuryConfig", ...payload },
    { upsert: true }
  );
  await touchMeta();
  return payload;
}

async function touchMeta() {
  await (await mongo()).collection(bankCollections.meta).updateOne(
    { _id: "state" },
    { $set: { schemaSeedVersion: 2, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
}
