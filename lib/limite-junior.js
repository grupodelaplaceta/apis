/**
 * Límite Junior — 500 Pz/mes entre cuentas Junior y no-Junior.
 *
 * Regla (CNI-BANCO): una cuenta Junior no puede recibir ni enviar más de
 * 500 Pz al mes hacia/desde cuentas que NO sean Junior. Además, la contraparte
 * no-Junior solo puede ser un organismo/entidad de La Placeta o el cotitular
 * legal (tutor) del menor desde otra cuenta suya.
 *
 * Funciones puras y sin estado para poder testearlas sin MongoDB.
 */

export const LIMITE_MENSUAL_JUNIOR = 500;

/** ¿Es una cuenta Junior? `type: 'Child'` o `citizenshipTier` Junior*. */
export function esJunior(account) {
  if (!account) return false;
  return account.type === 'Child' || String(account.citizenshipTier || '').startsWith('Junior');
}

// Cuentas de organismos/entidades de La Placeta (no son cuentas de ciudadano).
const IDS_ORGANISMOS = new Set([
  'TGLP', 'AGLDP', 'CAPITALIA_BANK', 'FUND-BLP', 'FOUNDATION_RBU', 'RBU_FUNDACION'
]);

/** ¿Es un organismo o entidad de La Placeta (fuente/destino permitido)? */
export function esOrganismoOEntidad(account) {
  if (!account) return false;
  if (IDS_ORGANISMOS.has(account.id)) return true;
  const type = String(account.type || '');
  return type === 'State' || type === 'Business';
}

/** ¿La cuenta pertenece al cotitular legal (tutor) del menor? */
export function esCotitular(account, junior) {
  const cotitularDip = String(junior?.cotitularDip || '').trim().toUpperCase();
  if (!cotitularDip) return false;
  const titular = String(account?.placetaId || account?.titularDip || account?.dip || '').trim().toUpperCase();
  return titular === cotitularDip;
}

/** Contraparte no-Junior permitida: organismo/entidad o cotitular del menor. */
export function contrapartePermitida(account, junior) {
  return esOrganismoOEntidad(account) || esCotitular(account, junior);
}

/**
 * Suma mensual de movimientos Junior ↔ no-Junior (entradas + salidas) de una
 * cuenta Junior concreta. Ignora los movimientos entre dos cuentas Junior y
 * las partidas de impuesto (kind 'Tax'), que no son "transferencias".
 */
export function movimientosMensualesJunior(state, juniorId, mes) {
  const juniorIds = new Set((state?.accounts || []).filter(esJunior).map((a) => a.id));
  let total = 0;
  for (const t of state?.transactions || []) {
    if (t.status && String(t.status).toLowerCase() !== 'settled') continue;
    if (String(t.kind || '') === 'Tax') continue;
    const dia = String(t.createdAt || '').slice(0, 7);
    if (mes && dia !== mes) continue;
    const from = t.fromAccountId || '';
    const to = t.toAccountId || '';
    const importe = Number(t.amountPz || 0);
    if (!(importe > 0)) continue;
    const cruzaJuniorNoJunior =
      (from === juniorId && !juniorIds.has(to)) || (to === juniorId && !juniorIds.has(from));
    if (cruzaJuniorNoJunior) total += importe;
  }
  return total;
}

/**
 * Valida una transferencia cuando implica a una cuenta Junior y una no-Junior.
 * Devuelve `{ ok: true }` si procede, o `{ ok: false, error, ... }` si incumple
 * el whitelist de contraparte o el límite mensual de 500 Pz.
 */
export function validarTransferenciaJunior(state, from, to, cantidad, mes, limite = LIMITE_MENSUAL_JUNIOR, acumuladoExtra = 0) {
  const fromAcc = (state?.accounts || []).find((a) => a.id === from);
  const toAcc = (state?.accounts || []).find((a) => a.id === to);
  if (!fromAcc || !toAcc) return { ok: true }; // el llamador resuelve el 404
  const fromJunior = esJunior(fromAcc);
  const toJunior = esJunior(toAcc);
  if (fromJunior === toJunior) return { ok: true }; // Junior↔Junior o no-Junior↔no-Junior: exento

  const junior = fromJunior ? fromAcc : toAcc;
  const contraparte = fromJunior ? toAcc : fromAcc;

  if (!contrapartePermitida(contraparte, junior)) {
    return { ok: false, error: 'contraparte_no_permitida' };
  }

  // `acumuladoExtra` permite sumar los items previos de un lote para que un
  // lote no reparta el tope en varios movimientos pequeños.
  const acumulado = movimientosMensualesJunior(state, junior.id, mes) + (Number(acumuladoExtra) || 0);
  const solicitado = Number(cantidad) || 0;
  const tope = Number.isFinite(Number(limite)) && Number(limite) > 0 ? Number(limite) : LIMITE_MENSUAL_JUNIOR;
  if (acumulado + solicitado > tope) {
    return {
      ok: false,
      error: 'limite_mensual_junior_excedido',
      limite: tope,
      acumulado,
      solicitado
    };
  }
  return { ok: true, juniorId: junior.id };
}
