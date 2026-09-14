import { getLocalBookmarkCount } from "./sync-service.js";

const bookmarkCount = document.querySelector("#bookmark-count");
const openOptionsButton = document.querySelector("#open-options");
const syncButton = document.querySelector("#sync-bookmarks");
const syncResult = document.querySelector("#sync-result");
const statusLabel = document.querySelector("#sync-status");
const statusDot = document.querySelector(".status-dot");
let syncResultTimer = null;

syncButton.disabled = true;

// Updates the compact synchronization status shown in the popup.
function setSyncState(label, result = "", state = "") {
  statusLabel.textContent = label;
  syncResult.textContent = result;
  statusDot.classList.toggle("is-current", state === "current");
  statusDot.classList.toggle("is-error", state === "error");
}

// Clears transient synchronization details without resetting the main status.
function clearSyncResultLater() {
  if (syncResultTimer) {
    clearTimeout(syncResultTimer);
  }
  syncResultTimer = setTimeout(() => {
    syncResult.textContent = "";
  }, 5000);
}

// Refreshes only the local bookmark count displayed by the popup.
async function loadBookmarks() {
  const count = await getLocalBookmarkCount();
  bookmarkCount.textContent = `${count} local bookmark(s)`;
}

openOptionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
syncButton.addEventListener("click", async () => {
  syncButton.disabled = true;
  setSyncState("Synchronizing...", "", "");

  try {
    const response = await chrome.runtime.sendMessage({ type: "sync-now" });
    if (!response?.ok) {
      throw new Error(response?.error || "Synchronization failed.");
    }
    const mergedCount = response.count;
    await loadBookmarks();
    setSyncState("Up to date", `${mergedCount} folder/bookmark item(s) synced`, "current");
    clearSyncResultLater();
  } catch (error) {
    setSyncState("Synchronization failed", error.message, "error");
    clearSyncResultLater();
  } finally {
    syncButton.disabled = false;
  }
});

loadBookmarks().catch(() => {
  bookmarkCount.textContent = "Unable to load bookmarks";
  setSyncState("Unable to load bookmarks", "Check the extension's bookmark permission.", "error");
});

chrome.storage.local.get(["driveFileId", "lastSyncAt"], (settings) => {
  if (settings.driveFileId) {
    syncButton.disabled = false;
    const result = settings.lastSyncAt
      ? `Last sync: ${new Date(settings.lastSyncAt).toLocaleString()}`
      : "Drive file configured";
    setSyncState("Ready to sync", result);
  } else {
    setSyncState("Synchronization not configured", "Choose a Drive file in Settings");
  }
});
