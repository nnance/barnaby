import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built bundle works from any path the kiosk serves it at.
  base: './',
  build: {
    target: 'es2022',
    // One file each. Fewer requests for a browser starting on an appliance.
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  server: { port: 5273 },
});
