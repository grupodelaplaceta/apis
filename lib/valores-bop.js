/* ═══════════════════════════════════════════════════════════════════════
   backend-banco — Valores oficiales del BOLP (Boletín Oficial de La Placeta)
   -----------------------------------------------------------------------
   Fuente única para los valores NORMATIVOS que usa el Banco en cálculos y
   límites (IVA CNIC-IVA, bono de bienvenida, RBU, SMI, límites de saldo…).

   Regla de uso (bop.laplaceta.org): los valores solo se consumen desde
   `laplaceta.org` o subdominios en navegador; las peticiones SIN navegador
   (servidores) no se bloquean. Este módulo se ejecuta en el servidor, así
   que NO depende de CORS.

   Robustez:
     • caché en memoria de 60 s (TTL) con deduplicación de peticiones y
       timeout de red acotado (no debe ralentizar ni tumbar el banco).
     • cascada: /api/valores?todo=1 → /api/cnic → null. Si un código concreto
       no está disponible, `leerNumero(codigo, fb)` devuelve el fallback
       declarado en el punto de llamada (nunca NaN ni excepción).
     • getter síncrono `sincrono(codigo, fb)` para puntos de reconciliación
       que no pueden ser async (usa la última copia válida o el fallback).
   ═══════════════════════════════════════════════════════════════════════ */

const BOP_URL = (process.env.BOP_URL || 'https://bop.laplaceta.org').replace(/\/+$/, '');
const TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 3_000;

/** IVA por defecto (CNI-BANCO Art. 4) si el BOLP no responde. */
export const IVA_PCT_FALLBACK = 12;

let cache = { at: 0, data: null, revision: null, fuente: null, error: null };
let inflight = null;

function adaptarFila(row, fuente) {
  const codigo = row.codigo || row.canonico || row.cnic || '';
  const tipoValor = row.tipo || row.tipo_valor || 'porcentaje';
  const numero = Number(row.numero ?? row.valor ?? NaN);
  const derogado = row.vigente === false || String(row.estado || '').toLowerCase() === 'derogado';
  return {
    codigo,
    etiqueta: row.etiqueta || codigo,
    tipoValor,
    valor: Number.isFinite(numero) ? numero : row.valor,
    numero: Number.isFinite(numero) ? numero : null,
    valorCrudo: String(row.valor ?? ''),
    resumen: row.resumen || null,
    unidad: row.unidad || (tipoValor === 'porcentaje' ? '%' : ''),
    vigente: !derogado,
    estado: derogado ? 'derogado' : 'vigente',
    fuente,
    articulo: row.articulo || row.norma || '',
    bopUrl: `https://bop.laplaceta.org/cnic?codigo=${encodeURIComponent(codigo)}`,
    historial: Array.isArray(row.historial) ? row.historial : [],
  };
}

function fetchConTimeout(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(t));
}

async function desdeValores() {
  const r = await fetchConTimeout(`${BOP_URL}/api/valores?todo=1`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`BOP /api/valores respondió ${r.status}`);
  const payload = await r.json();
  if (payload.servicio !== 'bop.valores' || !payload.valores) throw new Error('Respuesta de valores inválida');
  const lista = Object.keys(payload.valores).map((k) => {
    const v = { ...payload.valores[k] };
    return adaptarFila({ ...v, codigo: v.codigo || k }, '/api/valores?todo=1');
  });
  return { lista, revision: payload.revision || null };
}

async function desdeCnic() {
  const r = await fetchConTimeout(`${BOP_URL}/api/cnic`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`BOP /api/cnic respondió ${r.status}`);
  const payload = await r.json();
  const rows = Array.isArray(payload) ? payload : (payload.cnic || []);
  const lista = rows.map((row) => adaptarFila(row, '/api/cnic'));
  return { lista, revision: payload.revision || payload.actualizado || null };
}

/** Catálogo canónico (vigente) del BOLP. Devuelve un array o null. */
async function cargarCatalogo(opts = {}) {
  if (!opts.fuerza && cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!opts.fuerza && inflight) return inflight;
  inflight = (async () => {
    let ok = false;
    try {
      const { lista, revision } = await desdeValores();
      cache = { at: Date.now(), data: lista.filter((r) => r.vigente), revision, fuente: '/api/valores?todo=1', error: null };
      ok = true;
    } catch (e) {
      try {
        const { lista, revision } = await desdeCnic();
        cache = { at: Date.now(), data: lista.filter((r) => r.vigente), revision, fuente: '/api/cnic (fallback)', error: null };
        ok = true;
      } catch (e2) {
        cache = { ...cache, at: Date.now(), data: null, error: `${e.message} · ${e2.message}` };
      }
    }
    if (!ok && cache.data) return cache.data; // devuelve la última copia válida
    return cache.data;
  })();
  try { return await inflight; } finally { inflight = null; }
}

/** Valores vigentes en formato del catálogo (o null si no hay copia). */
async function cargarVigentes(opts = {}) {
  const cat = await cargarCatalogo(opts);
  if (!cat) return null;
  return cat.filter((r) => r.estado === 'vigente');
}

