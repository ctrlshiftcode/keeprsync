const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const MAX_BOOKMARK_NODES = 10000;
const MAX_BOOKMARK_DEPTH = 30;
const MAX_TITLE_LENGTH = 1000;
const MAX_URL_LENGTH = 8192;

let accessToken = null;

function assertDriveUrl(url) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "www.googleapis.com") {
    throw new Error("Blocked request to an untrusted Google API endpoint.");
  }
}

// Builds the Google favicon endpoint used as bookmark metadata.
function getFaviconUrl(url) {
  return `https://www.google.com/s2/favicons?sz=32&domain_url=${encodeURIComponent(url)}`;
}

// Converts Chrome bookmark nodes into the portable Drive JSON shape.
function normalizeNode(node) {
  return {
    title: node.title || "",
    ...(node.url ? { url: node.url, faviconUrl: getFaviconUrl(node.url) } : {}),
    ...(node.children ? { children: node.children.map(normalizeNode) } : {})
  };
}

// Adds favicon metadata to imported records without overwriting existing values.
function addFaviconMetadata(nodes) {
  return nodes.map((node) => ({
    ...node,
    ...(node.url && !node.faviconUrl ? { faviconUrl: getFaviconUrl(node.url) } : {}),
    ...(node.children ? { children: addFaviconMetadata(node.children) } : {})
  }));
}

function sanitizeRemoteNodes(nodes, depth = 0, state = { count: 0 }) {
  if (!Array.isArray(nodes) || depth > MAX_BOOKMARK_DEPTH) {
    throw new Error("The Drive bookmark file has an invalid structure.");
  }

  return nodes.map((node) => {
    state.count += 1;
    if (state.count > MAX_BOOKMARK_NODES || !node || typeof node !== "object") {
      throw new Error("The Drive bookmark file exceeds the allowed limits.");
    }

    const title = typeof node.title === "string" ? node.title.slice(0, MAX_TITLE_LENGTH) : "";
    if (node.url !== undefined) {
      if (typeof node.url !== "string" || node.url.length > MAX_URL_LENGTH) {
        throw new Error("The Drive bookmark file contains an invalid URL.");
      }

      const bookmarkUrl = new URL(node.url);
      if (!["http:", "https:"].includes(bookmarkUrl.protocol)) {
        throw new Error("The Drive bookmark file contains an unsupported URL scheme.");
      }

      return { title, url: node.url, faviconUrl: getFaviconUrl(node.url) };
    }

    if (node.children !== undefined && !Array.isArray(node.children)) {
      throw new Error("The Drive bookmark file contains an invalid folder.");
    }

    return {
      title,
      ...(node.children ? { children: sanitizeRemoteNodes(node.children, depth + 1, state) } : {})
    };
  });
}

// Returns the folder path used to distinguish same-named folders.
function nodePath(node, parentPath = []) {
  return node.url ? parentPath : [...parentPath, (node.title || "").trim().toLocaleLowerCase()];
}

// Creates a stable identity for a bookmark or its folder path.
function nodeKey(node, parentPath = []) {
  return node.url ? `bookmark:${node.url}` : `folder:${JSON.stringify(nodePath(node, parentPath))}`;
}

// Collects identities recursively for deletion detection.
function collectNodeKeys(nodes, keys = new Set(), parentPath = []) {
  nodes.forEach((node) => {
    keys.add(nodeKey(node, parentPath));
    if (node.children) {
      collectNodeKeys(node.children, keys, nodePath(node, parentPath));
    }
  });
  return keys;
}

// Finds records removed on either side since the previous snapshot.
function findDeletedKeys(previousNodes, localNodes, remoteNodes) {
  const previousKeys = collectNodeKeys(previousNodes);
  const localKeys = collectNodeKeys(localNodes);
  const remoteKeys = collectNodeKeys(remoteNodes);
  return new Set([...previousKeys].filter((key) => {
    return (!localKeys.has(key) && remoteKeys.has(key)) || (!remoteKeys.has(key) && localKeys.has(key));
  }));
}

