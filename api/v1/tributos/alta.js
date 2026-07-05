import { json, methodNotAllowed, readBody } from "../../../lib/http.js";
import { answerOptions, createContributor, createCorsHeaders, createDeclarationForContributor } from "../../../lib/tributos.js";

export default async function handler(req, res) {
  try {
    createCorsHeaders(res);
    if (req.method === "OPTIONS") return answerOptions(res);
    if (req.method !== "POST") return methodNotAllowed(res, ["POST", "OPTIONS"]);

    const body = await readBody(req);
    const payload = JSON.parse(body || "{}");
    const contributor = await createContributor(payload);
    await createDeclarationForContributor(contributor);

    return json(res, 200, {
      status: "SUCCESS",
      message: "Censo fiscal registrado con éxito. Acceso bancario liberado.",
      fecha_alta: new Date().toISOString()
    });
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: error.message || "internal_error"
    });
  }
}
