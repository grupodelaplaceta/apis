import { json, methodNotAllowed, createCorsHeaders, answerOptions } from "../../../lib/http.js";
import { listContributors } from "../../../lib/tributos.js";

export default async function handler(req, res) {
  try {
    createCorsHeaders(res);
    if (req.method === "OPTIONS") return answerOptions(res);
    if (req.method !== "GET") return methodNotAllowed(res, ["GET", "OPTIONS"]);

    const limit = Math.min(parseInt(req.query.limit || "500", 10) || 500, 1000);
    const contributors = await listContributors(limit);
    return json(res, 200, { contribuyentes: contributors, total: contributors.length });
  } catch (error) {
    return json(res, error.statusCode || 500, { error: error.message || "internal_error" });
  }
}