function collectOrderSignatures(nodes, signatures = new Map(), parentPath = []) {
  const parentKey = `folder:${JSON.stringify(parentPath)}`;
  signatures.set(parentKey, nodes.map((node) => nodeKey(node, parentPath)));
  nodes.forEach((node) => {
    if (node.children) {
      collectOrderSignatures(node.children, signatures, nodePath(node, parentPath));
    }
  });
  return signatures;
}

function hasOrderChanged(previousNodes, currentNodes) {
  const previousSignatures = collectOrderSignatures(previousNodes);
  const currentSignatures = collectOrderSignatures(currentNodes);
  const keys = new Set([...previousSignatures.keys(), ...currentSignatures.keys()]);

  return [...keys].some((key) => {
    return JSON.stringify(previousSignatures.get(key) || []) !== JSON.stringify(currentSignatures.get(key) || []);
  });
}

// Merges trees and applies the selected order to every folder level.
function mergeNodes(localNodes, remoteNodes, deletedKeys = new Set(), parentPath = [], preferRemoteOrder = true) {
  const mergedNodes = new Map();
  const addNode = (node) => {
    const key = nodeKey(node, parentPath);
    if (!deletedKeys.has(key) && !mergedNodes.has(key)) {
      mergedNodes.set(key, { ...node, ...(node.children ? { children: [...node.children] } : {}) });
    }
  };

  localNodes.forEach(addNode);

  remoteNodes.forEach((remoteNode) => {
    const key = nodeKey(remoteNode, parentPath);
    if (deletedKeys.has(key)) {
      return;
    }

    if (!mergedNodes.has(key)) {
      addNode(remoteNode);
      return;
    }

    const existingNode = mergedNodes.get(key);
    if (existingNode.children && remoteNode.children) {
      existingNode.children = mergeNodes(
        existingNode.children,
        remoteNode.children,
        deletedKeys,
        nodePath(existingNode, parentPath),
        preferRemoteOrder
      );
    }
  });

  const preferredNodes = preferRemoteOrder ? remoteNodes : localNodes;
  const orderedKeys = preferredNodes
    .map((node) => nodeKey(node, parentPath))
    .filter((key) => mergedNodes.has(key));
  const remainingKeys = [...mergedNodes.keys()].filter((key) => !orderedKeys.includes(key));
  return [...orderedKeys, ...remainingKeys].map((key) => mergedNodes.get(key));
}

// Locates the browser's bookmarks bar across supported localized titles.
function findBookmarkBar(tree) {
  const titles = new Set([
    "bookmarks bar", "bookmarks toolbar", "barra de favoritos", "barra de marcadores",
    "favorites bar", "barre de favoris", "barra dei preferiti", "les signets"
  ]);
  let titleMatch = null;

  function visit(nodes) {
    for (const node of nodes) {
      if (String(node.id) === "1") {
        return node;
      }
      if (!titleMatch && titles.has((node.title || "").trim().toLocaleLowerCase())) {
        titleMatch = node;
      }
      if (node.children) {
        const match = visit(node.children);
        if (match) {
          return match;
        }
      }
    }
    return null;
  }

  return visit(tree) || titleMatch;
}

// Counts bookmark URLs in the complete Chrome bookmark tree.
function flattenBookmarks(nodes) {
  return nodes.flatMap((node) => {
    const children = node.children ? flattenBookmarks(node.children) : [];
    return node.url ? [node, ...children] : children;
  });
}

// Retrieves an OAuth token for interactive or background use.
async function getDriveToken(interactive) {
  const result = await chrome.identity.getAuthToken({ interactive });
  if (!result?.token || typeof result.token !== "string") {
    throw new Error("Google did not return a valid access token.");
  }
  accessToken = result.token;
  return accessToken;
}

// Clears the in-memory token when the user disconnects the account.
export function clearDriveToken() {
  accessToken = null;
}

// Sends an authenticated request to the Google Drive API.
async function driveRequest(url, options = {}, interactive = true) {
  assertDriveUrl(url);
  const token = accessToken || await getDriveToken(interactive);
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers }
  });

  if (!response.ok) {
    throw new Error(`Google Drive returned ${response.status}.`);
  }

  return response.status === 204 ? null : response.json();
}

