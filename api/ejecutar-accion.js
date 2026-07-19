/**
 * Ejecutar Acción — Procesa acciones firmadas desde admin-placeta
 * 
 * Llamado por admin-placeta cuando un documento ha sido firmado.
 * Ejecuta la acción correspondiente en el banco (crear cuenta, modificar, etc.)
 */

import crypto from 'crypto';

const MONGO_BRIDGE_URL = process.env.MONGO_BRIDGE_URL || 'http://localhost:8787';
const PLACETA_API_SECRET = process.env.PLACETA_API_SECRET || '';
const VALID_API_KEYS = (process.env.DOCS_API_KEYS || 'docs-shared-key-2026').split(',');

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

async function getBankState() {
  const headers = buildSignedTransaction('GET', '/api/state');
  const r = await fetch(`${MONGO_BRIDGE_URL}/api/state`, { headers });
  if (!r.ok) throw new Error(`Banco API error: ${r.status}`);
  return r.json();
}

async function saveBankState(state) {
  const body = JSON.stringify(state);
  const headers = buildSignedTransaction('PUT', '/api/state', body);
  const r = await fetch(`${MONGO_BRIDGE_URL}/api/state`, { method: 'PUT', headers, body });
  if (!r.ok) throw new Error(`Error guardando: ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // Auth
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey || !VALID_API_KEYS.includes(apiKey)) {
    return res.status(401).json({ error: 'API key inválida' });
  }

  const rawBody = req.body || '{}';
  const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  const { action, data, firmadoPor, actionId } = body;

  if (!action) return res.status(400).json({ error: 'action requerido' });

  try {
    const state = await getBankState();
    let result;

    switch (action) {
      case 'crear-cuenta':
        result = await ejecutarCrearCuenta(state, data, firmadoPor);
        break;
      case 'modificar-cuenta':
        result = await ejecutarModificarCuenta(state, data, firmadoPor);
        break;
      case 'contratar-producto':
        result = await ejecutarContratarProducto(state, data, firmadoPor);
        break;
      case 'bloquear-cuenta':
        result = await ejecutarBloqueoCuenta(state, data, firmadoPor);
        break;
      case 'cerrar-cuenta':
        result = await ejecutarCerrarCuenta(state, data, firmadoPor);
        break;
      default:
        return res.status(400).json({ error: `Acción desconocida: ${action}` });
    }

    // Guardar estado actualizado
    await saveBankState(state);

    // Registrar transacción de auditoría
    state.transactions = state.transactions || [];
    state.transactions.push({
      id: `audit-${actionId || crypto.randomUUID()}`,
      kind: 'Audit',
      fromAccountId: 'SYSTEM',
      toAccountId: firmadoPor || 'unknown',
      amountPz: 0,
      concept: `Acción firmada: ${action}`,
      note: `ActionID: ${actionId || 'N/A'} · Data: ${JSON.stringify(data)}`,
      status: 'Settled',
      createdAt: new Date().toISOString()
    });

    res.json({
      success: true,
      action,
      actionId,
      result,
      message: `✅ Acción "${action}" ejecutada correctamente`
    });

  } catch (e) {
    console.error(`[EjecutarAccion] Error en ${action}:`, e);
    res.status(500).json({ success: false, error: e.message });
  }
}

// ══════════════════════════════════════════════════════════════════════
//  EJECUTORES DE ACCIONES
// ══════════════════════════════════════════════════════════════════════

async function ejecutarCrearCuenta(state, data, firmadoPor) {
  const { placetaId, tipoCuenta = 'Current', displayName } = data;
  const accountId = `u-${placetaId?.toLowerCase()?.replace(/[^a-z0-9]/g, '')}-${Date.now()}`;
  const iban = `GDLP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  const newAccount = {
    id: accountId,
    _id: accountId,
    kind: 'CITIZEN',
    type: tipoCuenta,
    displayName: displayName || `Cuenta ${tipoCuenta}`,
    iban,
    placetaId,
    balancePz: 0,
    createdAt: new Date().toISOString(),
    createdBy: `firma:${firmadoPor}`,
    complianceStatus: 'Clear',
    active: true
  };

  state.accounts = [...(state.accounts || []), newAccount];
  return { accountId, iban, tipo: tipoCuenta };
}

async function ejecutarModificarCuenta(state, data) {
  const { accountId, campo, valorNuevo } = data;
  const account = state.accounts?.find(a => a.id === accountId);
  if (!account) throw new Error(`Cuenta ${accountId} no encontrada`);

  if (campo === 'tipo') account.type = valorNuevo;
  else if (campo === 'nombre') account.displayName = valorNuevo;
  else if (campo === 'limite') account.sendLimitPz = parseInt(valorNuevo);
  else account[campo] = valorNuevo;

  account.updatedAt = new Date().toISOString();
  account.updatedBy = `firma:${data.firmadoPor || 'sistema'}`;

  return { accountId, cambios: { campo, valorNuevo } };
}

async function ejecutarContratarProducto(state, data) {
  const { accountId, productType } = data;
  const account = state.accounts?.find(a => a.id === accountId);
  if (!account) throw new Error(`Cuenta ${accountId} no encontrada`);

  account.products = [...(account.products || []), {
    type: productType,
    contractedAt: new Date().toISOString(),
    status: 'active'
  }];

  return { accountId, productType, status: 'active' };
}

async function ejecutarBloqueoCuenta(state, data) {
  const { accountId } = data;
  const account = state.accounts?.find(a => a.id === accountId);
  if (!account) throw new Error(`Cuenta ${accountId} no encontrada`);

  account.complianceStatus = 'Blocked';
  account.blockedAt = new Date().toISOString();
  account.blockedReason = data.motivo || 'Solicitud del titular';

  return { accountId, status: 'blocked' };
}

async function ejecutarCerrarCuenta(state, data) {
  const { accountId } = data;
  const account = state.accounts?.find(a => a.id === accountId);
  if (!account) throw new Error(`Cuenta ${accountId} no encontrada`);

  account.closedAt = new Date().toISOString();
  account.closedReason = data.motivo || 'Baja solicitada por el titular';
  account.active = false;

  return { accountId, status: 'closed' };
}
