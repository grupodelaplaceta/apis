/* ═══════════════════════════════════════════════════════════════════════
   API · Nóminas del Banco de La Placeta

   Autenticación: X-CRM-Key (servidor a servidor). La web de empresa y el
   panel RSP llaman aquí desde su backend, nunca desde el navegador.

   GET  /api/nominas?action=estado|config|contratos|periodos|procesar
   POST /api/nominas  { action, ... }
     · config-guardar      { cutoffDay?, autoPago?, retencionPct?, activo? }
     · contrato-guardar    { id?, companyAccountId, employeeDip, grossSalaryPz, complementos[] }
     · contrato-borrar     { id }
     · confirmar           { periodo, contractId, complementoId, hecha, autor? }
     · confirmar-lote      { periodo, contractId, confirmadas: { [complementoId]: bool }, autor? }
     · cerrar              { periodo, pagar? }
     · pagar               { periodoId } | { periodo }
     · procesar            { }  → comprueba plazos vencidos (lo usa el cron)
     · estado              { periodo?, companyAccountId?, employeeDip? }
   ═══════════════════════════════════════════════════════════════════════ */

import { json, readBody, methodNotAllowed } from "../lib/http.js";
import * as N from "../lib/nominas.js";

const CRM_KEY = process.env.CRM_READ_KEY || "";

function autorizado(req) {
  const key = req.headers["x-crm-key"];
  return !!CRM_KEY && key === CRM_KEY;
}

function filtrosDe(params) {
  return {
    periodo: params.get("periodo") || undefined,
    companyAccountId: params.get("companyAccountId") || undefined,
    employeeDip: params.get("employeeDip") || undefined
  };
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

    if (!autorizado(req)) return json(res, 401, { error: "invalid_crm_key" });

    const url = new URL(req.url || "/", "https://api.banco.laplaceta.local");

    /* ── GET: consultas y procesado perezoso ─────────────────────────── */
    if (req.method === "GET") {
      const action = url.searchParams.get("action") || "estado";
      if (action === "estado") return json(res, 200, await N.estadoNominas(filtrosDe(url.searchParams)));
      if (action === "config") return json(res, 200, await N.leerConfig());
      if (action === "contratos") return json(res, 200, await N.listarContratos(filtrosDe(url.searchParams)));
      if (action === "periodos") return json(res, 200, await N.listarPeriodos(filtrosDe(url.searchParams)));
      if (action === "procesar") return json(res, 200, await N.procesarVencimientos(new Date(), { autor: "cron-get" }));
      return json(res, 400, { error: "action_desconocida", action });
    }

    if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST", "OPTIONS"]);

    /* ── POST: operaciones ───────────────────────────────────────────── */
    const body = JSON.parse((await readBody(req)) || "{}");
    const action = body.action;

    if (action === "estado") return json(res, 200, await N.estadoNominas(filtrosDe(new URLSearchParams(body.filtros || {}))));

    if (action === "config") {
      return json(res, 200, body.guardar ? await N.guardarConfig(body) : await N.leerConfig());
    }

    if (action === "contrato-guardar") {
      const contrato = await N.guardarContrato(body.contrato || body);
      return json(res, 200, { ok: true, contrato });
    }

    if (action === "contrato-borrar") {
      if (!body.id) return json(res, 400, { error: "Se requiere id" });
      return json(res, 200, await N.borrarContrato(body.id));
    }

    if (action === "confirmar") {
      const doc = await N.confirmarActividad({
        periodo: body.periodo,
        contractId: body.contractId,
        complementoId: body.complementoId,
        hecha: body.hecha !== false,
        autor: body.autor || "empresa",
        nota: body.nota
      });
      return json(res, 200, { ok: true, confirmacion: doc });
    }

    if (action === "confirmar-lote") {
      const contrato = await N.obtenerContrato(body.contractId);
      if (!contrato) return json(res, 404, { error: "Contrato no encontrado" });
      const cambios = body.confirmadas || {};
      const hechas = [];
      for (const [complementoId, hecha] of Object.entries(cambios)) {
        hechas.push(await N.confirmarActividad({
          periodo: body.periodo, contractId: body.contractId,
          complementoId, hecha: !!hecha, autor: body.autor || "empresa"
        }));
      }
      return json(res, 200, { ok: true, confirmadas: hechas.length, detalle: hechas });
    }

    if (action === "cerrar") {
      if (!N.esPeriodoValido(body.periodo)) return json(res, 400, { error: "Periodo inválido (YYYY-MM)" });
      const r = await N.cerrarPeriodo(body.periodo, { pagar: body.pagar, autor: body.autor || "admin" });
      return json(res, 200, r);
    }

    if (action === "pagar") {
      if (body.periodoId) {
        const todos = await N.listarPeriodos({});
        const doc = todos.find((p) => p.id === body.periodoId);
        if (!doc) return json(res, 404, { error: "Periodo no encontrado" });
        const r = await N.pagarPeriodo(doc, body.autor || "admin");
        return json(res, r.ok ? 200 : 409, r);
      }
      if (N.esPeriodoValido(body.periodo)) {
        const r = await N.cerrarPeriodo(body.periodo, { pagar: true, autor: body.autor || "admin" });
        return json(res, 200, r);
      }
      return json(res, 400, { error: "Se requiere periodoId o periodo" });
    }

    if (action === "procesar") {
      return json(res, 200, await N.procesarVencimientos(new Date(), { autor: body.autor || "cron" }));
    }

    return json(res, 400, {
      error: "action_desconocida",
      action,
      disponibles: ["estado", "config", "contrato-guardar", "contrato-borrar", "confirmar", "confirmar-lote", "cerrar", "pagar", "procesar"]
    });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}
