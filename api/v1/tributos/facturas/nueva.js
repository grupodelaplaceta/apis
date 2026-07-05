import { json, methodNotAllowed, readBody } from "../../../../lib/http.js";
import { answerOptions, createCorsHeaders, createInvoice } from "../../../../lib/tributos.js";

export default async function handler(req, res) {
  try {
    createCorsHeaders(res);
    if (req.method === "OPTIONS") return answerOptions(res);
    if (req.method !== "POST") return methodNotAllowed(res, ["POST", "OPTIONS"]);

    const body = await readBody(req);
    const payload = JSON.parse(body || "{}");
    const invoice = await createInvoice(payload);

    return json(res, 201, {
      status: "SUCCESS",
      factura_id: invoice.id,
      base_imponible: invoice.base_imponible,
      total_iva: invoice.total_iva,
      total_factura: invoice.total_factura,
      csv_verificacion: invoice.csv_verificacion
    });
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: error.message || "internal_error"
    });
  }
}
