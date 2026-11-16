// @capacitor/filesystem 桩：内存文件表代替本机文件（测试可预置/复位）。
// writeFile 存进表里，readFile 从表里读（没有就抛错，保持旧行为），
// deleteFile 从表里删并记进 __deletedFiles（供 saveJobs 截断删文件测试断言）。
const files = new Map();
export const __deletedFiles = [];
export const Directory = { Data: "DATA", Cache: "CACHE" };
export const Filesystem = {
  async readFile({ path }) {
    if (!files.has(path)) throw new Error("Filesystem 桩：测试里不读本机文件");
    return { data: files.get(path) };
  },
  async writeFile({ path, data }) {
    files.set(path, data);
  },
  async deleteFile({ path }) {
    __deletedFiles.push(path);
    files.delete(path);
  },
  async getUri({ path }) {
    return { uri: `file:///stub/${path}` };
  },
  async copy() {},
};

// 测试专用：清空内存文件表与删除记录。
export function __resetFiles() {
  files.clear();
  __deletedFiles.length = 0;
}
