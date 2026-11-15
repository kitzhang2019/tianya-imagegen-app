// LiveActivities 桩：锁屏常驻活动全部空转（测试按非原生平台走，本来也不会调到这里）。
export const LiveActivities = {
  async isSupported() {
    return { supported: false };
  },
  async start() {
    return { activityId: "stub" };
  },
  async update() {},
  async end() {},
};
