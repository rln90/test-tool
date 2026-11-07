import { defineConfig } from 'vite';

export default defineConfig({
  // Relative Pfade, damit dist/ auf jedem Webserver bzw. Unterverzeichnis läuft.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
