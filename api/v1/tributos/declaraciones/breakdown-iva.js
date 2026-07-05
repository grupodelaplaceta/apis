import { json, methodNotAllowed, readBody } from "../../../../lib/http.js";
import { answerOptions, createCorsHeaders, getBreakdown } from "../../../../lib/tributos.js";

export default async function handler(req, res) {
  try {
    createCorsHeaders(res);
    if (req.method === "OPTIONS") return answerOptions(res);
    if (req.method !== "GET") return methodNotAllowed(res, ["GET", "OPTIONS"]);

    const url = new URL(req.url, "https://api.local");
    const placetaId = url.searchParams.get("placeta_id") || url.searchParams.get("placetaId");
    const mesPeriodo = url.searchParams.get("mes_periodo") || url.searchParams.get("mesPeriodo");

    const payload = await getBreakdown({ placetaId, mesPeriodo });
    return json(res, 200, payload);
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: error.message || "internal_error"
    });
  }
}
