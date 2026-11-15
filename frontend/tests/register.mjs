// tests/register.mjs — 单元测试入口：先注册 resolve hook，把 @capacitor/*
// 指向 tests/stubs 下的桩模块，再跑测试文件。
// 用法：node --import ./tests/register.mjs --test tests/
// （或 npm test；mock.module 在此 Node 构建里不可用，改用 module.register。）
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
