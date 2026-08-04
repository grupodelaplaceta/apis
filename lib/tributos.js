import crypto from "crypto";
import { mongo } from "./mongo.js";
import { stripEmptyMongoKeys } from "./sanitizeMongo.js";

const VAT_RATE = 0.12;
let initialized = false;

function normalizeDip(value) {
  const cleaned = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^\d{8}[A-Z]$/.test(cleaned)) return cleaned;
  return cleaned || "12345678A";
}

function normalizePlacetaId(value) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, "-");
}

function normalizeIban(value) {
  const cleaned = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^GDLP[A-Z0-9]{7}$/.test(cleaned)) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}-${cleaned.slice(8)}`;
  }
  return cleaned || "GDLP-AP98-605";
}

function calculateInvoiceTotals(lines = []) {
  const normalizedLines = (lines || []).map((line) => {
    const qty = Number(line?.cantidad || 0);
    const unitPrice = Number(line?.precio_unitario || 0);
    const ivaPercent = Number(line?.iva_porcentaje ?? 12);
    const subtotalNeto = Number((qty * unitPrice).toFixed(2));
    const subtotalIva = Number((subtotalNeto * (ivaPercent / 100)).toFixed(2));
    return {
      concepto_producto: String(line?.concepto_producto || "Producto sin nombre"),
      cantidad: qty,
      precio_unitario: Number(unitPrice.toFixed(2)),
      iva_porcentaje: Number(ivaPercent.toFixed(2)),
      subtotal_neto: subtotalNeto,
      subtotal_iva: subtotalIva
    };
  });

  const baseImponible = Number(normalizedLines.reduce((sum, line) => sum + line.subtotal_neto, 0).toFixed(2));
  const totalIva = Number(normalizedLines.reduce((sum, line) => sum + line.subtotal_iva, 0).toFixed(2));
  const totalFactura = Number((baseImponible + totalIva).toFixed(2));

  return {
    baseImponible,
    totalIva,
    totalFactura,
    lines: normalizedLines
  };
}

function generateVerificationCsv(prefix = "CSV-FACT") {
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${suffix}`;
}

function generateTributosIban(seed = "TRB") {
  const token = String(seed ?? "TRB").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4).padEnd(4, "X");
  const serial = String(Date.now()).slice(-3).padStart(3, "0");
  return `GDLP-${token}-${serial}`;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

async function ensureTributosIndexes() {
  if (initialized) return;
  initialized = true;
  const db = await mongo();
  await Promise.all([
    db.collection("tributos_contributors").createIndex({ placeta_id: 1 }, { unique: true }),
    db.collection("tributos_contributors").createIndex({ dip: 1 }),
    db.collection("tributos_declarations").createIndex({ id: 1 }, { unique: true }),
    db.collection("tributos_declarations").createIndex({ placeta_id: 1 }),
    db.collection("tributos_declarations").createIndex({ mes_periodo: 1 }),
    db.collection("tributos_invoices").createIndex({ id: 1 }, { unique: true }),
    db.collection("tributos_invoices").createIndex({ emisor_placeta_id: 1 }),
    db.collection("tributos_invoices").createIndex({ receptor_placeta_id: 1 }),
    db.collection("tributos_invoices").createIndex({ fecha_emision: 1 }),
    db.collection("tributos_line_items").createIndex({ factura_id: 1 }),
    db.collection("tributos_rectifications").createIndex({ declaracion_id: 1 })
  ]);
}

async function contributorsCollection() {
  await ensureTributosIndexes();
  return (await mongo()).collection("tributos_contributors");
}

/** Lista los contribuyentes del Registro Tributario real (más recientes primero). */
export async function listContributors(limit = 500) {
  const collection = await contributorsCollection();
  return collection.find({}).sort({ fecha_alta_tributos: -1 }).limit(limit).toArray();
}

async function declarationsCollection() {
  await ensureTributosIndexes();
  return (await mongo()).collection("tributos_declarations");
}

