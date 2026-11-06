import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      // 开发时把后端请求转给画布服务，避免跨域
      '/api': { target: 'http://127.0.0.1:8770', changeOrigin: true },
      '/assets': { target: 'http://127.0.0.1:8770', changeOrigin: true },
    },
  },
  // 产物资源走 /static/：/assets/ 已经被后端占用（用户生成物的访问路径）
  build: { outDir: 'dist', emptyOutDir: true, assetsDir: 'static' },
})
