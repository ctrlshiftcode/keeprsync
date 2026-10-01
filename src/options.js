const connectButton = document.querySelector("#connect-drive");
const disconnectButton = document.querySelector("#disconnect-drive");
const createFileButton = document.querySelector("#create-file");
const refreshFilesButton = document.querySelector("#refresh-files");
const useFileButton = document.querySelector("#use-file");
const newFileName = document.querySelector("#new-file-name");
const existingFile = document.querySelector("#existing-file");
const syncStatus = document.querySelector("#sync-status");
const connectionMessage = document.querySelector("#connection-message");
const fileMessage = document.querySelector("#file-message");
const storagePanel = document.querySelector("#storage-panel");
const automaticSyncPanel = document.querySelector("#automatic-sync-panel");
const autoSyncEnabled = document.querySelector("#auto-sync-enabled");
const syncInterval = document.querySelector("#sync-interval");
const saveAutoSyncButton = document.querySelector("#save-auto-sync");
const autoSyncMessage = document.querySelector("#auto-sync-message");

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
const DRIVE_FOLDER_NAME = "KeeprSync";
let accessToken = null;

function assertDriveUrl(url) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "www.googleapis.com") {
    throw new Error("Blocked request to an untrusted Google API endpoint.");
  }
}

// Updates a status message and its visual error state.
function setMessage(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("error", isError);
}

// Retrieves and caches the OAuth token for the settings page using launchWebAuthFlow.
async function getDriveToken(interactive = true) {
  if (!chrome.identity) {
    throw new Error("Chrome Identity API is unavailable.");
  }

  const stored = await chrome.storage.local.get(["driveAccessToken", "driveTokenExpiresAt"]);
  if (stored.driveAccessToken && stored.driveTokenExpiresAt && Date.now() < stored.driveTokenExpiresAt - 60000) {
    accessToken = stored.driveAccessToken;
    return accessToken;
  }

  if (!interactive) {
    throw new Error("No active Google Drive session.");
  }

  const manifest = chrome.runtime.getManifest();
  const clientId = manifest?.oauth2?.client_id;
  const scopes = manifest?.oauth2?.scopes?.join(" ") || "https://www.googleapis.com/auth/drive.file";
  const redirectUri = chrome.identity.getRedirectURL();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("prompt", "consent");

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true
  });

  if (!responseUrl) {
    throw new Error("Google authentication was cancelled.");
  }

  const hashParams = new URLSearchParams(new URL(responseUrl).hash.substring(1));
  const token = hashParams.get("access_token");
  if (!token) {
    const errorDesc = hashParams.get("error_description") || hashParams.get("error") || "Authentication failed.";
    throw new Error(errorDesc);
  }

  const expiresInSeconds = Number.parseInt(hashParams.get("expires_in") || "3600", 10);
  const expiresAt = Date.now() + (expiresInSeconds * 1000);

  accessToken = token;
  await chrome.storage.local.set({
    driveAccessToken: token,
    driveTokenExpiresAt: expiresAt
  });

  return accessToken;
}

// Sends an authenticated request to Google Drive.
async function driveRequest(url, options = {}) {
  assertDriveUrl(url);
  const token = accessToken || await getDriveToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers
    }
  });

  if (!response.ok) {
    throw new Error(`Google Drive returned ${response.status}.`);
  }

  return response.json();
}

