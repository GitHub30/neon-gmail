import { defineConfig, type Plugin } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function inlineCssAndSwPrecachePlugin(): Plugin {
  let builtJsFiles: string[] = [];

  return {
    name: 'inline-css-and-inject-sw-precache',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      builtJsFiles = [];
      const htmlAsset = bundle['index.html'];
      for (const [fileName, item] of Object.entries(bundle)) {
        if (fileName.endsWith('.js') && item.type === 'chunk') {
          builtJsFiles.push(`./${fileName}`);
        }
        if (htmlAsset && htmlAsset.type === 'asset' && fileName.endsWith('.css') && item.type === 'asset') {
          const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const linkRe = new RegExp(`<link[^>]+href="\\.?/?${escaped}"[^>]*>`, 'i');
          const html = String(htmlAsset.source);
          if (linkRe.test(html)) {
            htmlAsset.source = html.replace(linkRe, `<style>${String(item.source)}</style>`);
            delete bundle[fileName];
          }
        }
      }
    },
    closeBundle() {
      const swPath = resolve(process.cwd(), 'dist/sw.js');
      try {
        let sw = readFileSync(swPath, 'utf8');
        const buildTag = builtJsFiles[0]?.match(/-([A-Za-z0-9_-]+)\.js$/)?.[1] ?? Date.now().toString(36);
        sw = sw.replace('__BUILD_VERSION__', buildTag);
        sw = sw.replace('/*__PRECACHE_ASSETS__*/', builtJsFiles.map((f) => `'${f}'`).join(', '));
        writeFileSync(swPath, sw, 'utf8');
      } catch {
        // ignore if sw.js missing
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [inlineCssAndSwPrecachePlugin()],
  build: {
    target: 'es2022',
    minify: 'esbuild',
    cssMinify: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        main: 'index.html',
      },
    },
  },
  server: {
    port: 5173,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  },
  preview: {
    port: 4173,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  },
});
