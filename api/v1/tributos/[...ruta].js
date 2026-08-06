// Catch-all unificado de Tributos (/api/v1/tributos/*)
// ─────────────────────────────────────────────────────────────────────────────
// Consolidación de los antiguos endpoints sueltos en UN SOLO serverless function
// para no superar el límite de 12 funciones del plan Hobby de Vercel.
//
//   POST /api/v1/tributos/alta                        → alta de contribuyente
//   GET  /api/v1/tributos/contribuyentes              → listado de contribuyentes
//   GET  /api/v1/tributos/validar-eip?eip=            → validar EIP
//   GET  /api/v1/tributos/declaraciones/listar        → declaraciones del contribuyente
//   GET  /api/v1/tributos/declaraciones/breakdown-iva → desglose IVA
//   POST /api/v1/tributos/facturas/nueva              → alta de factura
//   POST /api/v1/tributos/regularizaciones/verificar  → verificar regularización
import { json, methodNotAllowed, readBody } from "../../../lib/http.js";
import {
  answerOptions, createCorsHeaders,
  listContributors, createContributor, createDeclarationForContributor,
  findContributorByEip, listDeclarationsForContributor,
  getBreakdown, createInvoice, verifyRegularization
} from "../../../lib/tributos.js";

const ADMIN_PLACETA_URL = process.env.ADMIN_PLACETA_URL || 'https://rsp.laplaceta.org';
const TRIBUTOS_API_KEY = process.env.TRIBUTOS_API_KEY || 'android-tributos-key-2026';

function segmentos(req) {
  // Vercel entrega req.query.ruta como ARRAY para catch-all [...ruta] cuando hay
  // varios segmentos, pero como STRING cuando hay uno solo. Normalizamos ambos.
  const raw = req.query?.ruta;
  const lista = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  return lista.map(s => String(s).toLowerCase());
}

/** Consulta las declaraciones publicadas/aprobadas desde el panel (Supabase) vía gateway. */
async function fetchPanelDeclarations(placetaId) {
  try {
    const url = `${ADMIN_PLACETA_URL}/api/v1/tributos/declaraciones`;
    const r = await fetch(url, {
      headers: { 'X-API-Key': TRIBUTOS_API_KEY, 'X-Platform': 'android' },
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
        pdf_url: d.pdf_url || (d._estado_semantico && /aprob|emit|pag/i.test(d._estado_semantico) ? `${ADMIN_PLACETA_URL}/api/v1/tributos/declaraciones/${d.id}/pdf` : null),
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

    const seg = segmentos(req);
    const first = seg[0];

    // ── POST /alta ────────────────────────────────────────────────────
    if (first === 'alta') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST', 'OPTIONS']);
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const contributor = await createContributor(payload);
      await createDeclarationForContributor(contributor);
      return json(res, 200, { status: 'SUCCESS', message: 'Censo fiscal registrado con éxito. Acceso bancario liberado.', fecha_alta: new Date().toISOString() });
    }

    // ── GET /contribuyentes ───────────────────────────────────────────
    if (first === 'contribuyentes') {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'OPTIONS']);
      const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 1000);
      const contributors = await listContributors(limit);
      return json(res, 200, { contribuyentes: contributors, total: contributors.length });
    }

    // ── GET /validar-eip ──────────────────────────────────────────────
    if (first === 'validar-eip') {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'OPTIONS']);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const eip = url.searchParams.get('eip') || '';
      if (!eip) return json(res, 400, { error: 'EIP requerido' });
      const contributor = await findContributorByEip(eip);
      if (!contributor) return json(res, 404, { error: 'EIP no encontrado', eip });
      return json(res, 200, {
        valido: true,
        eip: contributor.eip || eip,
        nombre: contributor.nombre,
        tipo_sujeto: contributor.tipo_sujeto,
        placeta_id: contributor.placeta_id,
        estado_fiscal: contributor.estado_fiscal,
        fecha_alta: contributor.fecha_alta_tributos
      });
    }

    // ── GET /declaraciones/listar ─────────────────────────────────────
    if (first === 'declaraciones' && seg[1] === 'listar') {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'OPTIONS']);
      const url = new URL(req.url, 'https://api.local');
      const placetaId = url.searchParams.get('placeta_id') || url.searchParams.get('placetaId');
      const dip = url.searchParams.get('dip');
      if (!placetaId && !dip) return json(res, 400, { error: 'placeta_id_o_dip_requerido' });

      if (placetaId) {
        const panel = await fetchPanelDeclarations(placetaId);
        if (panel && panel.length > 0) return json(res, 200, { status: 'SUCCESS', origen: 'admin-placeta', declaraciones: panel });
      }
      const declaraciones = await listDeclarationsForContributor({ placetaId, dip });
      return json(res, 200, { status: 'SUCCESS', origen: 'mongo', declaraciones });
    }

    // ── GET /declaraciones/breakdown-iva ──────────────────────────────
    if (first === 'declaraciones' && seg[1] === 'breakdown-iva') {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'OPTIONS']);
      const url = new URL(req.url, 'https://api.local');
      const placetaId = url.searchParams.get('placeta_id') || url.searchParams.get('placetaId');
      const mesPeriodo = url.searchParams.get('mes_periodo') || url.searchParams.get('mesPeriodo');
      const payload = await getBreakdown({ placetaId, mesPeriodo });
      return json(res, 200, payload);
    }

    // ── POST /facturas/nueva ──────────────────────────────────────────
    if (first === 'facturas' && seg[1] === 'nueva') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST', 'OPTIONS']);
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const invoice = await createInvoice(payload);
      return json(res, 201, {
        status: 'SUCCESS',
        factura_id: invoice.id,
        base_imponible: invoice.base_imponible,
        total_iva: invoice.total_iva,
        total_factura: invoice.total_factura,
        csv_verificacion: invoice.csv_verificacion
      });
    }

    // ── POST /regularizaciones/verificar ──────────────────────────────
    if (first === 'regularizaciones' && seg[1] === 'verificar') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST', 'OPTIONS']);
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const result = await verifyRegularization(payload);
      return json(res, 200, result);
    }

    return json(res, 404, { error: `ruta_tributos_no_encontrada: /${seg.join('/')}` });
  } catch (error) {
    return json(res, error.statusCode || 500, { error: error.message || 'internal_error' });
  }
}