// Finds or creates the KeeprSync folder in the user's Drive.
async function findDriveFolder(createIfMissing = false) {
  const query = encodeURIComponent(
    `name = '${DRIVE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  const fields = encodeURIComponent("files(id,name)");
  const data = await driveRequest(`${DRIVE_FILES_URL}?q=${query}&spaces=drive&fields=${fields}&pageSize=10`);

  if (!Array.isArray(data.files)) {
    throw new Error("Google Drive returned an invalid folder list.");
  }

  if (data.files.length) {
    return data.files[0];
  }

  if (!createIfMissing) {
    return null;
  }

  return driveRequest(DRIVE_FILES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: DRIVE_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder"
    })
  });
}

// Loads JSON bookmark files from the KeeprSync Drive folder.
async function loadDriveFiles() {
  const settings = await chrome.storage.local.get(["driveFileId"]);
  const driveFolder = await findDriveFolder();
  existingFile.replaceChildren();

  if (!driveFolder) {
    existingFile.add(new Option("No files found", ""));
    return;
  }

  const query = encodeURIComponent(
    `'${driveFolder.id}' in parents and trashed = false and mimeType = 'application/json'`
  );
  const fields = encodeURIComponent("files(id,name,modifiedTime,size)");
  const data = await driveRequest(`${DRIVE_FILES_URL}?q=${query}&spaces=drive&fields=${fields}&orderBy=modifiedTime desc`);

  if (!Array.isArray(data.files)) {
    throw new Error("Google Drive returned an invalid file list.");
  }

  if (!data.files.length) {
    existingFile.add(new Option("No files found", ""));
    return;
  }

  data.files.forEach((file) => {
    const option = new Option(`${file.name} (${new Date(file.modifiedTime).toLocaleDateString()})`, file.id);
    existingFile.add(option);
  });

  if (!settings.driveFileId && data.files.length === 1) {
    const [onlyFile] = data.files;
    existingFile.value = onlyFile.id;
    await selectFile(onlyFile.id);
    setMessage(fileMessage, "The only available bookmark file was selected automatically.");
  }
}

// Creates an empty bookmark document inside the KeeprSync folder.
async function createDriveFile() {
  const driveFolder = await findDriveFolder(true);
  const name = (newFileName.value || "")
    .trim()
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .slice(0, 255) || "keeprsync-bookmarks.json";
  const boundary = `keeprsync-${Date.now()}`;
  const metadata = JSON.stringify({
    name,
    mimeType: "application/json",
    parents: [driveFolder.id]
  });
  const content = JSON.stringify({ version: 1, bookmarks: [] }, null, 2);
  const body = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n`,
    `--${boundary}--`
  ].join("");

  return driveRequest(DRIVE_UPLOAD_URL, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body
  });
}

// Persists the selected Drive file as the active synchronization target.
async function selectFile(fileId) {
  if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > 256) {
    throw new Error("The selected Drive file ID is invalid.");
  }
  await chrome.storage.local.set({ driveFileId: fileId, lastSyncStatus: "configured" });
  syncStatus.textContent = "Google Drive connected - bookmark file configured";
  automaticSyncPanel.hidden = false;
  setMessage(fileMessage, "Bookmark storage selected.");
}

// Clears local authentication and synchronization metadata without deleting Drive data.
async function disconnectDrive() {
  accessToken = null;
  await chrome.storage.local.remove([
    "driveFileId",
    "driveAccessToken",
    "driveTokenExpiresAt",
    "lastSyncedBookmarks",
    "lastSyncAt",
    "lastSyncStatus",
    "autoSyncEnabled"
  ]);
  await chrome.runtime.sendMessage({ type: "clear-drive-token" });
  await chrome.runtime.sendMessage({ type: "update-auto-sync" });

  storagePanel.hidden = true;
  automaticSyncPanel.hidden = true;
  disconnectButton.hidden = true;
  connectButton.hidden = false;
  connectButton.textContent = "Connect Google Drive";
  syncStatus.textContent = "No account connected";
  existingFile.replaceChildren(new Option("No files found", ""));
  setMessage(connectionMessage, "Google Drive disconnected.");
  setMessage(fileMessage, "");
}

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  setMessage(connectionMessage, "Connecting to Google Drive...");

  try {
    await getDriveToken(true);
    storagePanel.hidden = false;
    automaticSyncPanel.hidden = false;
    connectButton.textContent = "Reconnect Google Drive";
    connectButton.hidden = false;
    disconnectButton.hidden = false;
    syncStatus.textContent = "Google Drive connected";
    setMessage(connectionMessage, "Connection successful.");
    await loadDriveFiles();
    const autoSettings = await chrome.storage.local.get(["autoSyncEnabled", "autoSyncInterval", "autoSyncIntervalUnit"]);
    autoSyncEnabled.checked = autoSettings.autoSyncEnabled === true;
    syncInterval.value = autoSettings.autoSyncIntervalUnit === "seconds"
      ? `${autoSettings.autoSyncInterval || 5}s`
      : `${autoSettings.autoSyncInterval || 5}m`;
  } catch (error) {
    const detail = error?.message ? ` (${error.message} | Extension ID: ${chrome.runtime?.id || "unknown"})` : "";
    setMessage(connectionMessage, `Unable to connect. Configure a valid Google OAuth Client ID in manifest.json.${detail}`, true);
  } finally {
    connectButton.disabled = false;
  }
});

