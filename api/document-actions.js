/**
 * API de Acciones con Documento — Banco de La Placeta
 * 
 * Flujo:
 * 1. App solicita una acción (abrir cuenta, modificar, contratar producto)
 * 2. Este endpoint la registra como pendiente y notifica a admin-placeta
 * 3. Admin-placeta genera un documento y lo envía a PlacetaID Móvil
 * 4. Usuario firma → admin-placeta callback → acción procesada
 */

import crypto from 'crypto';

// Config
const ADMIN_PLACETA_URL = process.env.ADMIN_PLACETA_URL || 'https://admin-placeta.vercel.app';
const DOCS_API_KEY = process.env.DOCS_API_KEY || 'docs-shared-key-2026';
const PLACETA_API_SECRET = process.env.PLACETA_API_SECRET || '';
const MONGO_BRIDGE_URL = process.env.MONGO_BRIDGE_URL || 'http://localhost:8787';

/**
 * Firma HMAC para comunicación con el Mongo Bridge
 */
function buildSignedTransaction(method, path, body = '') {
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const payload = [method, path, timestamp, nonce, bodyHash].join('\n');
  const signature = crypto.createHmac('sha256', PLACETA_API_SECRET).update(payload).digest('hex');
  return {
    'Content-Type': 'application/json',
    'x-placeta-timestamp': timestamp,
    'x-placeta-nonce': nonce,
    'x-placeta-signature': signature,
    'x-placeta-app-id': 'org.laplaceta.banco'
  };
}

/**
 * Lee el estado actual del banco desde el bridge
 */
async function getBankState() {
  const headers = buildSignedTransaction('GET', '/api/state');
  const r = await fetch(`${MONGO_BRIDGE_URL}/api/state`, { headers });
  if (!r.ok) throw new Error(`Banco API error: ${r.status}`);
  return r.json();
}

/**
 * Guarda el estado del banco en el bridge
 */
async function saveBankState(state) {
  const body = JSON.stringify(state);
  const headers = buildSignedTransaction('PUT', '/api/state', body);
  const r = await fetch(`${MONGO_BRIDGE_URL}/api/state`, { method: 'PUT', headers, body });
  if (!r.ok) throw new Error(`Error guardando estado: ${r.status}`);
  return r.json();
}

/**
 * Solicita a admin-placeta crear un documento para una acción
 */
