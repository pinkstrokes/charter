// Dev-only middleware for the Charter UI: serves persona tokens, proof files and
// the evolution engine's log to the page on localhost (see charter-core.ts).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';
import { createCharterCore, type CoreOptions } from './charter-core';

export function charterDev(opts: CoreOptions): Plugin {
  const { httpBase, defaultDb, personas, externalFile, companyDir, proofFiles, world } = createCharterCore(opts);
  const demoDir = process.env.CHARTER_DEMO_DIR || '';

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
        // The live demo's server (tools/demo/demo.sh up) offers the three companies and the step bar.
        const companies = (process.env.CHARTER_COMPANIES ?? '')
          .split(',')
          .filter(Boolean)
          .map(c => ({ db: c.split('=')[0], label: c.split('=').slice(1).join('=') }));
        return send(200, { defaultDb, httpBase, wsBase, companies, demo: !!demoDir });
      }
      if (url.pathname === '/__charter/demo/steps' && demoDir) return send(200, JSON.parse(fs.readFileSync(path.join(demoDir, 'steps.json'), 'utf8')));
      if (url.pathname === '/__charter/demo/reset' && req.method === 'POST' && demoDir) {
        // Back to the prepared morning: stops the demo server, restores its snapshot, starts it again.
        const r = spawnSync(path.join(opts.repoRoot, 'tools/demo/demo.sh'), ['reset'], { encoding: 'utf8', timeout: 90_000, env: { ...process.env, CHARTER_DEMO_DIR: demoDir } });
        return send(r.status === 0 ? 200 : 500, { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() });
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

