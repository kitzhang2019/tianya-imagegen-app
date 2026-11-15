// @capacitor/preferences 桩：内存 Map 代替本机 Preferences；测试可预置/复位。
const store = new Map();

export const Preferences = {
  async get({ key }) {
    const value = store.has(key) ? store.get(key) : null;
    return { value };
  },
  async set({ key, value }) {
    store.set(key, value);
  },
  async remove({ key }) {
    store.delete(key);
  },
};

// 测试专用：预置/读取/清空整张表（jobs.js 不用这些导出）。
export function __seedStore(entries) {
  for (const [k, v] of Object.entries(entries)) store.set(k, v);
}
export function __readStore(key) {
  return store.has(key) ? store.get(key) : null;
}
export function __resetStore() {
  store.clear();
}
