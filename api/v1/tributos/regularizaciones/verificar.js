import { json, methodNotAllowed, readBody } from "../../../../lib/http.js";
import { answerOptions, createCorsHeaders, verifyRegularization } from "../../../../lib/tributos.js";

export default async function handler(req, res) {
  try {
    createCorsHeaders(res);
    if (req.method === "OPTIONS") return answerOptions(res);
    if (req.method !== "POST") return methodNotAllowed(res, ["POST", "OPTIONS"]);

    const body = await readBody(req);
    const payload = JSON.parse(body || "{}");
    const result = await verifyRegularization(payload);
    return json(res, 200, result);
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: error.message || "internal_error"
    });
  }
}
