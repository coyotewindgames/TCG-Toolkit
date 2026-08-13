/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Turbocomp brand palette — see docs/TURBOCOMP-DESIGN-SPEC.md
        navy: '#0B1120',
        card: '#1A2332',
        track: '#1E2A3A',
        border: '#2A3A4A',
        brand: {
          DEFAULT: '#2DD4A8',
          dark: '#1D9E75',
        },
        accent: {
          DEFAULT: '#E8773A',
          mid: '#EF9F27',
        },
        ink: {
          DEFAULT: '#E2E8F0',
          muted: '#64748B',
          dim: '#475569',
        },
      },
    },
  },
  plugins: [],
};
