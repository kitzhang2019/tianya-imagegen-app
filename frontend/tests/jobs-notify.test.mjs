// tests/jobs-notify.test.mjs — 出图完成提醒：通知带声音 + 震动 + 设置开关。
// 跑法：npm test。LocalNotifications / Haptics 走桩，调用记下来断言；
// Capacitor 桩默认是非原生平台，测试里先把 isNativePlatform 翻成 true。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Capacitor } from "@capacitor/core";
import { __seedStore, __resetStore } from "./stubs/capacitor-preferences.mjs";
import {
  LocalNotifications,
  scheduleCalls,
  __resetNotifications,
} from "./stubs/capacitor-local-notifications.mjs";
import {
  Haptics,
  hapticCalls,
  __resetHaptics,
} from "./stubs/capacitor-haptics.mjs";

// 先翻成原生平台再动态引 jobs.js（静态 import 会先于翻转执行）。
const realIsNative = Capacitor.isNativePlatform;
Capacitor.isNativePlatform = () => true;
const { getSettings, saveSettings, initJobs, stopPolling, notifyJob } = await import(
  "../src/lib/jobs.js"
);

after(() => {
  Capacitor.isNativePlatform = realIsNative;
  stopPolling();
  __resetStore();
  __resetNotifications();
  __resetHaptics();
});

const job = { id: 7, model: "moss" };

async function resetAll() {
  __resetNotifications();
  __resetHaptics();
  await saveSettings({
    kaggleUsername: "",
    kaggleToken: "",
    galleryKey: "",
    galleryUrl: "",
    notifyOnDone: true,
  });
}

test("完成：通知带 sound default + 成功震动", async () => {
  await resetAll();
  await notifyJob(job, true);
  assert.equal(scheduleCalls.length, 1);
  const n = scheduleCalls[0].notifications[0];
  assert.equal(n.title, "出图完成");
  assert.equal(n.sound, "default");
  assert.equal(hapticCalls.length, 1);
  assert.equal(hapticCalls[0].kind, "notification");
  assert.equal(hapticCalls[0].type, "SUCCESS");
});

test("失败：通知带 sound default + 失败震动（大写 ERROR）", async () => {
  await resetAll();
  await notifyJob(job, false);
  assert.equal(scheduleCalls.length, 1);
  const n = scheduleCalls[0].notifications[0];
  assert.equal(n.title, "生成失败");
  assert.equal(n.sound, "default");
  assert.equal(hapticCalls.length, 1);
  assert.equal(hapticCalls[0].type, "ERROR");
});

test("开关关了：不发通知也不震动", async () => {
  await resetAll();
  await saveSettings({ notifyOnDone: false });
  await notifyJob(job, true);
  await notifyJob(job, false);
  assert.equal(scheduleCalls.length, 0);
  assert.equal(hapticCalls.length, 0);
});

test("通知抛错也不影响震动", async () => {
  await resetAll();
  const orig = LocalNotifications.schedule;
  LocalNotifications.schedule = async () => {
    throw new Error("通知被系统拒绝");
  };
  try {
    await notifyJob(job, true);
  } finally {
    LocalNotifications.schedule = orig;
  }
  assert.equal(hapticCalls.length, 1);
  assert.equal(hapticCalls[0].type, "SUCCESS");
});

test("notification 震动抛错时走 vibrate 兜底", async () => {
  await resetAll();
  const orig = Haptics.notification;
  Haptics.notification = async () => {
    throw new Error("该设备不支持 notification 震动");
  };
  try {
    await notifyJob(job, true);
  } finally {
    Haptics.notification = orig;
  }
  assert.equal(hapticCalls.length, 1);
  assert.equal(hapticCalls[0].kind, "vibrate");
});

test("saveSettings 只传开关时不丢账号", async () => {
  await resetAll();
  await saveSettings({
    kaggleUsername: "kitzhang2019",
    kaggleToken: "KGAT_test",
    galleryKey: "key123",
    galleryUrl: "https://example.com/upload.php",
    notifyOnDone: true,
  });
  await saveSettings({ notifyOnDone: false });
  const s = getSettings();
  assert.equal(s.kaggleUsername, "kitzhang2019");
  assert.equal(s.kaggleToken, "KGAT_test");
  assert.equal(s.galleryKey, "key123");
  assert.equal(s.galleryUrl, "https://example.com/upload.php");
  assert.equal(s.notifyOnDone, false);
});

test("老设置里没有 notifyOnDone 字段时默认开", async () => {
  __resetStore();
  __seedStore({
    "tianya-imagegen-settings": JSON.stringify({
      kaggleUsername: "kitzhang2019",
      kaggleToken: "",
      galleryKey: "",
      galleryUrl: "",
    }),
  });
  await initJobs();
  stopPolling();
  assert.equal(getSettings().notifyOnDone, true);
});

test("非原生平台不提醒", async () => {
  await resetAll();
  Capacitor.isNativePlatform = () => false;
  try {
    await notifyJob(job, true);
  } finally {
    Capacitor.isNativePlatform = () => true;
  }
  assert.equal(scheduleCalls.length, 0);
  assert.equal(hapticCalls.length, 0);
});
