/**
 * Banco de La Placeta — Servicio de integración bancaria
 * 
 * Toda transacción económica de Placeta Junior usa el Banco de La Placeta.
 * - Las compras (desbloquear niveles, etc.) pagan a Capitalia
 * - Capitalia paga el IVA a Tributos (TGLP)
 * - Los menores NO pagan impuestos directamente
 * - DEMO mode (tutor 11111111D): transacciones simuladas sin alterar saldos
 * 
 * Capitalia: cuenta empresarial que gestiona Placeta Junior
 * TGLP: Tesoro / Tributos (receptor de IVA)
 */

import crypto from 'crypto';

// DIP del tutor demo — transacciones simuladas
const DIP_TUTOR_DEMO = '11111111D';

// IDs de cuentas del Banco de La Placeta
export const BANCOS = {
  CAPITALIA: {
    accountId: 'CAPITALIA_BANK',
    placetaId: 'CAPITALIA-BANK',
    iban: 'GDLP-AP76-179',
    displayName: 'Capitália Empresa'
  },
  TGLP: {
    accountId: 'TGLP',
    placetaId: 'TGLP',
    displayName: 'Tesoro de La Placeta'
  }
};

// IVA estándar en el ecosistema
const IVA_PERCENT = 12; // 12%

// Configuración del Bridge de MongoDB
const BRIDGE_URL = process.env.MONGO_BRIDGE_URL || 'http://localhost:8787';
const API_SECRET = process.env.PLACETA_API_SECRET || '';
const API_APP_ID = process.env.PLACETA_API_APP_ID || 'org.laplaceta.placeta-junior';

/**
 * Genera una transacción firmada para el Mongo Bridge
 */
function buildSignedTransaction(method, path, body = '') {
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const payload = [method, path, timestamp, nonce, bodyHash].join('\n');
  const signature = crypto.createHmac('sha256', API_SECRET).update(payload).digest('hex');

  return {
    'Content-Type': 'application/json',
    'x-placeta-timestamp': timestamp,
    'x-placeta-nonce': nonce,
    'x-placeta-signature': signature,
    'x-placeta-app-id': API_APP_ID
  };
}

/**
 * Obtiene el estado actual del banco
 */
async function getBankState() {
  const headers = buildSignedTransaction('GET', '/api/state');
  const r = await fetch(`${BRIDGE_URL}/api/state`, { headers });
  if (!r.ok) throw new Error(`Banco API error: ${r.status}`);
  return r.json();
}

/**
 * Detecta si es una transacción demo (tutor 11111111D)
 */
function isDemoTransaction(juniorDip, tutorDip) {
  return juniorDip?.includes('DEMO') || tutorDip === DIP_TUTOR_DEMO;
}

/**
 * Envía una transacción al banco
 * Si es DEMO, crea transacciones con "(Demo)" que NO alteran los saldos reales
 */
