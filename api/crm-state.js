import { json } from "../lib/http.js";
import { readBankState } from "../lib/bankCollections.js";

const CRM_KEY = process.env.CRM_READ_KEY || '';

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "X-CRM-Key, Content-Type"
      });
      return res.end();
    }

    if (req.method !== "GET") {
      return json(res, 405, { error: "method_not_allowed" });
    }

    // Validar CRM key
    const key = req.headers["x-crm-key"];
    if (!CRM_KEY || key !== CRM_KEY) {
      return json(res, 401, { error: "invalid_crm_key" });
    }

    const state = await readBankState();
    if (!state.accounts?.length) return json(res, 404, { error: "state_not_found" });

    return json(res, 200, state);
  } catch (error) {
    return json(res, 500, { error: error.message || "internal_error" });
  }
}
