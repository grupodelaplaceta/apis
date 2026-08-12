/**
 * Servidor local para el Backend-Banco
 * Wrapper Express que ejecuta los serverless handlers de Vercel localmente
 */
import 'dotenv/config';
import express from 'express';
import crmStateHandler from './api/crm-state.js';
import webHandler from './api/web.js';

const app = express();
const PORT = process.env.LOCAL_PORT || 4000;

// Configurar variables de entorno para entorno local
process.env.CRM_READ_KEY = process.env.CRM_READ_KEY || 'crm-gdlp-shared-key-2026';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
process.env.MONGODB_DB = process.env.MONGODB_DB || 'TestBanco';

// Middleware para parsear body como buffer (necesario para readBody de Vercel)
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// Wrap del handler serverless de Vercel para Express
app.all('/api/crm-state', async (req, res) => {
  // Convertir request de Express a formato que espera Vercel (IncomingMessage)
  const vercelReq = new Proxy(req, {
    get(target, prop) {
      if (prop === 'method') return req.method;
      if (prop === 'headers') return req.headers;
      if (prop === 'socket') return req.socket;
      // Para readBody necesita ser async iterable
      if (prop === Symbol.asyncIterator) {
        return async function*() {
          if (req.body) {
            yield Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
          }
        };
      }
      return target[prop];
    }
  });

  const vercelRes = new Proxy(res, {
    get(target, prop) {
      if (prop === 'statusCode') return typeof target.statusCode === 'number' ? target.statusCode : 200;
      if (prop === 'end') return (data) => {
        if (typeof data === 'string') {
          try { target.json(JSON.parse(data)); } catch { target.send(data); }
        } else {
          target.end(data);
        }
      };
      if (prop === 'setHeader' || prop === 'setHeader') {
        return (key, val) => target.set(key, val);
      }
      return target[prop];
    }
  });

  try {
    await crmStateHandler(vercelReq, vercelRes);
  } catch (err) {
    console.error('Error en crm-state handler:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0-local', app: 'Backend-Banco Local' });
});

// Ruta ciudadana scoped (web.js) — Bearer PlacetaID
app.all('/api/web', async (req, res) => {
  const vercelReq = new Proxy(req, {
    get(target, prop) {
      if (prop === 'method') return req.method;
      if (prop === 'headers') return req.headers;
      if (prop === 'socket') return req.socket;
      if (prop === Symbol.asyncIterator) {
        return async function*() {
          if (req.body) {
            yield Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
          }
        };
      }
      return target[prop];
    }
  });
  const vercelRes = new Proxy(res, {
    get(target, prop) {
      if (prop === 'statusCode') return typeof target.statusCode === 'number' ? target.statusCode : 200;
      if (prop === 'end') return (data) => {
        if (typeof data === 'string') {
          try { target.json(JSON.parse(data)); } catch { target.send(data); }
        } else { target.end(data); }
      };
      if (prop === 'setHeader') return (key, val) => target.set(key, val);
      return target[prop];
    }
  });
  try {
    await webHandler(vercelReq, vercelRes);
  } catch (err) {
    console.error('Error en web handler:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║      Backend-Banco Local - Puerto ${PORT}          ║
║    IBAN: GDLP-APxx-xxx (corregido)               ║
║    CRM_KEY: ${process.env.CRM_READ_KEY}          ║
╚══════════════════════════════════════════════════╝
  `);
});
