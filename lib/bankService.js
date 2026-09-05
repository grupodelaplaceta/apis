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
import { readBankState, writeBankState } from './bankCollections.js';
import { leerNumero } from './valores-bop.js';

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

// IVA estándar en el ecosistema. Fuente: CNIC-IVA del BOLP (CNI-BANCO Art. 4),
// leído en vivo con fallback local si el boletín no responde (nunca NaN).
const IVA_PERCENT_FALLBACK = 12;

/** Porcentaje de IVA vigente (CNIC-IVA del BOLP), con fallback 12 %. */
async function ivaPorcentajeActual() {
  const n = await leerNumero('CNIC-IVA', IVA_PERCENT_FALLBACK);
  return Number.isFinite(n) && n > 0 ? n : IVA_PERCENT_FALLBACK;
}

/**
 * Lee el estado actual del banco con la librería autoritativa
 * (misma base de datos de backend-banco; ya no depende del mongo-bridge
 * localhost:8787, que no existe en producción).
 */
async function getBankState() {
  return readBankState();
}

/**
 * Guarda el estado con lock + reconciliación servidor (saldos autoritativos).
 * Devuelve el estado ya reconciliado para no releerlo después.
 */
async function putBankState(state) {
  const result = await writeBankState(state, { includeState: true });
  return result.state;
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
  const ivaPercent = await ivaPorcentajeActual(); // CNIC-IVA del BOLP (Art. 4)

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

  // 5. IVA: Capitalia → TGLP (solo si NO es demo)
  if ((ivaPz || 0) > 0 && !esDemo) {
    const ivaTransaction = {
      id: `pj-iva-${esDemo ? 'demo-' : ''}${crypto.randomUUID()}`,
      kind: 'Tax',
      fromAccountId: BANCOS.CAPITALIA.accountId,
      toAccountId: BANCOS.TGLP.accountId,
      amountPz: ivaPz, ivaPz: 0, netAmount: ivaPz, taxAmount: 0,
      concept: `IVA Placeta Junior - ${concept || 'operación'}${suffix}`,
      note: `IVA del ${ivaPercent}% pagado por Capitalia${suffix}`,
      status: 'Settled',
      createdAt: new Date().toISOString(),
      IBAN_Origin: BANCOS.CAPITALIA.iban,
      originalTransactionId: transaction.id
    };
    state.transactions = [...(state.transactions || []), ivaTransaction];
  }

  // 6. Añadir transacción al estado. Los saldos los aplica el backend del banco
  // al reconciliar la transacción nueva, así evitamos sumar/restar dos veces.
  state.transactions = [...(state.transactions || []), transaction];

  // 7. Enviar estado actualizado y leer el saldo confirmado (reconciliado).
  const confirmed = esDemo ? state : await putBankState(state);
  const confirmedFrom = confirmed.accounts?.find(a => a.id === fromAccountId) || from;
  const confirmedTo = confirmed.accounts?.find(a => a.id === toAccountId) || to;

  return {
    success: true,
    transactionId: transaction.id,
    fromBalance: confirmedFrom.balancePz,
    toBalance: confirmedTo.balancePz,
    ivaPagado: esDemo ? 0 : (ivaPz || 0),
    ivaTransactionId: (ivaPz > 0 && !esDemo) ? state.transactions.find(t => t.originalTransactionId === transaction.id)?.id : null,
    esDemo
  };
}

/**
 * Calcula el IVA (CNIC-IVA del BOLP, CNI-BANCO Art. 4) para un importe.
 * Si el boletín no está disponible usa el fallback 12 %.
 */
export async function calcularIVA(amountPz, percent) {
  const pct = percent ?? await ivaPorcentajeActual();
  return Math.ceil(amountPz * pct / 100);
}

/**
 * Crea una cuenta bancaria infantil con IBAN APP (Capitalia)
 */