async function invoicesCollection() {
  await ensureTributosIndexes();
  return (await mongo()).collection("tributos_invoices");
}

async function lineItemsCollection() {
  await ensureTributosIndexes();
  return (await mongo()).collection("tributos_line_items");
}

async function rectificationsCollection() {
  await ensureTributosIndexes();
  return (await mongo()).collection("tributos_rectifications");
}

export async function findContributorByEip(eip) {
  const cleanEip = String(eip || "").trim().toUpperCase();
  if (!cleanEip) return null;
  const collection = await contributorsCollection();
  return collection.findOne({ eip: cleanEip });
}

export async function createContributor(payload) {
  const placetaId = normalizePlacetaId(payload.placeta_id || payload.placetaId);
  const dip = normalizeDip(payload.dip);
  const nombre = String(payload.nombre || "").trim();
  const tipoSujeto = String(payload.tipo_sujeto || "Fisico").trim() === "Empresa" ? "Empresa" : "Fisico";
  const roles_json = Array.isArray(payload.roles_json) ? payload.roles_json : ["ciudadano"];
  const now = new Date().toISOString();
  const eip = tipoSujeto === "Empresa" ? String(payload.eip || payload.EIP || "").trim() : null;
  const collection = await contributorsCollection();

  const update = {
    dip,
    nombre,
    tipo_sujeto: tipoSujeto,
    estado_fiscal: "Al Dia",
    fecha_alta_tributos: now,
    roles_json,
    iban: normalizeIban(payload.iban || generateTributosIban(placetaId))
  };
  if (eip) update.eip = eip;

  const result = await collection.findOneAndUpdate(
    { placeta_id: placetaId },
    { $set: update, $setOnInsert: { id: crypto.randomUUID(), placeta_id: placetaId } },
    { upsert: true, returnDocument: "after" }
  );

  return result.value;
}

export async function createDeclarationForContributor(contributor) {
  const collection = await declarationsCollection();
  const declaration = {
    id: crypto.randomUUID(),
    contributor_id: contributor.id,
    placeta_id: contributor.placeta_id,
    mes_periodo: currentMonth(),
    cuenta_id_blp: contributor.iban || generateTributosIban(contributor.placeta_id),
    patrimonio_medio: 0,
    indice_acumulacion: 0,
    cuota_irm: 0,
    cuota_igf: 0,
    exencion_aplicada: false,
    dias_declarados_banco: 0,
    dias_reconstruidos_crm: 0,
    dias_activos_mes: 30,
    pdf_hash: null,
    estado_pago: "Borrador",
    bypass_junta_directiva: false,
    id_permiso_junta: null,
    is_rectified: false,
    created_at: new Date().toISOString()
  };
  await collection.insertOne(stripEmptyMongoKeys(declaration));
  return declaration;
}

export async function createInvoice(payload) {
  const totals = calculateInvoiceTotals(payload.lineas || []);
  const invoice = {
    id: crypto.randomUUID(),
    numero_factura: String(payload.numero_factura || `F-${currentMonth().replace("-", "")}-0001`),
    emisor_placeta_id: normalizePlacetaId(payload.emisor_placeta_id),
    receptor_placeta_id: normalizePlacetaId(payload.receptor_placeta_id),
    fecha_emision: new Date().toISOString(),
    base_imponible: totals.baseImponible,
    total_iva: totals.totalIva,
    total_factura: totals.totalFactura,
    transaction_id_blp: String(payload.transaction_id_blp || "TX-BANC-0001"),
    csv_verificacion: generateVerificationCsv("CSV-FACT")
  };
  const invoiceCollection = await invoicesCollection();
  const itemsCollection = await lineItemsCollection();

  await invoiceCollection.insertOne(stripEmptyMongoKeys(invoice));
  if (totals.lines.length) {
    await itemsCollection.insertMany(stripEmptyMongoKeys(
      totals.lines.map((line) => ({
        id: crypto.randomUUID(),
        factura_id: invoice.id,
        ...line
      }))
    ));
  }

  return invoice;
}

