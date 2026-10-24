// Dev-only middleware for the Charter UI: serves persona tokens, proof files and
// the evolution engine's log to the page on localhost (see charter-core.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createCharterCore, type CoreOptions } from './charter-core';

export function charterDev(opts: CoreOptions): Plugin {
  const { httpBase, defaultDb, personas, externalFile, companyDir, proofFiles, world } = createCharterCore(opts);

  async function handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/__charter/')) return next();
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };
    try {
      const db = url.searchParams.get('db') || defaultDb;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(db)) return send(400, { error: 'bad database name' });
      if (url.pathname === '/__charter/env') {
        const wsBase = httpBase.replace(/^http/, 'ws');
        return send(200, { defaultDb, httpBase, wsBase });
      }
      if (url.pathname === '/__charter/personas' && req.method === 'GET') return send(200, await personas(db));
      if (url.pathname === '/__charter/personas/rebind' && req.method === 'POST') {
        if (externalFile(db)) return send(409, { error: `${db} uses identities written by the world builder; not rebinding them` });
        return send(200, await personas(db, true));
      }
      if (url.pathname === '/__charter/proof') return send(200, proofFiles(companyDir(db, url.searchParams.get('dir')), db));
      if (url.pathname === '/__charter/world' && req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        return send(200, await world(db, JSON.parse(raw || '{}')));
      }
      return send(404, { error: 'unknown endpoint' });
    } catch (e) {
      return send(500, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    name: 'charter-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => void handle(req, res, next));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => void handle(req, res, next));
    },
  };
}

