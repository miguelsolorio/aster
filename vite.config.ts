import { defineConfig, type Plugin } from 'vite';

// The same Google Analytics property as miguelsolorio.com and its other games.
const GA_ID = 'G-PDB3DT24E5';

// Adds the Google tag to the built page only, so local dev sessions are not counted
// (the site's Hugo template does the same with hugo.IsProduction).
function googleAnalytics(): Plugin {
  return {
    name: 'google-analytics',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { async: true, src: `https://www.googletagmanager.com/gtag/js?id=${GA_ID}` },
          injectTo: 'head',
        },
        {
          tag: 'script',
          children: `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_ID}');`,
          injectTo: 'head',
        },
      ];
    },
  };
}

// Dev only: the ?perf overlay on a phone posts its spike log here; it is appended to
// tools/perf/out/device.jsonl so a session on a real device can be read on the Mac.
function perfLog(): Plugin {
  return {
    name: 'perf-log',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__perf', (req, res) => {
        if (req.method !== 'POST') return void res.end();
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          const { appendFile, mkdir } = await import('node:fs/promises');
          await mkdir('tools/perf/out', { recursive: true });
          await appendFile('tools/perf/out/device.jsonl', `${body}\n`);
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

// Relative base so the build works from a subpath (GitHub Pages serves it at /aster/).
export default defineConfig({
  base: './',
  plugins: [googleAnalytics(), perfLog()],
  // other sessions' worktrees live under .claude/; editing them must not reload a page being played
  server: { watch: { ignored: ['**/.claude/**', '**/tools/perf/out/**'] } },
});
