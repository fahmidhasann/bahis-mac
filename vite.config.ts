import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default function ViteConfig({ mode }) {
    process.env.NODE_ENV = mode;
    const isDev = process.env.NODE_ENV === 'development';
    const isProd = process.env.NODE_ENV === 'production';

    return defineConfig({
        resolve: {
            alias: {
                // The package advertises a src entry that is missing from its npm tarball.
                'leaflet.gridlayer.googlemutant': path.join(
                    projectRoot,
                    'node_modules/leaflet.gridlayer.googlemutant/dist/Leaflet.GoogleMutant.js',
                ),
            },
        },
        plugins: [
            react(),
            electron([
                {
                    // Main-Process entry file of the Electron App.
                    entry: 'electron/main.ts',
                    vite: {
                        build: {
                            minify: isProd,
                            rollupOptions: {
                                // Keep the CommonJS wrapper intact so Electron can load
                                // the native SQLite addon from the unpacked app resources.
                                external: ['better-sqlite3'],
                            },
                        },
                    },
                },
                {
                    entry: 'electron/preload.ts',
                    vite: {
                        build: {
                            rollupOptions: {
                                output: {
                                    entryFileNames: '[name].mjs',
                                },
                            },
                        },
                    },
                    onstart(options) {
                        // Notify the Renderer-Process to reload the page when the Preload-Scripts build is complete,
                        // instead of restarting the entire Electron App.
                        options.reload();
                    },
                },
            ]),
            renderer(),
        ],
    });
}
