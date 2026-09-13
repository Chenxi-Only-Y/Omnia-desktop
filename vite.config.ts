import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = __dirname;
const rendererRoot = path.join(root, 'src', 'renderer');

export default defineConfig({
  root: rendererRoot,
  // 打包后由主进程用 file:// 加载 index.html，必须用相对路径
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.join(root, 'src', 'shared'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: path.join(root, 'dist', 'renderer'),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
});
