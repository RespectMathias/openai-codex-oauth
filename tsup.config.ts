import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/node/index.ts', 'src/proxy.ts'],
  format: ['cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['@ai-sdk/openai', '@ai-sdk/provider', 'ai'],
});
