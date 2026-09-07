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
      keyframes: {
        // Pulsing "locked on" glow for the camera alignment guide: the emerald
        // ring breathes in intensity + size so a well-framed card reads as an
        // active, confident lock rather than a static border.
        alignPulse: {
          '0%, 100%': {
            boxShadow:
              '0 0 0 9999px rgba(0,0,0,0.45), 0 0 18px 3px rgba(52,211,153,0.55)',
            borderColor: 'rgba(52,211,153,0.85)',
          },
          '50%': {
            boxShadow:
              '0 0 0 9999px rgba(0,0,0,0.45), 0 0 34px 10px rgba(52,211,153,0.95)',
            borderColor: 'rgba(110,231,183,1)',
          },
        },
        // Same breathing glow for the Capture button, minus the full-screen
        // vignette spread the guide uses.
        glowPulse: {
          '0%, 100%': { boxShadow: '0 0 10px 1px rgba(52,211,153,0.55)' },
          '50%': { boxShadow: '0 0 22px 6px rgba(52,211,153,0.9)' },
        },
      },
      animation: {
        alignPulse: 'alignPulse 1.15s ease-in-out infinite',
        glowPulse: 'glowPulse 1.15s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