export async function getBreakdown({ placetaId, mesPeriodo }) {
  const period = String(mesPeriodo || currentMonth());
  const invoicesColl = await invoicesCollection();
  const lineItemsColl = await lineItemsCollection();
  const contributorsColl = await contributorsCollection();

  const matchPeriod = new RegExp(`^${period}`);
  const filteredInvoices = await invoicesColl.find({
    fecha_emision: { $regex: matchPeriod },
    $or: [
      { emisor_placeta_id: placetaId },
      { receptor_placeta_id: placetaId }
    ]
  }).toArray();

  const contributorKeys = Array.from(new Set(filteredInvoices.flatMap((invoice) => [invoice.emisor_placeta_id, invoice.receptor_placeta_id])));
  const contributors = await contributorsColl.find({ placeta_id: { $in: contributorKeys } }).toArray();
  const contributorMap = Object.fromEntries(contributors.map((contributor) => [contributor.placeta_id, contributor]));

  const facturas = await Promise.all(filteredInvoices.map(async (invoice) => {
    const items = await lineItemsColl.find({ factura_id: invoice.id }).toArray();
    return {
      numero_factura: invoice.numero_factura,
      csv: invoice.csv_verificacion,
      fecha: invoice.fecha_emision,
      emisor: contributorMap[invoice.emisor_placeta_id]?.nombre || invoice.emisor_placeta_id,
      receptor: contributorMap[invoice.receptor_placeta_id]?.nombre || invoice.receptor_placeta_id,
      base_imponible: invoice.base_imponible,
      total_iva: invoice.total_iva,
      total: invoice.total_factura,
      productos: items.map((item) => ({
        concepto_producto: item.concepto_producto,
        cantidad: item.cantidad,
        precio_unitario: item.precio_unitario,
        subtotal_neto: item.subtotal_neto,
        subtotal_iva: item.subtotal_iva
      }))
    };
  }));

  return {
    periodo: period,
    total_iva_acumulado: Number(facturas.reduce((sum, fact) => sum + fact.total_iva, 0).toFixed(2)),
    facturas
  };
}

export async function verifyRegularization({ declaracionId, userActionConfirmed }) {
  const declarationsColl = await declarationsCollection();
  const rectificationsColl = await rectificationsCollection();
  const declaration = await declarationsColl.findOne({ id: declaracionId });

  if (!declaration) {
    const error = new Error("declaracion_no_encontrada");
    error.statusCode = 404;
    throw error;
  }

  if (!userActionConfirmed) {
    const error = new Error("confirmacion_requerida");
    error.statusCode = 400;
    throw error;
  }

  await declarationsColl.updateOne({ id: declaracionId }, stripEmptyMongoKeys({
    $set: {
      estado_pago: "Rectificada_Devolucion_Verificada",
      is_rectified: true
    }
  }));

  const rectification = {
    id: crypto.randomUUID(),
    declaracion_id: declaration.id,
    estado_ajuste: "Diferencia_Devuelta",
    diferencia_delta: 0,
    fecha_rectificacion: new Date().toISOString()
  };
  await rectificationsColl.insertOne(stripEmptyMongoKeys(rectification));

  return {
    status: "INSTANT_REFUND_SUCCESS",
    monto_reembolsado: Number((declaration.cuota_igf || 0).toFixed(2)),
    cuenta_destino: "GDLP-AP98-605",
    concepto_tx_blp: "Compensación Instantánea Verificada por Reajuste TLP",
    comprobante_bancario_id: `TX-REFUND-${String(Date.now()).slice(-4)}`
  };
}

export function createCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export function answerOptions(res) {
  res.statusCode = 204;
  createCorsHeaders(res);
  res.end();
}