export async function crearCuentaInfantil({ juniorDip, juniorNombre, tutorAccountId, tutorDip = '', sendLimitPz }) {
  if (!String(juniorDip || '').trim() || !String(tutorDip || '').trim()) {
    throw new Error('El alta de una cuenta Junior requiere el DIP del menor y de su tutor legal');
  }
  const state = await getBankState();

  const accountId = `u-${juniorDip?.toLowerCase().replace(/-/g, '')}`;
  const placetaId = `JUNIOR-${juniorDip?.split('-')[1] || '0000'}`;
  // IBAN interoperable del Banco de La Placeta, compatible con crm-state.
  const seed = String(juniorDip).toUpperCase().replace(/[^A-Z0-9]/g, '') || '0000';
  let ibanAcc = 17;
  for (const ch of seed) ibanAcc = (ibanAcc * 31 + ch.charCodeAt(0)) % 1000;
  const ibanCtrl = ((ibanAcc * 97) + 13) % 100;
  const iban = `GDLP-AP${String(ibanCtrl).padStart(2, '0')}-${String(ibanAcc).padStart(3, '0')}`;

  // Verificar si ya existe
  const exists = state.accounts?.find(a => a.id === accountId);
  if (exists) {
    if (!String(exists.iban || '').toUpperCase().startsWith('GDLP-')) {
      exists.iban = iban;
      await putBankState(state);
    }
    return { accountId, iban: exists.iban || iban, exists: true };
  }

  // Límite diario de envío de la cuenta Junior básica: CNIC del BOLP
  // (CNIC-CUENTA-JUNIOR-BASICA-TRANSFERENCIA, CNI-BANCO Art. 1; fallback 50 Pz)
  // salvo que el alta indique otro explícitamente.
  const sendLimitFinal = Number.isFinite(Number(sendLimitPz)) && Number(sendLimitPz) > 0
    ? Number(sendLimitPz)
    : Math.round(await leerNumero('CNIC-CUENTA-JUNIOR-BASICA-TRANSFERENCIA', 50));

  const newAccount = {
    _id: accountId,
    id: accountId,
    displayName: `Capitália Junior - ${juniorNombre}`,
    kind: 'CITIZEN',
    balancePz: 0,
    placetaId,
    type: 'Child',
    parentAccountId: tutorAccountId || 'u-alba',
    // El menor conserva la titularidad; el tutor queda como cotitular
    // operativo hasta que cumple 16 años. Estos campos son parte del estado
    // común para que web, RSP y las apps no tengan que inferirlo localmente.
    titularDip: juniorDip,
    cotitular: tutorDip,
    cotitularDip: tutorDip,
    cotitularHastaEdad: 16,
    cotitularMotivo: 'tutela legal de cuenta Junior',
    sendLimitPz: sendLimitFinal,
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
 * Bono de bienvenida (sin IVA, es una donación). Cuantía normativa del
 * CNI-BANCO (Art. 2) leída en vivo del BOLP: bono de la cuenta Junior básica
 * (menores de 16), fallback 750 Pz si el boletín no está disponible.
 */
export async function bonoBienvenida({ juniorAccountId, juniorDip = '', tutorDip = '' }) {
  const amountPz = Math.round(await leerNumero('CNIC-BONO-BIENVENIDA-JUNIOR-BASICA', 750));
  return sendTransaction({
    fromAccountId: 'AGLDP',
    toAccountId: juniorAccountId,
    amountPz,
    ivaPz: 0,
    kind: 'Gift',
    concept: 'Bono Bienvenida Placeta Junior',
    note: `Bono de bienvenida de ${amountPz} Pz para nuevos juniors`,
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

  // 2. Capitalia paga IVA a TGLP (CNIC-IVA del BOLP; lo paga Capitalia, no el menor)
  const ivaPercent = await ivaPorcentajeActual();
  const iva = Math.ceil(costoPlacetas * ivaPercent / 100);
  if (iva > 0 && !pago.esDemo) {
    await sendTransaction({
      fromAccountId: BANCOS.CAPITALIA.accountId,
      toAccountId: BANCOS.TGLP.accountId,
      amountPz: iva,
      ivaPz: 0,
      kind: 'Tax',
      concept: 'IVA Academia Placeta Junior',
      note: `IVA del ${ivaPercent}% sobre desbloqueo de ${costoPlacetas} Pz (pagado por Capitalia)`,
      juniorDip, tutorDip
    });
  }

  return pago;
}

/**
 * Compra en la tienda Placeta Junior
 */
export async function comprarProducto({ fromAccountId, toAccountId = BANCOS.CAPITALIA.accountId, amountPz, concepto }) {
  // Los menores no pagan IVA: la compra viaja íntegra a Capitalia.
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
