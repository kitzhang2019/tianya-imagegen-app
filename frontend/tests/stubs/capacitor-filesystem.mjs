// @capacitor/filesystem 桩：测试不读写本机文件，用到就抛错（让调用方按失败处理）。
export const Directory = { Data: "DATA", Cache: "CACHE" };
export const Filesystem = {
  async readFile() {
    throw new Error("Filesystem 桩：测试里不读本机文件");
  },
  async writeFile() {
    throw new Error("Filesystem 桩：测试里不写本机文件");
  },
  async deleteFile() {},
  async getUri({ path }) {
    return { uri: `file:///stub/${path}` };
  },
  async copy() {},
};
