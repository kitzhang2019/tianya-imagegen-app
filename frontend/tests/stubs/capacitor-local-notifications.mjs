// @capacitor/local-notifications 桩：通知全部空转，schedule 的调用记下来供测试断言。
export const scheduleCalls = [];

export const LocalNotifications = {
  async schedule(opts) {
    scheduleCalls.push(opts);
  },
  async requestPermissions() {
    return { display: "granted" };
  },
};

export function __resetNotifications() {
  scheduleCalls.length = 0;
}
