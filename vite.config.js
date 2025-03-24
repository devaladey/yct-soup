import {defineConfig} from 'vite'
// vite.config.js
export default defineConfig({
    root: 'public',
    server: {
      port: 3000,
      // If you need to proxy WebSocket connections to your backend
      proxy: {
        '/socket.io': {
          target: 'http://localhost:8000', // Your backend server address
          ws: true
        }
      }
    },
    build: {
        outDir: 'dist',  // Vite will output built files to 'dist'
      }
  });