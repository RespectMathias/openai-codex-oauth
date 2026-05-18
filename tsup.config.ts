import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/node/index.ts', 'src/proxy.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['@ai-sdk/openai', '@ai-sdk/provider', 'ai'],
});