// Reads the synchronized bookmark document from Drive.
async function readDriveBookmarks(fileId, interactive = true) {
  const response = await driveRequest(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`, {}, interactive);
  return sanitizeRemoteNodes(response?.bookmarks || []);
}

// Commits the merged bookmark document to Drive.
async function writeDriveBookmarks(fileId, bookmarks, interactive = true) {
  return driveRequest(`${DRIVE_UPLOAD_URL}/${encodeURIComponent(fileId)}?uploadType=media`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), bookmarks }, null, 2)
  }, interactive);
}

// Recreates a Chrome bookmark subtree from the synchronized JSON node.
async function createChromeNode(node, parentId) {
  const createdNode = await chrome.bookmarks.create({
    parentId,
    title: node.title,
    ...(node.url ? { url: node.url } : {})
  });

  for (const childNode of node.children || []) {
    await createChromeNode(childNode, createdNode.id);
  }
}

// Applies the committed tree to the Chrome bookmarks bar.
async function replaceBookmarkBar(bookmarkBar, bookmarks) {
  for (const childNode of bookmarkBar.children || []) {
    await chrome.bookmarks.removeTree(childNode.id);
  }
  for (const bookmarkNode of bookmarks) {
    await createChromeNode(bookmarkNode, bookmarkBar.id);
  }
}

// Returns the current number of bookmark URLs for the popup status.
export async function getLocalBookmarkCount() {
  const tree = await chrome.bookmarks.getTree();
  return flattenBookmarks(tree).length;
}

// Merges local and Drive bookmarks, commits Drive first, then updates Chrome.
export async function synchronizeBookmarks({ interactive = true } = {}) {
  const settings = await chrome.storage.local.get(["driveFileId", "lastSyncedBookmarks"]);
  if (typeof settings.driveFileId !== "string" || settings.driveFileId.length === 0 || settings.driveFileId.length > 256) {
    throw new Error("No Google Drive bookmark file configured.");
  }

  const tree = await chrome.bookmarks.getTree();
  const bookmarkBar = findBookmarkBar(tree);
  if (!bookmarkBar) {
    throw new Error("The Bookmarks bar could not be found.");
  }

  const localBookmarks = (bookmarkBar.children || []).map(normalizeNode);
  const remoteBookmarks = await readDriveBookmarks(settings.driveFileId, interactive);
  const hasPreviousSnapshot = Array.isArray(settings.lastSyncedBookmarks);
  let mergedBookmarks;

  if (!hasPreviousSnapshot && localBookmarks.length === 0) {
    mergedBookmarks = addFaviconMetadata(remoteBookmarks);
  } else if (!hasPreviousSnapshot && remoteBookmarks.length === 0) {
    mergedBookmarks = addFaviconMetadata(localBookmarks);
  } else {
    const deletedKeys = hasPreviousSnapshot
      ? findDeletedKeys(settings.lastSyncedBookmarks, localBookmarks, remoteBookmarks)
      : new Set();
    const localOrderChanged = hasPreviousSnapshot && hasOrderChanged(settings.lastSyncedBookmarks, localBookmarks);
    const remoteOrderChanged = hasPreviousSnapshot && hasOrderChanged(settings.lastSyncedBookmarks, remoteBookmarks);
    const preferRemoteOrder = !localOrderChanged || remoteOrderChanged;
    mergedBookmarks = addFaviconMetadata(
      mergeNodes(localBookmarks, remoteBookmarks, deletedKeys, [], preferRemoteOrder)
    );
  }

  // Commit to Drive first. The local tree is changed only after the remote commit succeeds.
  await writeDriveBookmarks(settings.driveFileId, mergedBookmarks, interactive);
  await replaceBookmarkBar(bookmarkBar, mergedBookmarks);
  await chrome.storage.local.set({
    lastSyncStatus: "up-to-date",
    lastSyncAt: new Date().toISOString(),
    lastSyncedBookmarks: mergedBookmarks
  });

  return mergedBookmarks.length;
}
