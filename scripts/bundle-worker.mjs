import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outFile = resolve(root, 'public/proxies/cloudflare-worker.js');

mkdirSync(dirname(outFile), { recursive: true });

await build({
  entryPoints: [resolve(root, 'workers/mail-proxy/src/index.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  external: ['cloudflare:sockets'],
  banner: {
    js: '// Neon Gmail — Cloudflare Workers IMAP/SMTP CORS Proxy (Generated from workers/mail-proxy/src)\n// Deploy with: cd workers/mail-proxy && npx wrangler deploy\n',
  },
});

console.log('Bundled Cloudflare Worker to public/proxies/cloudflare-worker.js');
