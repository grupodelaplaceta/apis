import { json, methodNotAllowed, readBody } from "../lib/http.js";
import { assertRequestAllowed } from "../lib/security.js";
import { readBankState, writeBankState } from "../lib/bankCollections.js";

export default async function handler(req, res) {
  try {
    const body = req.method === "PUT" ? await readBody(req) : "";
    await assertRequestAllowed(req, body);

    if (req.method === "GET") {
      const state = await readBankState();
      if (!state.accounts?.length) return json(res, 404, { error: "state_not_found" });
      return json(res, 200, state);
    }

    if (req.method === "PUT") {
      const state = JSON.parse(body || "{}");
      return json(res, 200, await writeBankState(state));
    }

    return methodNotAllowed(res, ["GET", "PUT"]);
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: error.message || "internal_error"
    });
  }
}
