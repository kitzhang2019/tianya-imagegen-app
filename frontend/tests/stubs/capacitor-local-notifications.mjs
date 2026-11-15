// @capacitor/local-notifications 桩：通知全部空转。
export const LocalNotifications = {
  async schedule() {},
  async requestPermissions() {
    return { display: "granted" };
  },
};
