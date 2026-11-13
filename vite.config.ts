import { defineConfig } from 'vite';

// Relative base so the build works from a subpath (GitHub Pages serves it at /aster/).
export default defineConfig({
  base: './',
});
