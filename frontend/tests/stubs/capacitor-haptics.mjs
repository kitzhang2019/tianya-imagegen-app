// @capacitor/haptics 桩：震动调用记下来供测试断言，不碰真机。
// NotificationType 的值与真包一致（大写，iOS/Android 原生代码只认大写）。
export const hapticCalls = [];

export const NotificationType = {
  Success: "SUCCESS",
  Warning: "WARNING",
  Error: "ERROR",
};

export const Haptics = {
  async notification(opts) {
    hapticCalls.push({ kind: "notification", ...(opts || {}) });
  },
  async vibrate(opts) {
    hapticCalls.push({ kind: "vibrate", ...(opts || {}) });
  },
  async impact(opts) {
    hapticCalls.push({ kind: "impact", ...(opts || {}) });
  },
};

export function __resetHaptics() {
  hapticCalls.length = 0;
}
