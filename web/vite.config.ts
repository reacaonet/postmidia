import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * O backend roda em 8601 e nao serve nada estatico: `src/` nao tem
 * `express.static`, nao tem view e nao tem HTML. O painel e um processo
 * separado, e o proxy abaixo evita CORS em desenvolvimento.
 *
 * Em producao quem serve o painel e o nginx, e o backend ganha
 * `express.static('dist')` — ver README.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind em todas as interfaces: o painel as vezes e aberto de outro device
    // na rede local durante o desenvolvimento. `strictPort` faz o erro ser
    // claro quando a 5173 esta ocupada, em vez de pular para 5174 e o
    // usuario ficar achando que o proxy aponta para outro lugar.
    host: true,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8601',
        changeOrigin: true,
        // O painel chama a API em `/api/...` para nao colidir com as rotas do
        // proprio Vite (HMR, assets). O rewrite remove o prefixo, que e o que o
        // backend espera: as rotas estao na raiz.
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
