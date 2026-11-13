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

// Relative base so the build works from a subpath (GitHub Pages serves it at /aster/).
export default defineConfig({
  base: './',
  plugins: [googleAnalytics()],
});
