import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.theturbocomp.app',
  appName: 'Turbocomp',
  webDir: '../web/dist',
  server: {
    // Set CAP_DEV_SERVER_URL to your local dev server for live-reload, e.g.:
    //   CAP_DEV_SERVER_URL=http://192.168.1.42:5173 npx cap run android
    url: process.env.CAP_DEV_SERVER_URL || undefined,
    cleartext: true,
  },
};

export default config;
