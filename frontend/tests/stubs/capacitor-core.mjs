// @capacitor/core 桩：测试跑在桌面 Node 里，一律按非原生平台走。
export const Capacitor = {
  isNativePlatform: () => false,
  convertFileSrc: (u) => u,
};
export const CapacitorHttp = {
  request: async () => {
    throw new Error("CapacitorHttp 桩：测试里不走原生 HTTP");
  },
};
