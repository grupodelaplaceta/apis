import { mongo } from "../lib/mongo.js";
import { json, methodNotAllowed, readBody } from "../lib/http.js";
import { assertRequestAllowed } from "../lib/security.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    await assertRequestAllowed(req, res, await readBody(req));
    await (await mongo()).command({ ping: 1 });
    return json(res, 200, { ok: true });
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: error.message || "internal_error"
    });
  }
}
