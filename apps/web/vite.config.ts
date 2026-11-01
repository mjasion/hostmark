import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// D85: the platform attributes are baked in at build time; every page loads `/rum.js` with them.
const RUM_ATTRIBUTES = {
  'data-platform': process.env.HOSTMARK_PLATFORM ?? 'local',
  'data-variant': process.env.HOSTMARK_VARIANT ?? 'portable',
  'data-topology': process.env.HOSTMARK_TOPOLOGY ?? 'single',
  'data-region': process.env.HOSTMARK_REGION ?? 'local',
};

/**
 * Adds the RUM tag after Vite's own HTML processing. Written in the source HTML, Vite would bundle and hash
 * `/rum.js`, but the file must keep its fixed name because prerendered pages and `/f/:id` use it too.
 */
function rumTag(): Plugin {
  return {
    name: 'hostmark-rum-tag',
    transformIndexHtml: {
      order: 'post',
      handler: () => [
        {
          tag: 'script',
          attrs: { type: 'module', src: '/rum.js', 'data-rum': true, ...RUM_ATTRIBUTES },
          injectTo: 'head',
        },
      ],
    },
  };
}

/**
 * `rum.js` keeps its name between deploys, so a cached copy must not import a hashed chunk that a newer deploy
 * removed. A query on the import makes the bundler treat the constants as a separate module and inline them.
 */
function inlineRumConstants(): Plugin {
  const target = '@hostmark/contract/constants';
  return {
    name: 'hostmark-rum-inline-constants',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source !== target || !importer?.endsWith('/src/rum.ts')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved ? `${resolved.id}?rum` : null;
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [react(), rumTag(), inlineRumConstants()],
  server: { proxy: { '/api': process.env.HOSTMARK_API_URL ?? 'http://localhost:8080' } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // `app/index.html` becomes `dist/app/index.html` (D21). `rum` is a separate, React-free entry.
      input: { app: 'app/index.html', rum: 'src/rum.ts' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'rum' ? 'rum.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
