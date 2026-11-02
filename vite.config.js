import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

// Camera, microphone and geolocation only work in a secure context. The basic-ssl
// plugin serves the dev server over HTTPS with a self-signed certificate so you can
// test on a phone over your LAN (accept the certificate warning once).
// Set VITE_DEV_HTTP=1 to serve plain HTTP (e.g. for localhost-only automated tests).
export default defineConfig(({ command }) => ({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  plugins: [
    ...(command === 'serve' && process.env.VITE_DEV_HTTP !== '1' ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // Icons and the logo are NOT precached, so replacing them on the server shows
      // up without a rebuild (they are cached at runtime instead, below).
      includeManifestIcons: false,
      manifest: {
        name: 'Trailguard Essentials',
        short_name: 'Trailguard Essentials',
        description: 'Event medical, security and fire dispatch: live map, push-to-talk, bodycam, ePCR and after-action reports.',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b1014',
        theme_color: '#0b1014',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // jsPDF's optional helpers (HTML / SVG rendering) are never used: don't precache them.
        globIgnores: ['sw-background.js', 'trailguard-config*.js', 'icons/**', '**/html2canvas-*.js', '**/purify.es-*.js', '**/index.es-*.js'],
        importScripts: ['sw-background.js'],
        navigateFallback: 'index.html',
        // Never intercept Firebase, Google APIs or the Apps Script endpoint.
        navigateFallbackDenylist: [/^\/__\//],
        runtimeCaching: [
          {
            // Logo and app icons: show the cached copy at once, refresh it in the background.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.includes('/icons/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'site-icons', cacheableResponse: { statuses: [200] } }
          },
          {
            // Site settings: always fetch the latest, fall back to the last copy offline.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.endsWith('/trailguard-config.js'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'site-config',
              networkTimeoutSeconds: 3,
              cacheableResponse: { statuses: [200] }
            }
          },
          {
            // Map tiles: cache-first so recently viewed areas still render with poor signal.
            urlPattern: ({ url }) => url.hostname.endsWith('tile.openstreetmap.org'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 1500, maxAgeSeconds: 7 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ]
}));
