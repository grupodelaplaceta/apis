import { json, methodNotAllowed, readBody } from "../lib/http.js";
import { assertRequestAllowed } from "../lib/security.js";
import {
  deleteEntity,
  readEntityCollection,
  upsertEntity,
  writeTreasuryConfig
} from "../lib/bankCollections.js";

export default async function handler(req, res) {
  try {
    const body = req.method === "GET" ? "" : await readBody(req);
    await assertRequestAllowed(req, res, body);

    const url = new URL(req.url, "https://api.local");
    const collection = url.searchParams.get("collection");
    const id = url.searchParams.get("id");
    if (!collection) return json(res, 400, { error: "missing_collection" });

    if (req.method === "GET") {
      const result = await readEntityCollection(collection);
      if (result == null) return json(res, 404, { error: "unknown_collection" });
      return json(res, 200, { items: result });
    }

    if (req.method === "PUT") {
      const payload = JSON.parse(body || "{}");
      if (collection === "treasuryConfig") {
        return json(res, 200, { item: await writeTreasuryConfig(payload) });
      }
      if (!id) return json(res, 400, { error: "missing_id" });
      const item = await upsertEntity(collection, id, payload);
      if (!item) return json(res, 404, { error: "unknown_collection" });
      return json(res, 200, { item });
    }

    if (req.method === "DELETE") {
      if (!id) return json(res, 400, { error: "missing_id" });
      const ok = await deleteEntity(collection, id);
      if (!ok) return json(res, 404, { error: "unknown_collection" });
      return json(res, 200, { ok: true });
    }

    return methodNotAllowed(res, ["GET", "PUT", "DELETE"]);
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: error.message || "internal_error"
    });
  }
}
