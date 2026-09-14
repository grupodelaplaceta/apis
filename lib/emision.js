/**
 * Emisión / quema de PLACETAS (oferta monetaria).
 *
 * La creación o destrucción de PLACETAS es la operación más sensible del
 * ecosistema: solo puede ejecutarla un administrador del RSP y NUNCA debe ser
 * posible "por código" ni a través de una API abierta. Por eso usa una clave
 * dedicada (BANK_EMISSION_KEY), separada de la clave CRM compartida
 * (CRM_READ_KEY) que mueve transferencias normales y flujos Junior.
 *
 * Fail-closed: si la clave no está configurada, la emisión queda deshabilitada.
 */
import crypto from "crypto";

const EMISSION_KEY = process.env.BANK_EMISSION_KEY || "";

/** Indica si la clave de emisión está configurada (sin ella, emisión bloqueada). */
export function emissionKeyConfigurada() {
  return EMISSION_KEY.length > 0;
}

/**
 * Compara el valor recibido en la cabecera `x-emission-key` contra la clave
 * configurada usando comparación en tiempo constante (evita timing attacks).
 * @param {string} headerValue valor de la cabecera `x-emission-key`
 * @param {string} configurada clave esperada (por defecto BANK_EMISSION_KEY)
 * @returns {boolean}
 */
export function autorizarEmision(headerValue, configurada = EMISSION_KEY) {
  const a = Buffer.from(String(headerValue || ""));
  const b = Buffer.from(String(configurada || ""));
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
