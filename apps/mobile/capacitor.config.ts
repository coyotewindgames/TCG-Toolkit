import type { CapacitorConfig } from '@capacitor/cli';

// Native permissions required by the camera "snap-to-identify" feature
// (@capacitor/camera) and the barcode scanner. The ios/ and android/ projects
// are generated on demand with `npx cap add ios|android`; after generating
// them, add these permission strings so the OS camera prompt works:
//
//   iOS  — ios/App/App/Info.plist:
//     <key>NSCameraUsageDescription</key>
//     <string>Scan a card to identify it and look up its price.</string>
//     <key>NSPhotoLibraryUsageDescription</key>
//     <string>Choose a card photo to identify it.</string>
//     <key>NSPhotoLibraryAddUsageDescription</key>
//     <string>Save captured card photos.</string>
//
//   Android — android/app/src/main/AndroidManifest.xml:
//     <uses-permission android:name="android.permission.CAMERA" />
//     <uses-feature android:name="android.hardware.camera" android:required="false" />

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
