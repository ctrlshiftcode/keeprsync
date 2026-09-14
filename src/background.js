import { clearDriveToken, synchronizeBookmarks } from "./sync-service.js";

const AUTO_SYNC_ALARM = "keeprsync-automatic-sync";
let synchronizationRunning = false;

// Shows a result notification and removes it automatically after five seconds.
async function notify(title, message) {
  try {
    const notificationId = await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message
    });

    setTimeout(() => {
      chrome.notifications.clear(notificationId).catch(() => undefined);
    }, 5000);
  } catch {
    // Notification failures must not become unhandled background errors.
  }
}

// Runs the scheduled synchronization and reports its result.
async function runAutomaticSync() {
  try {
    const count = await executeSync(false);
    await notify("KeeprSync", `${count} folder/bookmark item(s) synchronized.`);
  } catch (error) {
    await notify("KeeprSync synchronization failed", error.message);
  }
}

// Serializes manual and automatic synchronization through one lock.
async function executeSync(interactive) {
  if (synchronizationRunning) {
    throw new Error("Another synchronization is already running.");
  }

  synchronizationRunning = true;
  try {
    return await synchronizeBookmarks({ interactive });
  } finally {
    synchronizationRunning = false;
  }
}

// Recreates the alarm using the currently saved interval settings.
async function updateAutomaticSync() {
  const settings = await chrome.storage.local.get(["autoSyncEnabled", "autoSyncInterval", "autoSyncIntervalUnit"]);
  await chrome.alarms.clear(AUTO_SYNC_ALARM);

  if (settings.autoSyncEnabled && settings.autoSyncInterval) {
    const requestedMinutes = settings.autoSyncIntervalUnit === "seconds"
      ? Number(settings.autoSyncInterval) / 60
      : Number(settings.autoSyncInterval);
    const periodInMinutes = Math.max(requestedMinutes, 0.5);
    await chrome.alarms.create(AUTO_SYNC_ALARM, { periodInMinutes });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await chrome.storage.local.get([
    "lastSyncStatus",
    "autoSyncEnabled",
    "autoSyncInterval",
    "autoSyncIntervalUnit"
  ]);
  await chrome.storage.local.set({
    lastSyncStatus: settings.lastSyncStatus || "not-configured",
    autoSyncEnabled: settings.autoSyncEnabled === true,
    autoSyncInterval: settings.autoSyncInterval || 5,
    autoSyncIntervalUnit: settings.autoSyncIntervalUnit || "minutes"
  });
  await updateAutomaticSync();
});

chrome.runtime.onStartup.addListener(updateAutomaticSync);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "clear-drive-token") {
    clearDriveToken();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "sync-now") {
    executeSync(true)
      .then((count) => sendResponse({ ok: true, count }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type !== "update-auto-sync") {
    return false;
  }

  updateAutomaticSync()
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_SYNC_ALARM) {
    runAutomaticSync();
  }
});
