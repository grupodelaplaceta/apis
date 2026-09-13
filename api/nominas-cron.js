/* ═══════════════════════════════════════════════════════════════════════
   Cron · Cierre y pago automático de nóminas

   Programa un cron diario en Vercel apuntando a este endpoint:
     { "crons": [{ "path": "/api/nominas-cron", "schedule": "0 6 * * *" }] }

   Autorización:
     · `Authorization: Bearer ${CRON_SECRET}` (lo pone Vercel si defines
       la variable de entorno CRON_SECRET), o
     · `X-CRM-Key: ${CRM_READ_KEY}` para lanzarlo a mano.

   Nota: el cierre también es "perezoso" (cualquier lectura de nóminas
   comprueba los plazos vencidos), así que si el cron no está configurado
   el sistema sigue funcionando; esto solo lo hace puntual.
   ═══════════════════════════════════════════════════════════════════════ */

import { json } from "../lib/http.js";
import { procesarVencimientos } from "../lib/nominas.js";

export default async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    const auth = req.headers.authorization || "";
    const cronKey = process.env.CRM_READ_KEY || "";
    const okCron = !!secret && auth === `Bearer ${secret}`;
    const okCrm = !!cronKey && req.headers["x-crm-key"] === cronKey;
    if (!okCron && !okCrm) return json(res, 401, { error: "no_autorizado" });

    const resultado = await procesarVencimientos(new Date(), { autor: "cron" });
    return json(res, 200, resultado);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
