// tests/hooks.mjs — resolve hook：测试里 @capacitor/* 与 LiveActivities
// 走本地桩，不碰真机 API；其他导入原样放行。
const STUBS = {
  "@capacitor/core": "./stubs/capacitor-core.mjs",
  "@capacitor/preferences": "./stubs/capacitor-preferences.mjs",
  "@capacitor/filesystem": "./stubs/capacitor-filesystem.mjs",
  "@capacitor/haptics": "./stubs/capacitor-haptics.mjs",
  "@capacitor/local-notifications": "./stubs/capacitor-local-notifications.mjs",
  "@ciabosoftwaresolutions/capacitor-live-activities": "./stubs/live-activities.mjs",
};

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (stub) {
    return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
