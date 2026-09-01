/**
 * Ejecutar Acción — Procesa acciones firmadas desde admin-placeta
 *
 * Llamado por admin-placeta cuando un documento ha sido firmado.
 * Ejecuta la acción correspondiente en el banco (crear cuenta, modificar, etc.)
 * y la persiste con la librería autoritativa (lock + reconciliación servidor),
 * en la MISMA base de datos de backend-banco. Ya no depende del mongo-bridge
 * (localhost:8787) que no existe en producción.
 */

import crypto from 'crypto';
import { readBankState, writeBankState } from '../lib/bankCollections.js';

const VALID_API_KEYS = (process.env.DOCS_API_KEYS || 'docs-shared-key-2026').split(',');

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
    const state = await readBankState();
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
      case 'registrar-fondo':
        result = await ejecutarRegistrarFondo(state, data, firmadoPor);
        break;
      default:
        return res.status(400).json({ error: `Acción desconocida: ${action}` });
    }

    // Registrar auditoría (colección propia, se conserva en la reconciliación)
    state.auditLogs = state.auditLogs || [];
    state.auditLogs.push({
      id: `audit-${actionId || crypto.randomUUID()}`,
      action: `Acción firmada: ${action}`,
      admin: firmadoPor || 'unknown',
      accountId: data?.accountId || data?.cuentaId || null,
      reason: JSON.stringify(data),
      createdAt: new Date().toISOString()
    });

    // Guardar con la librería autoritativa: lock + reconciliación + upsert.
    await writeBankState(state);

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

  // Alta AUTOMÁTICA en Tributos: toda cuenta nueva queda censada.
  // Empresa → se le genera un EIP; persona física → contribuyente normal.
  try {
    const { createContributor } = await import("../lib/tributos.js");
    await createContributor({
      placeta_id: placetaId,
      dip: firmadoPor || placetaId,
      nombre: displayName || `Cuenta ${tipoCuenta}`,
      tipo_sujeto: tipoCuenta === 'Business' ? 'Empresa' : 'Fisico',
      eip: tipoCuenta === 'Business' ? `EIP-${crypto.randomBytes(3).toString('hex').toUpperCase()}` : undefined,
      iban,
      roles_json: ['ciudadano']
    });
  } catch (e) {
    console.warn('[CrearCuenta] auto-alta tributos falló:', e.message);
  }

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

async function ejecutarRegistrarFondo(state, data) {
  const { accountId, riskLevel } = data;
  const account = state.accounts?.find(a => a.id === accountId);
  if (!account) throw new Error(`Cuenta ${accountId} no encontrada`);
  if (account.type !== 'Business') throw new Error('Solo cuentas de empresa pueden ser fondo');

  account.listedInvestmentFund = true;
  account.investmentRiskLevel = Math.min(7, Math.max(1, Number(riskLevel) || account.investmentRiskLevel || 3));
  account.fundConditionsSignedAt = new Date().toISOString();
  account.fundConditionsSignedBy = data.firmadoPor || null;
  account.fundPolicies = {
    aceptaCondiciones: true,
    politicasCancelacion: true
  };

  return { accountId, listedInvestmentFund: true, riskLevel: account.investmentRiskLevel };
}