export async function sendTransaction({ fromAccountId, toAccountId, amountPz, concept, kind = 'Transfer', ivaPz = 0, note = '', juniorDip = '', tutorDip = '' }) {
  const esDemo = isDemoTransaction(juniorDip, tutorDip);

  // 1. Obtener estado actual
  const state = await getBankState();

  // 2. Validar cuentas (solo si no es demo)
  const from = state.accounts?.find(a => a.id === fromAccountId);
  const to = state.accounts?.find(a => a.id === toAccountId);
  if (!from) throw new Error(`Cuenta origen ${fromAccountId} no encontrada`);
  if (!to) throw new Error(`Cuenta destino ${toAccountId} no encontrada`);

  // 3. Validar saldo (solo si no es demo)
  const totalDebit = amountPz + (ivaPz || 0);
  if (!esDemo && from.balancePz < totalDebit) {
    throw new Error(`Saldo insuficiente en ${fromAccountId}: tiene ${from.balancePz}, necesita ${totalDebit}`);
  }

  const suffix = esDemo ? ' (Demo)' : '';
  const txId = `pj-${esDemo ? 'demo-' : ''}${crypto.randomUUID()}`;

  // 4. Crear transacción
  const transaction = {
    id: txId,
    kind,
    fromAccountId,
    toAccountId,
    amountPz,
    ivaPz: ivaPz || 0,
    netAmount: amountPz,
    taxAmount: ivaPz || 0,
    concept: `${concept || 'Placeta Junior'}${suffix}`,
    note: `${note}${suffix}`,
    status: 'Settled',
    createdAt: new Date().toISOString(),
    IBAN_Origin: from.iban || '',
    originalTransactionId: null
  };

  // 5. Aplicar transacción (solo si NO es demo)
  if (!esDemo) {
    from.balancePz -= totalDebit;
    to.balancePz += amountPz;
  }

  // 6. IVA: Capitalia → TGLP (solo si NO es demo)
  if ((ivaPz || 0) > 0 && !esDemo) {
    const tglpAccount = state.accounts.find(a => a.id === BANCOS.TGLP.accountId);
    if (tglpAccount) {
      tglpAccount.balancePz += ivaPz;
    }
    const ivaTransaction = {
      id: `pj-iva-${esDemo ? 'demo-' : ''}${crypto.randomUUID()}`,
      kind: 'Tax',
      fromAccountId: BANCOS.CAPITALIA.accountId,
      toAccountId: BANCOS.TGLP.accountId,
      amountPz: ivaPz, ivaPz: 0, netAmount: ivaPz, taxAmount: 0,
      concept: `IVA Placeta Junior - ${concept || 'operación'}${suffix}`,
      note: `IVA del ${IVA_PERCENT}% pagado por Capitalia${suffix}`,
      status: 'Settled',
      createdAt: new Date().toISOString(),
      IBAN_Origin: BANCOS.CAPITALIA.iban,
      originalTransactionId: transaction.id
    };
    state.transactions = [...(state.transactions || []), ivaTransaction];
  }

  // 7. Añadir transacción al estado
  state.transactions = [...(state.transactions || []), transaction];

  // 8. Enviar estado actualizado al bridge
  const body = JSON.stringify(state);
  const headers = buildSignedTransaction('PUT', '/api/state', body);
  const r = await fetch(`${BRIDGE_URL}/api/state`, {
    method: 'PUT', headers, body
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Error al enviar transacción al banco: ${r.status} - ${errText}`);
  }

  return {
    success: true,
    transactionId: transaction.id,
    fromBalance: from.balancePz,
    toBalance: to.balancePz,
    ivaPagado: esDemo ? 0 : (ivaPz || 0),
    ivaTransactionId: (ivaPz > 0 && !esDemo) ? `pj-iva-${transaction.id}` : null,
    esDemo
  };
}

/**
 * Calcula el IVA para un importe
 */
export function calcularIVA(amountPz) {
  return Math.ceil(amountPz * IVA_PERCENT / 100);
}

/**
 * Crea una cuenta bancaria infantil con IBAN APP (Capitalia)
 */
export async function crearCuentaInfantil({ juniorDip, juniorNombre, tutorAccountId, sendLimitPz = 50 }) {
  const state = await getBankState();

  const accountId = `u-${juniorDip?.toLowerCase().replace(/-/g, '')}`;
  const placetaId = `JUNIOR-${juniorDip?.split('-')[1] || '0000'}`;
  const iban = `CAPI-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  // Verificar si ya existe
  const exists = state.accounts?.find(a => a.id === accountId);
  if (exists) return { accountId, exists: true };

  const newAccount = {
    _id: accountId,
    id: accountId,
    displayName: `Capitália Junior - ${juniorNombre}`,
    kind: 'CITIZEN',
    balancePz: 0,
    placetaId,
    type: 'Child',
    parentAccountId: tutorAccountId || 'u-alba',
    sendLimitPz,
    citizenshipTier: 'JuniorBasica',
    iban,
    huchaLocked: false,
    role: 'Citizen',
    complianceStatus: 'Clear',
    fundsJustificationApproved: true,
    investmentRiskLevel: 1,
    createdAt: new Date().toISOString()
  };

  state.accounts = [...(state.accounts || []), newAccount];

  const body = JSON.stringify(state);
  const headers = buildSignedTransaction('PUT', '/api/state', body);
  const r = await fetch(`${BRIDGE_URL}/api/state`, { method: 'PUT', headers, body });
  if (!r.ok) throw new Error(`Error creando cuenta infantil: ${r.status}`);

  return { accountId, iban, exists: false };
}

/**
 * Bono de bienvenida: AGLDP da 750 Pz al menor (sin IVA, es una donación)
 */
export async function bonoBienvenida({ juniorAccountId, juniorDip = '', tutorDip = '' }) {
  return sendTransaction({
    fromAccountId: 'AGLDP',
    toAccountId: juniorAccountId,
    amountPz: 750,
    ivaPz: 0,
    kind: 'Gift',
    concept: 'Bono Bienvenida Placeta Junior',
    note: 'Bono de bienvenida de 750 Pz para nuevos juniors',
    juniorDip, tutorDip
  });
}

/**
 * Desbloquear nivel — pago del junior a Capitalia
 * Capitalia paga el IVA a TGLP (el menor no paga impuestos)
 * Se usan 2 transacciones: junior→Capitalia + Capitalia→TGLP (IVA)
 */
export async function desbloquearNivelBanco({ juniorAccountId, costoPlacetas, juniorDip = '', tutorDip = '' }) {
  // 1. Junior paga a Capitalia (sin IVA)
  const pago = await sendTransaction({
    fromAccountId: juniorAccountId,
    toAccountId: BANCOS.CAPITALIA.accountId,
    amountPz: costoPlacetas,
    ivaPz: 0,
    kind: 'Transfer',
    concept: 'Desbloquear nivel academia',
    note: `Desbloqueo de nivel - ${costoPlacetas} Pz`,
    juniorDip, tutorDip
  });

  // 2. Capitalia paga IVA a TGLP (12% del costo, lo paga Capitalia no el menor)
  const iva = calcularIVA(costoPlacetas);
  if (iva > 0 && !pago.esDemo) {
    await sendTransaction({
      fromAccountId: BANCOS.CAPITALIA.accountId,
      toAccountId: BANCOS.TGLP.accountId,
      amountPz: iva,
      ivaPz: 0,
      kind: 'Tax',
      concept: 'IVA Academia Placeta Junior',
      note: `IVA del ${IVA_PERCENT}% sobre desbloqueo de ${costoPlacetas} Pz (pagado por Capitalia)`,
      juniorDip, tutorDip
    });
  }

  return pago;
}

/**
 * Compra en la tienda Placeta Junior
 */
export async function comprarProducto({ fromAccountId, toAccountId = BANCOS.CAPITALIA.accountId, amountPz, concepto }) {
  const iva = calcularIVA(amountPz);

  return sendTransaction({
    fromAccountId,
    toAccountId,
    amountPz,
    ivaPz: 0, // Junior no paga IVA
    kind: 'Transfer',
    concept: concepto,
    note: `Compra Placeta Junior - ${amountPz} Pz`
  });
}
