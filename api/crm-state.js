import { json, readBody } from "../lib/http.js";
import { readBankState, writeBankState, upsertEntity } from "../lib/bankCollections.js";
import crypto from "crypto";

const CRM_KEY = process.env.CRM_READ_KEY || '';

function uuid() { return crypto.randomUUID(); }

function requireCrmKey(req, res) {
  const key = req.headers["x-crm-key"];
  if (!CRM_KEY || key !== CRM_KEY) {
    json(res, 401, { error: "invalid_crm_key" });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "X-CRM-Key, Content-Type"
      });
      return res.end();
    }

    // ── GET: Leer estado completo del banco ────────────────────────────
    if (req.method === "GET") {
      if (!requireCrmKey(req, res)) return;
      const state = await readBankState();
      if (!state.accounts?.length) return json(res, 404, { error: "state_not_found" });
      return json(res, 200, state);
    }

    // ── POST: Operaciones administrativas ──────────────────────────────
    if (req.method === "POST") {
      if (!requireCrmKey(req, res)) return;
      const body = JSON.parse(await readBody(req) || "{}");
      const { action, cantidad, dip, cuentaId, motivo, accountId, tipo, eip, placetaId, displayName } = body;
      const state = await readBankState();
      const now = new Date().toISOString();
      const adminName = (state.users || []).find(u => u.role === "admin")?.displayName || "CRM Admin";
      const logId = uuid();

      // ── Emitir Placetas ──────────────────────────────────────────────
      if (action === "emitir") {
        if (!cantidad || cantidad <= 0 || !dip) return json(res, 400, { error: "Se requiere cantidad positiva y DIP" });
        const destino = (state.users || []).find(u => u.dip?.toUpperCase() === dip.toUpperCase());
        if (!destino) return json(res, 404, { error: "DIP no encontrado" });
        const cd = (state.accounts || []).find(a => a.placetaId === destino.placetaId);
        if (!cd) return json(res, 404, { error: "El usuario no tiene cuenta" });
        const txId = uuid();
        await upsertEntity("bank_transactions", txId, {
          id: txId, fromAccountId: "TGLP", toAccountId: cd.id,
          amountPz: cantidad, kind: "Transfer", note: motivo || "Emisión administrativa",
          status: "Settled", createdAt: now, updatedAt: now
        });
        await upsertEntity("bank_audit_logs", logId, {
          id: logId, action: "emitir", admin: adminName, cantidad, dip: destino.dip,
          accountId: cd.id, motivo: motivo || "Emisión administrativa", createdAt: now
        });
        return json(res, 200, { message: `Emitidas ${cantidad} Pz a ${destino.displayName || dip}`, transactionId: txId, auditLogId: logId });
      }

      // ── Quemar Placetas ──────────────────────────────────────────────
      if (action === "quemar") {
        if (!cantidad || cantidad <= 0 || !cuentaId) return json(res, 400, { error: "Se requiere cantidad positiva y cuentaId" });
        const c = (state.accounts || []).find(a => a.id === cuentaId);
        if (!c) return json(res, 404, { error: "Cuenta no encontrada" });
        if ((c.balancePz || 0) < cantidad) return json(res, 400, { error: "Saldo insuficiente" });
        const txId = uuid();
        await upsertEntity("bank_transactions", txId, {
          id: txId, fromAccountId: cuentaId, toAccountId: "TGLP",
          amountPz: cantidad, kind: "Transfer", note: motivo || "Quema administrativa",
          status: "Settled", createdAt: now, updatedAt: now
        });
        await upsertEntity("bank_audit_logs", logId, {
          id: logId, action: "quemar", admin: adminName, cantidad,
          accountId: cuentaId, motivo: motivo || "Quema administrativa", createdAt: now
        });
        return json(res, 200, { message: `Quemadas ${cantidad} Pz de ${c.displayName || cuentaId}`, transactionId: txId, auditLogId: logId });
      }

      // ── Cambiar tipo de cuenta ───────────────────────────────────────
      if (action === "cambiar-tipo") {
        const targetId = accountId || cuentaId;
        if (!targetId || !tipo) return json(res, 400, { error: "Se requiere accountId y tipo" });
        const validTypes = ["Personal", "Business", "Savings", "Current", "Child", "Shared", "Joint"];
        if (!validTypes.includes(tipo)) return json(res, 400, { error: `Tipo inválido. Válidos: ${validTypes.join(", ")}` });
        const c = (state.accounts || []).find(a => a.id === targetId);
        if (!c) return json(res, 404, { error: "Cuenta no encontrada" });
        const tipoAnterior = c.type || "Unknown";
        await upsertEntity("bank_accounts", targetId, { ...c, type: tipo, updatedAt: now });
        await upsertEntity("bank_audit_logs", logId, {
          id: logId, action: "cambiar_tipo_cuenta", admin: adminName,
          accountId: targetId, tipoAnterior, tipoNuevo: tipo,
          motivo: motivo || "Corrección administrativa", createdAt: now
        });
        return json(res, 200, {
          message: `${c.displayName || targetId}: ${tipoAnterior} → ${tipo}`,
          auditLogId: logId, tipoAnterior, tipoNuevo: tipo
        });
      }

      // ── Asignar EIP ──────────────────────────────────────────────────
      if (action === "asignar-eip") {
        const targetId = accountId || cuentaId;
        let c = (state.accounts || []).find(a => a.id === targetId);
        if (!c && placetaId) c = (state.accounts || []).find(a => a.placetaId === placetaId);
        if (!c) return json(res, 404, { error: "Cuenta no encontrada" });
        const nuevoEip = eip || `EIP-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
        await upsertEntity("bank_accounts", c.id, { ...c, eip: nuevoEip, updatedAt: now });
        const user = (state.users || []).find(u => u.placetaId === c.placetaId);
        if (user) await upsertEntity("bank_users", user.dip || user.placetaId, { ...user, eip: nuevoEip, updatedAt: now });
        await upsertEntity("bank_audit_logs", logId, {
          id: logId, action: "asignar_eip", admin: adminName,
          accountId: c.id, placetaId: c.placetaId, eip: nuevoEip,
          motivo: motivo || "Asignación administrativa", createdAt: now
        });
        return json(res, 200, { message: `EIP ${nuevoEip} asignado a ${c.displayName || c.id}`, eip: nuevoEip, auditLogId: logId });
      }

      // ── Alta en Tributos ─────────────────────────────────────────────
      if (action === "alta-tributos") {
        const targetId = accountId || cuentaId;
        let c = (state.accounts || []).find(a => a.id === targetId);
        if (!c && placetaId) c = (state.accounts || []).find(a => a.placetaId === placetaId);
        if (!c) return json(res, 404, { error: "Cuenta no encontrada. Especifica accountId o placetaId" });
        const user = (state.users || []).find(u => u.placetaId === c.placetaId);
        if (!user) return json(res, 404, { error: "Usuario no encontrado para esta cuenta" });
        const nuevoEip = c.eip || (c.type === "Business" ? `EIP-${crypto.randomBytes(3).toString("hex").toUpperCase()}` : null);
        const accountUpdate = { ...c, tributosCensusDate: now, updatedAt: now };
        if (nuevoEip) accountUpdate.eip = nuevoEip;
        await upsertEntity("bank_accounts", c.id, accountUpdate);
        const userUpdate = { ...user, tributosCensusDate: now, updatedAt: now };
        if (nuevoEip) userUpdate.eip = nuevoEip;
        await upsertEntity("bank_users", user.dip || user.placetaId, userUpdate);
        await upsertEntity("bank_audit_logs", logId, {
          id: logId, action: "alta_tributos", admin: adminName,
          accountId: c.id, placetaId: c.placetaId, dip: user.dip, eip: nuevoEip,
          tipoSujeto: c.type === "Business" ? "Empresa" : "Personal",
          motivo: motivo || "Alta administrativa en Tributos", createdAt: now
        });
        return json(res, 200, {
          message: `${user.displayName || user.dip} dado de alta en Tributos${nuevoEip ? ` con EIP ${nuevoEip}` : ""}`,
          eip: nuevoEip, tributosCensusDate: now, auditLogId: logId
        });
      }

      // ── Crear cuenta infantil (Placeta Junior) ───────────────────────
      if (action === "crear-cuenta-infantil") {
        const { juniorDip, juniorNombre, tutorAccountId, sendLimitPz, tutorDip } = body;
        if (!juniorDip || !juniorNombre) return json(res, 400, { error: "Se requiere juniorDip y juniorNombre" });

        const accountId = `u-${juniorDip?.toLowerCase().replace(/-/g, '')}`;
        const placetaId = `JUNIOR-${juniorDip?.split('-')[1] || '0000'}`;

        // IBAN formato oficial app: GDLP-AP{control}-{body}
        const seed = juniorDip?.toUpperCase().replace(/[^A-Z0-9]/g, '') || '0000';
        let ibanAcc = 17;
        for (const ch of seed) ibanAcc = (ibanAcc * 31 + ch.charCodeAt(0)) % 1000;
        const ibanCtrl = ((ibanAcc * 97) + 13) % 100;
        const iban = `GDLP-AP${String(ibanCtrl).padStart(2, '0')}-${String(ibanAcc).padStart(3, '0')}`;

        // Verificar si ya existe
        const exists = (state.accounts || []).find(a => a.id === accountId);
        if (exists) return json(res, 200, { accountId, iban: exists.iban || iban, exists: true });

        const newAccount = {
          _id: accountId, id: accountId,
          displayName: `Placeta Junior - ${juniorNombre}`,
          kind: 'CITIZEN', balancePz: 0, placetaId,
          type: 'Child', parentAccountId: tutorAccountId || 'u-alba',
          sendLimitPz: sendLimitPz || 50,
          citizenshipTier: 'JuniorBasica', iban, huchaLocked: false,
          role: 'Citizen', complianceStatus: 'Clear',
          fundsJustificationApproved: true, investmentRiskLevel: 1,
          createdAt: now
        };

        state.accounts = [...(state.accounts || []), newAccount];
        await writeBankState(state);

        // Log
        await upsertEntity("bank_audit_logs", logId, {
          id: logId, action: "crear_cuenta_infantil", admin: adminName,
          accountId, placetaId, juniorDip, tutorAccountId, iban,
          tipo: "Child", createdAt: now
        });

        return json(res, 200, { accountId, iban, exists: false });
      }

      // ── Bono bienvenida Placeta Junior ──────────────────────────────
      if (action === "bono-bienvenida") {
        const { juniorAccountId, juniorDip: jDip, tutorDip: tDip } = body;
        if (!juniorAccountId) return json(res, 400, { error: "Se requiere juniorAccountId" });

        const from = (state.accounts || []).find(a => a.id === 'AGLDP');
        const to = (state.accounts || []).find(a => a.id === juniorAccountId);
        if (!from) return json(res, 404, { error: "Cuenta AGLDP no encontrada" });
        if (!to) return json(res, 404, { error: "Cuenta junior no encontrada" });

        const esDemo = tDip === '11111111D' || (jDip || '').includes('DEMO');
        const suffix = esDemo ? ' (Demo)' : '';
        const amountPz = 750;

        if (!esDemo && (from.balancePz || 0) < amountPz) {
          return json(res, 400, { error: "Saldo insuficiente en AGLDP" });
        }

        if (!esDemo) {
          from.balancePz -= amountPz;
          to.balancePz += amountPz;
        }

        const txId = uuid();
        state.transactions = [...(state.transactions || []), {
          id: txId, kind: 'Gift', fromAccountId: 'AGLDP', toAccountId: juniorAccountId,
          amountPz, ivaPz: 0, netAmount: amountPz,
          concept: `Bono Bienvenida Placeta Junior${suffix}`,
          status: 'Settled', createdAt: now
        }];

        await writeBankState(state);

        return json(res, 200, {
          success: true, transactionId: txId,
          fromBalance: from.balancePz, toBalance: to.balancePz, esDemo
        });
      }

      // ── Transferencia real entre cuentas (compras Junior → Capitalia, regalías admin → titular) ──
      // Body: { action: "transferir", from, to, cantidad, concepto, iva?, juniorDip?, tutorDip? }
      // - Descuenta `cantidad` de la cuenta origen y abona en destino
      // - Si iva > 0: Capitalia paga el IVA a TGLP (solo en modo no-demo)
      // - Deja historial completo en bank_transactions (transacciones reales)
      // - Modo demo (tutor 11111111D / DIP con DEMO): transacción registrada sin mover saldos
      if (action === "transferir") {
        const { from, to, cantidad: amount, concepto, iva, juniorDip, tutorDip } = body;
        if (!from || !to || !amount || amount <= 0) {
          return json(res, 400, { error: "Se requiere from, to y cantidad positiva" });
        }
        const fromAcc = (state.accounts || []).find(a => a.id === from);
        const toAcc = (state.accounts || []).find(a => a.id === to);
        if (!fromAcc) return json(res, 404, { error: `Cuenta origen ${from} no encontrada` });
        if (!toAcc) return json(res, 404, { error: `Cuenta destino ${to} no encontrada` });

        const esDemo = tutorDip === '11111111D' || (juniorDip || '').includes('DEMO') || (from || '').includes('DEMO') || (to || '').includes('DEMO');
        const ivaPz = Number(iva) || 0;
        const totalDebit = amount + ivaPz;
        const suffix = esDemo ? ' (Demo)' : '';

        if (!esDemo && (fromAcc.balancePz || 0) < totalDebit) {
          return json(res, 400, {
            error: `Saldo insuficiente en ${from}: tiene ${fromAcc.balancePz}, necesita ${totalDebit}`,
            fromBalance: fromAcc.balancePz, required: totalDebit
          });
        }

        if (!esDemo) {
          fromAcc.balancePz -= totalDebit;
          toAcc.balancePz += amount;
        }

        const txId = uuid();
        state.transactions = [...(state.transactions || []), {
          id: txId, kind: 'Transfer', fromAccountId: from, toAccountId: to,
          amountPz: amount, ivaPz, netAmount: amount, taxAmount: ivaPz,
          concept: `${concepto || 'Transferencia'}${suffix}`, status: 'Settled', createdAt: now,
          IBAN_Origin: fromAcc.iban || '', originalTransactionId: null
        }];
        await upsertEntity("bank_transactions", txId, {
          id: txId, kind: 'Transfer', fromAccountId: from, toAccountId: to,
          amountPz: amount, ivaPz, netAmount: amount, taxAmount: ivaPz,
          concept: `${concepto || 'Transferencia'}${suffix}`, status: 'Settled', createdAt: now,
          IBAN_Origin: fromAcc.iban || '', originalTransactionId: null
        });

        // IVA: destino (Capitalia) paga el IVA a TGLP
        if (ivaPz > 0 && !esDemo) {
          const tglp = (state.accounts || []).find(a => a.id === 'TGLP');
          if (tglp) {
            const toAccFull = state.accounts.find(a => a.id === to);
            if (toAccFull) toAccFull.balancePz -= ivaPz;
            tglp.balancePz += ivaPz;
          }
        }

        await writeBankState(state);

        return json(res, 200, {
          success: true, transactionId: txId, esDemo,
          fromBalance: fromAcc.balancePz, toBalance: toAcc.balancePz,
          ivaPz, netAmount: amount
        });
      }

      // ── Regalías: admin paga desde su cuenta a un titular/creador ──
      // Body: { action: "pagar-regalia", from (cuenta admin), to (cuenta titular), cantidad, concepto }
      if (action === "pagar-regalia") {
        const { from, to, cantidad: amount, concepto } = body;
        if (!from || !to || !amount || amount <= 0) {
          return json(res, 400, { error: "Se requiere from (cuenta admin), to (cuenta titular) y cantidad positiva" });
        }
        const fromAcc = (state.accounts || []).find(a => a.id === from);
        const toAcc = (state.accounts || []).find(a => a.id === to);
        if (!fromAcc) return json(res, 404, { error: `Cuenta admin ${from} no encontrada` });
        if (!toAcc) return json(res, 404, { error: `Cuenta titular ${to} no encontrada` });
        if ((fromAcc.balancePz || 0) < amount) {
          return json(res, 400, { error: `Saldo insuficiente en cuenta admin ${from}: tiene ${fromAcc.balancePz}` });
        }

        fromAcc.balancePz -= amount;
        toAcc.balancePz += amount;

        const txId = uuid();
        const tx = {
          id: txId, kind: 'Royalty', fromAccountId: from, toAccountId: to,
          amountPz: amount, ivaPz: 0, netAmount: amount, taxAmount: 0,
          concept: concepto || 'Regalía Placeta Junior', status: 'Settled', createdAt: now,
          IBAN_Origin: fromAcc.iban || '', originalTransactionId: null
        };
        state.transactions = [...(state.transactions || []), tx];
        await upsertEntity("bank_transactions", txId, tx);

        await writeBankState(state);

        return json(res, 200, {
          success: true, transactionId: txId,
          fromBalance: fromAcc.balancePz, toBalance: toAcc.balancePz
        });
      }

      return json(res, 400, { error: 'Action debe ser emitir, quemar, cambiar-tipo, asignar-eip, alta-tributos, crear-cuenta-infantil, bono-bienvenida, transferir o pagar-regalia' });
    }

    return json(res, 405, { error: "method_not_allowed" });
  } catch (error) {
    return json(res, 500, { error: error.message || "internal_error" });
  }
}
