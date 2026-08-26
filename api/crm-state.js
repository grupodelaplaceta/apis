import { json, readBody } from "../lib/http.js";
import { readBankState, writeBankState, upsertEntity, deleteEntity, readTreasuryConfig, writeTreasuryConfig } from "../lib/bankCollections.js";
import crypto from "crypto";

const CRM_KEY = process.env.CRM_READ_KEY || '';

function uuid() { return crypto.randomUUID(); }

async function writeAndReadState(state) {
  await writeBankState(state);
  return readBankState();
}

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
      const { action, cantidad, dip, cuentaId, motivo, accountId, tipo, eip, placetaId, displayName, borrarTransacciones } = body;
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

      // ── Crear usuario bancario (alta de bank_user desde una cuenta) ──
      // Crea el bank_users para un titular con cuenta pero sin usuario,
      // de modo que pueda ser censado en Tributos (alta-tributos) y login.
      // Normaliza el placetaId (permite cuentas con placetaId sin prefijo PLID-).
      if (action === "crear-usuario") {
        const targetId = accountId || cuentaId;
        let c = (state.accounts || []).find(a => a.id === targetId);
        if (!c && placetaId) c = (state.accounts || []).find(a => a.placetaId === placetaId || a.dip === placetaId);
        if (!c && dip) c = (state.accounts || []).find(a => a.placetaId === dip || a.dip === dip);
        if (!c) return json(res, 404, { error: "Cuenta no encontrada. Especifica accountId, placetaId o dip" });
        const dipFinal = String(c.dip || c.placetaId || dip || "").trim().toUpperCase();
        if (!dipFinal) return json(res, 400, { error: "La cuenta no tiene placetaId ni dip" });
        if (!/^(\d{8}[A-Z]|[XYZ]\d{7,8}[A-Z])$/.test(dipFinal)) {
          return json(res, 400, { error: `DIP inválido para alta de usuario: ${dipFinal} (debe ser DNI/NIE)` });
        }
        const placetaFinal = String(c.placetaId || dipFinal);
        const existente = (state.users || []).find(u => u.placetaId === placetaFinal || u.dip === dipFinal);
        const usuario = existente
          ? { ...existente, dip: dipFinal, placetaId: placetaFinal } // normaliza si había mismatch (p.ej. PLID-... vs DNI)
          : {
              // Convención bank_users: _id en Mongo = DIP (clave de upsert). Sin campos id/_id propios.
              dip: dipFinal,
              placetaId: placetaFinal,
              displayName: c.displayName || c.nombre || c.titularNombre || dipFinal,
              role: "member",
              eip: c.eip || null,
              verified: true,
              createdAt: now,
            };
        await upsertEntity("bank_users", usuario.dip || usuario.placetaId, { ...usuario, updatedAt: now });
        await upsertEntity("bank_audit_logs", logId, {
          id: logId, action: "crear_usuario", admin: adminName,
          accountId: c.id, placetaId: placetaFinal, dip: dipFinal,
          motivo: motivo || "Alta administrativa de usuario bancario", createdAt: now
        });
        return json(res, 200, {
          success: true,
          message: `${usuario.displayName || dipFinal} dado de alta como usuario bancario${existente ? " (ya existía)" : ""}`,
          usuario: { dip: dipFinal, placetaId: placetaFinal, displayName: usuario.displayName, eip: usuario.eip },
          auditLogId: logId
        });
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
        if (!juniorDip || !juniorNombre || !tutorDip) return json(res, 400, { error: "Se requiere juniorDip, juniorNombre y tutorDip legal" });

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
          titularDip: juniorDip, cotitular: tutorDip || '', cotitularDip: tutorDip || '',
          cotitularHastaEdad: 16, cotitularMotivo: 'tutela legal de cuenta Junior',
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

        const txId = uuid();
        state.transactions = [...(state.transactions || []), {
          id: txId, kind: 'Gift', fromAccountId: 'AGLDP', toAccountId: juniorAccountId,
          amountPz, ivaPz: 0, netAmount: amountPz,
          concept: `Bono Bienvenida Placeta Junior${suffix}`,
          status: 'Settled', createdAt: now
        }];

        const confirmed = esDemo ? state : await writeAndReadState(state);
        const confirmedFrom = (confirmed.accounts || []).find(a => a.id === 'AGLDP') || from;
        const confirmedTo = (confirmed.accounts || []).find(a => a.id === juniorAccountId) || to;

        return json(res, 200, {
          success: true, transactionId: txId,
          fromBalance: confirmedFrom.balancePz, toBalance: confirmedTo.balancePz, esDemo
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
        const totalDebit = Number(amount);
        const suffix = esDemo ? ' (Demo)' : '';

        // Límite de envío de las cuentas Child (Placeta Junior): los menores
        // solo pueden mover su cuenta según el límite que tienen asignado.
        if (!esDemo && fromAcc.type === 'Child') {
          const sendLimitPz = Number(fromAcc.sendLimitPz);
          if (Number.isFinite(sendLimitPz) && sendLimitPz > 0 && totalDebit > sendLimitPz) {
            return json(res, 403, {
              error: `La cuenta infantil tiene un límite de envío de ${sendLimitPz} Pz (intento: ${totalDebit} Pz). Necesita autorización del tutor.`,
              sendLimitPz, required: totalDebit, necesita_autorizacion_tutor: true
            });
          }
        }

        if (!esDemo && (fromAcc.balancePz || 0) < totalDebit) {
          return json(res, 400, {
            error: `Saldo insuficiente en ${from}: tiene ${fromAcc.balancePz}, necesita ${totalDebit}`,
            fromBalance: fromAcc.balancePz, required: totalDebit
          });
        }

        const txId = uuid();
        const tx = {
          id: txId, kind: 'Transfer', fromAccountId: from, toAccountId: to,
          amountPz: Number(amount), ivaPz: ivaPz, netAmount: Number(amount), taxAmount: ivaPz,
          concept: `${concepto || 'Transferencia'}${suffix}`, status: 'Settled', createdAt: now,
          IBAN_Origin: fromAcc.iban || '', originalTransactionId: null
        };
        const newTransactions = [tx];

        // IVA: destino (Capitalia) paga el IVA a TGLP
        if (ivaPz > 0 && !esDemo) {
          newTransactions.push({
            id: uuid(), kind: 'Tax', fromAccountId: to, toAccountId: 'TGLP',
            amountPz: ivaPz, ivaPz: 0, netAmount: ivaPz, taxAmount: 0,
            concept: `IVA · ${concepto || 'Transferencia'}${suffix}`, status: 'Settled', createdAt: now,
            IBAN_Origin: toAcc.iban || '', originalTransactionId: txId
          });
        }

        state.transactions = [...(state.transactions || []), ...newTransactions];
        const confirmed = esDemo ? state : await writeAndReadState(state);
        const confirmedFrom = (confirmed.accounts || []).find(a => a.id === from) || fromAcc;
        const confirmedTo = (confirmed.accounts || []).find(a => a.id === to) || toAcc;

        return json(res, 200, {
          success: true, transactionId: txId, esDemo,
          fromBalance: confirmedFrom.balancePz, toBalance: confirmedTo.balancePz,
          ivaPz, netAmount: amount
        });
      }

      // ── Transferencias MASIVAS (lote) ──────────────────────────────────
      // Body: { action: "transferir-masivo", transferencias: [{ from, to, cantidad, concepto, iva?, juniorDip?, tutorDip? }] }
      // Procesa todo el lote con UNA sola lectura y UNA sola escritura del
      // estado del banco. Evita que cada transferencia haga una lectura +
      // escritura completa del estado (el banco tarda mucho cuando se guardan
      // muchas transferencias a la vez). Devuelve un resultado por item.
      if (action === "transferir-masivo") {
        const lista = Array.isArray(body.transferencias) ? body.transferencias : [];
        if (!lista.length) return json(res, 400, { error: "Se requiere transferencias[] con al menos una transferencia" });
        if (lista.length > 500) return json(res, 400, { error: "Máximo 500 transferencias por lote" });

        const resultados = [];
        const nuevasTx = [];
        const accountMap = new Map((state.accounts || []).map(a => [a.id, a]));

        for (const item of lista) {
          const { from, to, cantidad: amount, concepto, iva, juniorDip, tutorDip } = item || {};
          if (!from || !to || !amount || Number(amount) <= 0) {
            resultados.push({ from, to, cantidad: amount, success: false, error: "from, to y cantidad positiva requeridos" });
            continue;
          }
          const fromAcc = accountMap.get(from);
          const toAcc = accountMap.get(to);
          if (!fromAcc) { resultados.push({ from, to, cantidad: amount, success: false, error: `Cuenta origen ${from} no encontrada` }); continue; }
          if (!toAcc) { resultados.push({ from, to, cantidad: amount, success: false, error: `Cuenta destino ${to} no encontrada` }); continue; }

          const esDemo = tutorDip === '11111111D' || (juniorDip || '').includes('DEMO') || (from || '').includes('DEMO') || (to || '').includes('DEMO');
          const ivaPz = Number(iva) || 0;
          const totalDebit = Number(amount);
          const suffix = esDemo ? ' (Demo)' : '';

          if (!esDemo && (fromAcc.balancePz || 0) < totalDebit) {
            resultados.push({ from, to, cantidad: amount, success: false, error: `Saldo insuficiente en ${from}: tiene ${fromAcc.balancePz}, necesita ${totalDebit}` });
            continue;
          }

          const txId = uuid();
          const tx = {
            id: txId, kind: 'Transfer', fromAccountId: from, toAccountId: to,
            amountPz: Number(amount), ivaPz: ivaPz, netAmount: Number(amount), taxAmount: ivaPz,
            concept: `${concepto || 'Transferencia'}${suffix}`, status: 'Settled', createdAt: now,
            IBAN_Origin: fromAcc.iban || '', originalTransactionId: null
          };
          nuevasTx.push(tx);
          if (ivaPz > 0 && !esDemo) {
            nuevasTx.push({
              id: uuid(), kind: 'Tax', fromAccountId: to, toAccountId: 'TGLP',
              amountPz: ivaPz, ivaPz: 0, netAmount: ivaPz, taxAmount: 0,
              concept: `IVA · ${concepto || 'Transferencia'}${suffix}`, status: 'Settled', createdAt: now,
              IBAN_Origin: toAcc.iban || '', originalTransactionId: txId
            });
          }
          resultados.push({ from, to, cantidad: amount, concepto: concepto || null, iva: ivaPz, transactionId: txId, success: true, esDemo });
        }

        if (nuevasTx.length) {
          state.transactions = [...(state.transactions || []), ...nuevasTx];
          // UNA única escritura del estado para todo el lote
          await writeBankState(state);
        }

        const ok = resultados.filter(r => r.success).length;
        return json(res, 200, {
          success: ok > 0,
          total: lista.length, ok, errores: resultados.length - ok,
          resultados
        });
      }

      // ── Regalías: admin paga desde su cuenta a un titular/creador ──
      // Body: { action: "pagar-regalia", from (cuenta admin), to (cuenta titular), cantidad, concepto, kind? }
      // Art. 6 CNI: se puede pasar kind "PLJUNIOR_PAYMENT" para los pagos de
      // recompensas y juegos de Capitalia en nombre de PLACETA JUNIOR (categoría
      // propia, sujeta a IVA/IRM/IGF, no incluye RBU extraordinarios).
      if (action === "pagar-regalia") {
        const { from, to, cantidad: amount, concepto, kind } = body;
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

        const finalKind = kind === "PLJUNIOR_PAYMENT" ? "PLJUNIOR_PAYMENT" : "Royalty";
        const txId = uuid();
        const tx = {
          id: txId, kind: finalKind, fromAccountId: from, toAccountId: to,
          amountPz: amount, ivaPz: 0, netAmount: amount, taxAmount: 0,
          concept: concepto || 'Regalía Placeta Junior', status: 'Settled', createdAt: now,
          IBAN_Origin: fromAcc.iban || '', originalTransactionId: null
        };
        state.transactions = [...(state.transactions || []), tx];
        const confirmed = await writeAndReadState(state);
        const confirmedFrom = (confirmed.accounts || []).find(a => a.id === from) || fromAcc;
        const confirmedTo = (confirmed.accounts || []).find(a => a.id === to) || toAcc;

        return json(res, 200, {
          success: true, transactionId: txId,
          fromBalance: confirmedFrom.balancePz, toBalance: confirmedTo.balancePz
        });
      }

      // ── Asegurar Fondo de Apoyo (FUND-BLP) ───────────────────────────
      // Body: { action: "crear-fondo-apoyo", importeInicial? } (idempotente)
      // Cuenta de tesorería que financia las retribuciones de 250 Pz/mes de
      // propietarios sin remuneración (Fiscalidad Ampliada / RSP).
      if (action === "crear-fondo-apoyo") {
        const importeInicial = Number(body.importeInicial) || 0;
        let fondo = (state.accounts || []).find(a => a.id === "FUND-BLP" || a.kind === "FONDO_APOYO");
        if (!fondo) {
          const fondoId = "FUND-BLP";
          fondo = {
            _id: fondoId, id: fondoId, kind: "FONDO_APOYO", role: "Tributos",
            displayName: "Fondo de Apoyo a la Participación Económica y Social (Fundación)",
            type: "State", balancePz: importeInicial, iban: "GDLP-AP71-601",
            placetaId: "FUND-BLP", createdAt: now, updatedAt: now
          };
          state.accounts = [...(state.accounts || []), fondo];
        } else if (importeInicial > 0 && !(fondo.balancePz > 0)) {
          fondo = { ...fondo, balancePz: (fondo.balancePz || 0) + importeInicial, updatedAt: now };
          state.accounts = (state.accounts || []).map(a => a.id === fondo.id ? fondo : a);
        }
        await writeBankState(state);
        await upsertEntity("bank_audit_logs", logId, {
          id: logId, action: "crear_fondo_apoyo", admin: adminName,
          importeInicial, saldo: fondo.balancePz, motivo: motivo || "Alta del Fondo de Apoyo (RSP)", createdAt: now
        });
        return json(res, 200, { success: true, message: "Fondo de Apoyo (FUND-BLP) asegurado", accountId: "FUND-BLP", balancePz: fondo.balancePz });
      }

      // ── Retribuir: pago de retribución 250 Pz desde el Fondo de Apoyo ──
      // Body: { action: "retribuir", dip (beneficiario), retribucionId (RET-...),
      //         cuantia, mes (YYYY-MM), entidadEip, entidadNombre, concepto? }
      // Flujo real: FUND-BLP → cuenta del beneficiario, kind 'Retribucion',
      // con referencia a la retribución RSP y auditoría. Sin IVA (no es venta).
      if (action === "retribuir") {
        const { dip, retribucionId, cuantia, mes, entidadEip, entidadNombre, concepto } = body;
        const importe = Number(cuantia) || 0;
        if (!dip) return json(res, 400, { error: "Se requiere el DIP del beneficiario" });
        if (importe <= 0) return json(res, 400, { error: "Se requiere una cuantía positiva" });

        const destino = (state.users || []).find(u => u.dip?.toUpperCase() === String(dip).toUpperCase());
        if (!destino) return json(res, 404, { error: "Beneficiario (DIP) no encontrado" });
        const cd = (state.accounts || []).find(a => a.placetaId === destino.placetaId) ||
                   (state.accounts || []).find(a => a.id === `u-${String(dip).toLowerCase().replace(/[^a-z0-9]/g, '')}`) ||
                   (state.accounts || []).find(a => a.type !== "State" && a.placetaId === destino.placetaId);

        let fondo = (state.accounts || []).find(a => a.id === "FUND-BLP" || a.kind === "FONDO_APOYO");
        if (!fondo) {
          const fondoId = "FUND-BLP";
          fondo = { _id: fondoId, id: fondoId, kind: "FONDO_APOYO", role: "Tributos", displayName: "Fondo de Apoyo a la Participación Económica y Social (Fundación)", type: "State", balancePz: 0, iban: "GDLP-AP71-601", placetaId: "FUND-BLP", createdAt: now, updatedAt: now };
          state.accounts = [...(state.accounts || []), fondo];
        }
        if (!cd) return json(res, 404, { error: "El beneficiario no tiene cuenta bancaria" });

        const esDemo = String(dip).includes("DEMO") || cd.id.includes("DEMO");
        const suffix = esDemo ? " (Demo)" : "";

        if (!esDemo && (fondo.balancePz || 0) < importe) {
          return json(res, 400, { error: `Saldo insuficiente en el Fondo de Apoyo: tiene ${fondo.balancePz} Pz, necesita ${importe} Pz` });
        }

        const txId = uuid();
        const conceptoTx = `Retribución ${mes || ''} · ${retribucionId || 'RET'} · ${entidadNombre || entidadEip || ''}`.trim() + suffix;
        const tx = {
          id: txId, kind: "Retribucion", fromAccountId: "FUND-BLP", toAccountId: cd.id,
          amountPz: importe, ivaPz: 0, netAmount: importe, taxAmount: 0,
          concept: conceptoTx, note: `Retribución propietario sin remuneración (Fiscalidad Ampliada). Ref RSP: ${retribucionId || '-'}`,
          status: "Settled", createdAt: now, updatedAt: now,
          IBAN_Origin: fondo.iban || "", originalTransactionId: null,
          retribucionId: retribucionId || null, mes: mes || null, dip: destino.dip
        };
        state.transactions = [...(state.transactions || []), tx];
        const confirmed = esDemo ? state : await writeAndReadState(state);
        const confirmedFondo = (confirmed.accounts || []).find(a => a.id === "FUND-BLP") || fondo;
        const confirmedTo = (confirmed.accounts || []).find(a => a.id === cd.id) || cd;

        await upsertEntity("bank_audit_logs", logId, {
          id: logId, action: "retribuir", admin: adminName,
          dip: destino.dip, placetaId: cd.placetaId, retribucionId: retribucionId || null,
          cuantia: importe, mes: mes || null, entidadEip: entidadEip || null,
          fromAccountId: "FUND-BLP", toAccountId: cd.id, transactionId: txId,
          motivo: concepto || "Retribución propietario sin remuneración", createdAt: now
        });

        return json(res, 200, {
          success: true, transactionId: txId, esDemo,
          message: `Retribución de ${importe} Pz pagada a ${destino.displayName || destino.dip} desde el Fondo de Apoyo`,
          fromBalance: confirmedFondo.balancePz, toBalance: confirmedTo.balancePz
        });
      }

      // ── Revertir transferencia (desde el RSP / Supervisión) ──────────
      // Body: { action: "revertir-transferencia", transactionId, motivo }
      // Invierte una transferencia ya liquidada: devuelve el principal del
      // destino al origen y revierte el IVA (TGLP → destino) si procede.
      // Deja constancia en bank_transactions + auditoría. Sin doble reversión.
      if (action === "revertir-transferencia") {
        const { transactionId, motivo } = body;
        if (!transactionId) return json(res, 400, { error: "Se requiere transactionId" });

        const tx = (state.transactions || []).find(t => t.id === transactionId);
        if (!tx) return json(res, 404, { error: "Transacción no encontrada" });
        if (tx.status === "Reversed") return json(res, 400, { error: "La transacción ya fue revertida" });
        if (tx.kind !== "Transfer") return json(res, 400, { error: "Solo se pueden revertir transferencias" });
        if (String(tx.concept || "").includes("(Demo)")) return json(res, 400, { error: "Las transacciones de demostración no se revierten" });

        const yaRevertida = (state.transactions || []).some(t =>
          t.kind === "Reversal" && t.originalTransactionId === transactionId && t.status === "Settled"
        );
        if (yaRevertida) return json(res, 400, { error: "La transacción ya fue revertida" });

        const fromAcc = (state.accounts || []).find(a => a.id === tx.fromAccountId);
        const toAcc = (state.accounts || []).find(a => a.id === tx.toAccountId);
        if (!fromAcc || !toAcc) return json(res, 404, { error: "Cuenta origen o destino no encontrada" });
        if ((toAcc.balancePz || 0) < tx.amountPz) {
          return json(res, 400, { error: `El destino ${toAcc.displayName || tx.toAccountId} no tiene saldo suficiente (${toAcc.balancePz || 0} Pz) para revertir ${tx.amountPz} Pz` });
        }

        const reversals = [];
        const revId = uuid();
        reversals.push({
          id: revId, kind: "Reversal",
          fromAccountId: tx.toAccountId, toAccountId: tx.fromAccountId,
          amountPz: tx.amountPz, ivaPz: 0, netAmount: tx.amountPz, taxAmount: 0,
          concept: `REVERSIÓN · ${tx.concept || tx.id}`,
          note: `Reversión de ${tx.id}${motivo ? ` · ${motivo}` : ""}`,
          status: "Settled", createdAt: now, updatedAt: now,
          IBAN_Origin: toAcc.iban || "", originalTransactionId: transactionId
        });

        const ivaPz = Number(tx.ivaPz || tx.taxAmount || 0);
        if (ivaPz > 0) {
          const tglp = (state.accounts || []).find(a => a.id === "TGLP");
          if (tglp && (tglp.balancePz || 0) >= ivaPz) {
            reversals.push({
              id: uuid(), kind: "Reversal",
              fromAccountId: "TGLP", toAccountId: tx.toAccountId,
              amountPz: ivaPz, ivaPz: 0, netAmount: ivaPz, taxAmount: 0,
              concept: `REVERSIÓN IVA · ${tx.id}`,
              note: `Reversión del IVA de ${tx.id}`,
              status: "Settled", createdAt: now, updatedAt: now,
              IBAN_Origin: tglp.iban || "", originalTransactionId: transactionId
            });
          }
        }

        state.transactions = [
          ...(state.transactions || []).map(t => t.id === transactionId ? { ...t, status: "Reversed", updatedAt: now } : t),
          ...reversals
        ];
        for (const rev of reversals) await upsertEntity("bank_transactions", rev.id, rev);
        await upsertEntity("bank_transactions", transactionId, { ...tx, status: "Reversed", updatedAt: now });
        await writeBankState(state);

        await upsertEntity("bank_audit_logs", logId, {
          id: logId, action: "revertir_transferencia", admin: adminName,
          transactionId, motivo: motivo || "Reversión administrativa",
          amountPz: tx.amountPz, fromAccountId: tx.fromAccountId, toAccountId: tx.toAccountId,
          reversalIds: reversals.map(r => r.id), createdAt: now
        });

        return json(res, 200, {
          success: true,
          message: `Transferencia ${tx.id} revertida (${reversals.length} movimiento${reversals.length === 1 ? "" : "s"})`,
          transactionId, reversalIds: reversals.map(r => r.id)
        });
      }

      // ── Guardar configuración variable del banco (RSP / Supervisión) ──
      // Body: { action: "guardar-config", config: { rbuAmountPz, comisiones, límites, ... } }
      // Se FUSIONA con la configuración existente para no pisar campos que la app usa.
      if (action === "guardar-config") {
        const { config, motivo } = body;
        if (!config || typeof config !== "object") return json(res, 400, { error: "Se requiere config" });
        const actual = (await readTreasuryConfig()) || {};
        const actualSinId = { ...actual };
        delete actualSinId._id;
        const nuevo = { ...actualSinId, ...config };
        await writeTreasuryConfig(nuevo);
        await upsertEntity("bank_audit_logs", logId, {
          id: logId, action: "guardar_config", admin: adminName,
          config: { ...config }, motivo: motivo || "Actualización desde RSP", createdAt: now
        });
        return json(res, 200, { success: true, message: "Configuración guardada", config: nuevo });
      }

      // ── Responder un ticket de soporte (desde el RSP) ────────────────
      // Body: { action: "responder-soporte", ticketId, respuesta, admin? }
      if (action === "responder-soporte") {
        const { ticketId, respuesta, admin } = body;
        if (!ticketId || !respuesta) return json(res, 400, { error: "Se requiere ticketId y respuesta" });
        const ticket = (state.supportTickets || []).find(t => t.id === ticketId);
        if (!ticket) return json(res, 404, { error: "Ticket no encontrado" });
        const responses = Array.isArray(ticket.responses) ? ticket.responses : [];
        responses.push({
          adminDip: admin || adminName,
          text: String(respuesta).trim(),
          createdAt: now
        });
        const updated = {
          ...ticket,
          responses,
          status: ticket.status === "Abierto" ? "Respondido" : ticket.status,
          updatedAt: now
        };
        state.supportTickets = (state.supportTickets || []).map(t => t.id === ticketId ? updated : t);
        await upsertEntity("bank_support_tickets", ticketId, { ...ticket, ...updated, id: ticketId });
        await writeBankState(state);
        await upsertEntity("bank_audit_logs", logId, {
          id: logId, action: "responder_soporte", admin: adminName,
          ticketId, ticketSubject: ticket.subject, dip: ticket.dip,
          createdAt: now
        });
        return json(res, 200, { success: true, message: "Respuesta registrada en el ticket", ticket: updated });
      }

      // ── Borrar cuenta (demo/junior inválidos) ─────────────────────────
      // Body: { action: "borrar-cuenta", accountId, motivo, borrarTransacciones?: true }
      if (action === "borrar-cuenta") {
        const targetId = accountId || cuentaId;
        if (!targetId) return json(res, 400, { error: "Se requiere accountId" });
        const c = (state.accounts || []).find(a => a.id === targetId);
        if (!c) return json(res, 404, { error: "Cuenta no encontrada" });

        // Borrar la cuenta
        await deleteEntity("bank_accounts", targetId);

        // Borrar transacciones asociadas si se solicita (o si saldo es 0 y es demo)
        const borrarTx = borrarTransacciones === true;
        if (borrarTx) {
          const txs = (state.transactions || []).filter(t => t.fromAccountId === targetId || t.toAccountId === targetId);
          for (const tx of txs) {
            await deleteEntity("bank_transactions", tx.id);
          }
        }

        // Audit log
        await upsertEntity("bank_audit_logs", logId, {
          id: logId, action: "borrar_cuenta", admin: adminName,
          accountId: targetId, displayName: c.displayName,
          tipo: c.type, motivo: motivo || "Limpieza de cuentas demo/junior inválidas",
          borroTransacciones: borrarTx, createdAt: now
        });
        return json(res, 200, {
          message: `Cuenta ${c.displayName || targetId} eliminada`,
          accountId: targetId, auditLogId: logId, borroTransacciones: borrarTx
        });
      }

      return json(res, 400, { error: 'Action debe ser emitir, quemar, cambiar-tipo, asignar-eip, crear-usuario, alta-tributos, crear-cuenta-infantil, bono-bienvenida, transferir, transferir-masivo, pagar-regalia, revertir-transferencia, retribuir, crear-fondo-apoyo, guardar-config, responder-soporte o borrar-cuenta' });
    }

    return json(res, 405, { error: "method_not_allowed" });
  } catch (error) {
    return json(res, 500, { error: error.message || "internal_error" });
  }
}