/** Número de un CNIC (canónico o alias). Devuelve el fallback si no existe o no es numérico. */
async function leerNumero(codigo, fallback) {
  const vigentes = await cargarVigentes();
  if (!vigentes) return fallback;
  const r = vigentes.find((x) => String(x.codigo || '').toUpperCase() === String(codigo || '').toUpperCase());
  if (!r) return fallback;
  const n = Number(r.numero ?? r.valor ?? NaN);
  return Number.isFinite(n) ? n : fallback;
}

/** Igual que leerNumero pero solo con la copia ya en caché (para código síncrono). */
function sincrono(codigo, fallback) {
  const vigentes = cache.data;
  if (!vigentes) {
    // Dispara la carga en segundo plano sin bloquear (nunca lanza).
    if (Date.now() - cache.at >= TTL_MS) {
      cargarCatalogo({}).catch(() => {});
    }
    return fallback;
  }
  const r = vigentes.find((x) => String(x.codigo || '').toUpperCase() === String(codigo || '').toUpperCase());
  if (!r) return fallback;
  const n = Number(r.numero ?? r.valor ?? NaN);
  return Number.isFinite(n) ? n : fallback;
}

/** IVA porcentual (CNIC-IVA) en tanto por ciento para uso síncrono (fallback 12). */
function ivaPorcentajeSync() {
  return sincrono('CNIC-IVA', IVA_PCT_FALLBACK);
}

/**
 * Mapa de valores NORMATIVOS del CNI-BANCO que alimentan la configuración
 * que el Banco sirve a las apps/web (treasuryConfig). Solo se incluyen
 * correspondencias 1:1 sin ambigüedad: el resto de parámetros internos
 * (comisiones de operación, nº de cuentas…) son configuración interna.
 */
const CNIC_TREASURY_MAP = [
  { codigo: 'CNIC-RBU-SEMANAL', key: 'rbuAmountPz' },                       // CNI-BANCO Art. 6
  { codigo: 'CNIC-SMI-MENSUAL', key: 'minimumWeeklySalaryPz' },             // CNI-BANCO Art. 7 (SMI)
  { codigo: 'CNIC-CUENTA-CIUDADANA-SALDO', key: 'maxCurrentBalancePz' },    // CNI-BANCO Art. 1
  { codigo: 'CNIC-LIMITE-CAPITAL-PERSONAL', key: 'personalDeclarationThresholdPz' }, // CNI-BANCO Art. 1
  { codigo: 'CNIC-CUENTA-INSTITUCIONAL-SALDO', key: 'maxBusinessBalancePz' },        // CNI-BANCO Art. 1
  { codigo: 'CNIC-LIMITE-CAPITAL-INSTITUCIONAL', key: 'institutionalDeclarationThresholdPz' }, // CNI-BANCO Art. 1
  { codigo: 'CNIC-IVA', key: 'vatPercent' },                                // CNI-BANCO Art. 4
];

/**
 * Devuelve las claves normativas (config) con el valor vigente del BOLP,
 * fusionadas sobre `config`. NUNCA bloquea en red: si la caché está caliente
 * fusiona; si está vacía o caducada, dispara la recarga en segundo plano y
 * devuelve `config` tal cual (el consumidor usa su propio fallback y la
 * siguiente lectura ya lleva los valores vigentes). Nunca lanza.
 */
function overlayTreasuryConfigNormativa(config = {}) {
  const resultado = { ...config };
  const vigentes = cache.data;
  if (!vigentes || Date.now() - cache.at >= TTL_MS) {
    cargarCatalogo({}).catch(() => {});
    return { config: resultado, revision: cache.revision || null, usados: [] };
  }
  const usados = [];
  for (const { codigo, key } of CNIC_TREASURY_MAP) {
    const r = vigentes.find((x) => String(x.codigo || '').toUpperCase() === String(codigo || '').toUpperCase());
    if (!r) continue;
    const n = Number(r.numero ?? r.valor ?? NaN);
    if (!Number.isFinite(n)) continue;
    resultado[key] = n;
    usados.push(codigo);
  }
  return { config: resultado, revision: cache.revision || null, usados };
}

/** Diagnóstico del estado del módulo (para /api/valores interno y depuración). */
async function diagnostico(opts = {}) {
  const vigentes = await cargarCatalogo({ ...opts, fuerza: opts.fuerza });
  return {
    servicio: 'bop.valores',
    url: `${BOP_URL}/api/valores?todo=1`,
    revision: cache.revision || null,
    fuente: cache.fuente || null,
    error: cache.error || null,
    total: Array.isArray(vigentes) ? vigentes.length : 0,
    codigos: Array.isArray(vigentes) ? vigentes.map((r) => r.codigo) : [],
    at: new Date(cache.at || 0).toISOString(),
  };
}

function limpiarCache() {
  cache = { at: 0, data: null, revision: null, fuente: null, error: null };
  inflight = null;
}

export {
  BOP_URL,
  TTL_MS,
  cargarCatalogo,
  cargarVigentes,
  leerNumero,
  sincrono,
  ivaPorcentajeSync,
  CNIC_TREASURY_MAP,
  overlayTreasuryConfigNormativa,
  diagnostico,
  limpiarCache,
};
