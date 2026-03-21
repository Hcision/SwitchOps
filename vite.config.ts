import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/') || id.includes('node_modules/react-router')) {
            return 'vendor';
          }
          if (id.includes('node_modules/d3') || id.includes('node_modules/reactflow') || id.includes('node_modules/@reactflow')) {
            return 'charts';
          }
          if (id.includes('node_modules/xlsx') || id.includes('node_modules/file-saver') || id.includes('node_modules/jszip')) {
            return 'data';
          }
        },
      },
    },
  },
})
