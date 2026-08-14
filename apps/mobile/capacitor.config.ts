import type { CapacitorConfig } from '@capacitor/cli';

const devServerUrl = process.env.CAP_DEV_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'com.theturbocomp.app',
  appName: 'Turbocomp',
  webDir: '../web/dist',
  // Enable live-reload server only when CAP_DEV_SERVER_URL is set, e.g.:
  //   CAP_DEV_SERVER_URL=http://192.168.1.42:5173 npx cap run android
  ...(devServerUrl
    ? { server: { url: devServerUrl, cleartext: true } }
    : {}),
};

export default config;
