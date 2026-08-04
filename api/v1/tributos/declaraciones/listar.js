import { json, methodNotAllowed } from "../../../../lib/http.js";
import { answerOptions, createCorsHeaders, listDeclarationsForContributor } from "../../../../lib/tributos.js";

const ADMIN_PLACETA_URL = process.env.ADMIN_PLACETA_URL || 'https://admin.laplaceta.org';
const TRIBUTOS_API_KEY = process.env.TRIBUTOS_API_KEY || 'android-tributos-key-2026';

/** Consulta las declaraciones publicadas/aprobadas desde el panel (Supabase) vía gateway. */
async function fetchPanelDeclarations(placetaId) {
  try {
    const url = `${ADMIN_PLACETA_URL}/api/v1/tributos/declaraciones`;
    const r = await fetch(url, {
      headers: {
        'X-API-Key': TRIBUTOS_API_KEY,
        'X-Platform': 'android'
      },
      signal: AbortSignal.timeout(9000)
    });
    if (!r.ok) return null;
    const body = await r.json();
    const lista = Array.isArray(body) ? body : (body?.data || []);
    return lista
      .filter((d) => d.placeta_id === placetaId || d.placetaId === placetaId)
      .map((d) => ({
        id: d.id,
        mes_periodo: d.mes_periodo,
        placeta_id: d.placeta_id || d.placetaId,
        cuenta_id_blp: d.cuenta_id_blp,
        patrimonio_medio: Number(d.patrimonio_medio || 0),
        indice_acumulacion: Number(d.indice_acumulacion || 0),
        cuota_irm: Number(d.cuota_irm || 0),
        cuota_igf: Number(d.cuota_igf || 0),
        exencion_aplicada: Boolean(d.exencion_aplicada),
        dias_activos_mes: Number(d.dias_activos_mes || 0),
        estado_pago: d._estado_semantico || d.estado_pago || 'Borrador',
        is_rectified: Boolean(d.is_rectified),
        created_at: d.created_at,
        updated_at: d.updated_at || d.created_at
      }));
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    createCorsHeaders(res);
    if (req.method === "OPTIONS") return answerOptions(res);
    if (req.method !== "GET") return methodNotAllowed(res, ["GET", "OPTIONS"]);

    const url = new URL(req.url, "https://api.local");
    const placetaId = url.searchParams.get("placeta_id") || url.searchParams.get("placetaId");
    const dip = url.searchParams.get("dip");

    if (!placetaId && !dip) {
      return json(res, 400, { error: "placeta_id_o_dip_requerido" });
    }

    // 1) Fuente de verdad: declaraciones del panel (Supabase) con estados publicadas/aprobadas.
    if (placetaId) {
      const panel = await fetchPanelDeclarations(placetaId);
      if (panel && panel.length > 0) {
        return json(res, 200, { status: "SUCCESS", origen: "admin-placeta", declaraciones: panel });
      }
    }

    // 2) Fallback: declaraciones registradas en MongoDB (backend-banco).
    const declaraciones = await listDeclarationsForContributor({ placetaId, dip });
    return json(res, 200, { status: "SUCCESS", origen: "mongo", declaraciones });
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: error.message || "internal_error"
    });
  }
}