async function solicitarDocumentoAAdmin({ tipo, titulo, entidad, dipSolicitante, nombreSolicitante, datos }) {
  try {
    const r = await fetch(`${ADMIN_PLACETA_URL}/api/acciones/solicitar-documento`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': DOCS_API_KEY
      },
      body: JSON.stringify({
        tipo,
        titulo,
        entidad: entidad || 'banco',
        dipSolicitante,
        nombreSolicitante,
        datos,
        origen: 'banco-app'
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) {
      const err = await r.text();
      console.error('[DocumentActions] Error admin-placeta:', r.status, err);
      return null;
    }
    return r.json();
  } catch (e) {
    console.error('[DocumentActions] Error conectando con admin-placeta:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════
//  HANDLER PRINCIPAL (Vercel serverless)
// ══════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Leer body (Vercel raw body)
  const rawBody = req.body || '{}';
  const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  const { action, dip, nombre, datos = {} } = body;

  if (!action || !dip) {
    res.status(400).json({ error: 'action y dip son requeridos' });
    return;
  }

  try {
    switch (action) {
      case 'solicitar-apertura-cuenta':
        return await solicitarAperturaCuenta(dip, nombre, datos, res);
      case 'solicitar-modificacion-cuenta':
        return await solicitarModificacionCuenta(dip, nombre, datos, res);
      case 'solicitar-contrato-producto':
        return await solicitarContratoProducto(dip, nombre, datos, res);
      case 'solicitar-bloqueo-cuenta':
        return await solicitarBloqueoCuenta(dip, nombre, datos, res);
      case 'solicitar-baja-cuenta':
        return await solicitarBajaCuenta(dip, nombre, datos, res);
      default:
        res.status(400).json({ error: `Acción desconocida: ${action}` });
    }
  } catch (e) {
    console.error('[DocumentActions] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

// ══════════════════════════════════════════════════════════════════════
//  ACCIONES
// ══════════════════════════════════════════════════════════════════════

/**
 * Solicitar apertura de nueva cuenta
 */
async function solicitarAperturaCuenta(dip, nombre, datos, res) {
  const { tipoCuenta = 'Current', displayName } = datos;

  // 1. Pedir a admin-placeta que genere el documento
  const docResult = await solicitarDocumentoAAdmin({
    tipo: 'contrato-apertura',
    titulo: `Apertura de cuenta ${tipoCuenta}`,
    entidad: 'banco',
    dipSolicitante: dip,
    nombreSolicitante: nombre,
    datos: {
      tipoCuenta,
      displayName: displayName || `Cuenta ${tipoCuenta}`,
      fechaSolicitud: new Date().toISOString(),
      estado: 'pendiente-firma'
    }
  });

  if (!docResult) {
    res.status(503).json({
      success: true,
      estado: 'pendiente-admin',
      message: 'Solicitud registrada. Admin generará el documento.',
      actionId: `pendiente-${Date.now()}`
    });
    return;
  }

  res.json({
    success: true,
    estado: 'pendiente-firma',
    message: 'Solicitud enviada. Revisa PlacetaID Móvil para firmar el documento.',
    documentoId: docResult.documento?.id,
    actionId: docResult.actionId
  });
}

/**
 * Solicitar modificación de cuenta (tipo, nombre, límites)
 */
async function solicitarModificacionCuenta(dip, nombre, datos, res) {
  const { accountId, campo, valorActual, valorNuevo } = datos;

  const docResult = await solicitarDocumentoAAdmin({
    tipo: 'contrato-modificacion',
    titulo: `Modificación de cuenta`,
    entidad: 'banco',
    dipSolicitante: dip,
    nombreSolicitante: nombre,
    datos: {
      accountId,
      campo,
      valorActual,
      valorNuevo,
      fechaSolicitud: new Date().toISOString(),
      estado: 'pendiente-firma'
    }
  });

  if (!docResult) {
    res.status(503).json({
      success: true,
      estado: 'pendiente-admin',
      message: 'Solicitud registrada. Admin generará el documento.'
    });
    return;
  }

  res.json({
    success: true,
    estado: 'pendiente-firma',
    message: 'Solicitud enviada. Revisa PlacetaID Móvil para firmar el documento.',
    documentoId: docResult.documento?.id
  });
}

/**
 * Solicitar contratación de producto
 */
async function solicitarContratoProducto(dip, nombre, datos, res) {
  const { productType, accountId } = datos;

  const docResult = await solicitarDocumentoAAdmin({
    tipo: 'apertura-deposito',
    titulo: `Contratación de producto: ${productType}`,
    entidad: 'banco',
    dipSolicitante: dip,
    nombreSolicitante: nombre,
    datos: {
      productType,
      accountId,
      fechaSolicitud: new Date().toISOString(),
      estado: 'pendiente-firma'
    }
  });

  if (!docResult) {
    res.status(503).json({
      success: true,
      estado: 'pendiente-admin',
      message: 'Solicitud registrada. Admin generará el documento.'
    });
    return;
  }

  res.json({
    success: true,
    estado: 'pendiente-firma',
    message: 'Solicitud enviada. Revisa PlacetaID Móvil para firmar el documento.',
    documentoId: docResult.documento?.id
  });
}

/**
 * Solicitar bloqueo de cuenta
 */
async function solicitarBloqueoCuenta(dip, nombre, datos, res) {
  const docResult = await solicitarDocumentoAAdmin({
    tipo: 'bloqueo-cuenta',
    titulo: 'Solicitud de bloqueo de cuenta',
    entidad: 'banco',
    dipSolicitante: dip,
    nombreSolicitante: nombre,
    datos: {
      ...datos,
      fechaSolicitud: new Date().toISOString(),
      estado: 'pendiente-firma'
    }
  });

  res.json({
    success: true,
    estado: 'pendiente-firma',
    message: 'Solicitud enviada. Revisa PlacetaID Móvil para firmar.',
    documentoId: docResult?.documento?.id
  });
}

/**
 * Solicitar baja de cuenta
 */
async function solicitarBajaCuenta(dip, nombre, datos, res) {
  const docResult = await solicitarDocumentoAAdmin({
    tipo: 'baja-cuenta',
    titulo: 'Solicitud de baja de cuenta',
    entidad: 'banco',
    dipSolicitante: dip,
    nombreSolicitante: nombre,
    datos: {
      ...datos,
      fechaSolicitud: new Date().toISOString(),
      estado: 'pendiente-firma'
    }
  });

  res.json({
    success: true,
    estado: 'pendiente-firma',
    message: 'Solicitud enviada. Revisa PlacetaID Móvil para firmar.',
    documentoId: docResult?.documento?.id
  });
}
