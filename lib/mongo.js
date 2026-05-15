import { MongoClient } from "mongodb";
import { config } from "./config.js";

let clientPromise;

export async function mongo() {
  if (!clientPromise) {
    const client = new MongoClient(config.mongoUri(), {
      maxPoolSize: 8,
      minPoolSize: 0,
      retryWrites: true,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 30000
    });
    clientPromise = client.connect();
  }
  const client = await clientPromise;
  return client.db(config.dbName());
}

export async function stateCollection() {
  return (await mongo()).collection(config.stateCollection());
}

export async function nonceCollection() {
  const collection = (await mongo()).collection(config.nonceCollection());
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await collection.createIndex({ appId: 1, nonce: 1 }, { unique: true });
  return collection;
}