disconnectButton.addEventListener("click", async () => {
  disconnectButton.disabled = true;
  setMessage(connectionMessage, "Disconnecting Google Drive...");

  try {
    await disconnectDrive();
  } catch (error) {
    setMessage(connectionMessage, "Unable to disconnect Google Drive.", true);
  } finally {
    disconnectButton.disabled = false;
  }
});

createFileButton.addEventListener("click", async () => {
  createFileButton.disabled = true;
  setMessage(fileMessage, "Creating bookmark file...");

  try {
    const file = await createDriveFile();
    await selectFile(file.id);
    await loadDriveFiles();
  } catch (error) {
    setMessage(fileMessage, error.message, true);
  } finally {
    createFileButton.disabled = false;
  }
});

refreshFilesButton.addEventListener("click", async () => {
  try {
    await loadDriveFiles();
    setMessage(fileMessage, "File list refreshed.");
  } catch (error) {
    setMessage(fileMessage, error.message, true);
  }
});

useFileButton.addEventListener("click", async () => {
  if (!existingFile.value) {
    setMessage(fileMessage, "Select a file first.", true);
    return;
  }

  await selectFile(existingFile.value);
});

saveAutoSyncButton.addEventListener("click", async () => {
  saveAutoSyncButton.disabled = true;
  setMessage(autoSyncMessage, "Saving automatic synchronization settings...");

  try {
    await chrome.storage.local.set({
      autoSyncEnabled: autoSyncEnabled.checked,
      autoSyncInterval: Number.parseInt(syncInterval.value, 10),
      autoSyncIntervalUnit: syncInterval.value.endsWith("s") ? "seconds" : "minutes"
    });
    const response = await chrome.runtime.sendMessage({ type: "update-auto-sync" });
    if (!response?.ok) {
      throw new Error(response?.error || "Unable to update the automatic synchronization alarm.");
    }
    setMessage(
      autoSyncMessage,
      autoSyncEnabled.checked
        ? `Automatic synchronization enabled every ${syncInterval.options[syncInterval.selectedIndex].text}.`
        : "Automatic synchronization disabled."
    );
  } catch (error) {
    setMessage(autoSyncMessage, "Unable to save automatic synchronization settings.", true);
  } finally {
    saveAutoSyncButton.disabled = false;
  }
});

// Restores the saved connection, file, and automatic sync settings on load.
async function initializeSettings() {
  const settings = await chrome.storage.local.get(["driveFileId"]);

  try {
    await getDriveToken(false);
    storagePanel.hidden = false;
    automaticSyncPanel.hidden = false;
    connectButton.textContent = "Reconnect Google Drive";
    connectButton.hidden = false;
    disconnectButton.hidden = false;
    syncStatus.textContent = settings.driveFileId
      ? "Google Drive connected - bookmark file configured"
      : "Google Drive connected - choose a bookmark file";
    await loadDriveFiles();

    const autoSettings = await chrome.storage.local.get(["autoSyncEnabled", "autoSyncInterval", "autoSyncIntervalUnit"]);
    autoSyncEnabled.checked = autoSettings.autoSyncEnabled === true;
    syncInterval.value = autoSettings.autoSyncIntervalUnit === "seconds"
      ? `${autoSettings.autoSyncInterval || 5}s`
      : `${autoSettings.autoSyncInterval || 5}m`;

    if (settings.driveFileId) {
      existingFile.value = settings.driveFileId;
      if (existingFile.value !== settings.driveFileId) {
        setMessage(fileMessage, "The configured Drive file is no longer available.", true);
      }
    }
  } catch (error) {
    storagePanel.hidden = true;
    automaticSyncPanel.hidden = true;
    connectButton.textContent = "Connect Google Drive";
    connectButton.hidden = false;
    disconnectButton.hidden = true;
    syncStatus.textContent = "No account connected";
  }
}

initializeSettings();
