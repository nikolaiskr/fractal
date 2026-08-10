import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative assets make the same build work both at <user>.github.io and /<repo>/.
  base: './',
});
