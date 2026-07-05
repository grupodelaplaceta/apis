import { json, methodNotAllowed, readBody } from "../../../lib/http.js";
import { answerOptions, findContributorByEip, createCorsHeaders } from "../../../lib/tributos.js";

export default async function handler(req, res) {
  try {
    createCorsHeaders(res);
    if (req.method === "OPTIONS") return answerOptions(res);
    if (req.method !== "GET") return methodNotAllowed(res, ["GET", "OPTIONS"]);

    const url = new URL(req.url, `http://${req.headers.host}`);
    const eip = url.searchParams.get("eip") || "";

    if (!eip) return json(res, 400, { error: "EIP requerido" });

    const contributor = await findContributorByEip(eip);

    if (!contributor) return json(res, 404, { error: "EIP no encontrado", eip });

    return json(res, 200, {
      valido: true,
      eip: contributor.eip || eip,
      nombre: contributor.nombre,
      tipo_sujeto: contributor.tipo_sujeto,
      placeta_id: contributor.placeta_id,
      estado_fiscal: contributor.estado_fiscal,
      fecha_alta: contributor.fecha_alta_tributos
    });
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: error.message || "internal_error"
    });
  }
}
