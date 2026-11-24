/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * Close to Tray for Linux - background script.
 *
 * All policy lives here: settings, unread counting (via the regular
 * messenger.accounts / messenger.folders APIs), rendering the tray icon and
 * wiring tray events to window actions. The two Experiment APIs used here
 * are deliberately "dumb" low-level bridges:
 *   - messenger.trayWindow  hide/show the main window, intercept its close
 *   - messenger.systemTray  StatusNotifierItem tray icon + context menu
 */

"use strict";

const DEFAULT_SETTINGS = {
  interceptClose: true,
  minimizeToTray: false,
  startInTray: false,
  showUnreadCount: true,
  // "inbox": only Inbox folders; "all": all folders except trash, junk,
  // sent, drafts, templates, archives and outbox.
  unreadScope: "inbox",
};

const EXCLUDED_FOLDER_USES = ["trash", "junk", "sent", "drafts", "templates", "archives", "outbox"];
const ICON_SIZES = [22, 32, 48, 64];
const UNREAD_RECOUNT_DELAY_MS = 500;

const state = {
  settings: { ...DEFAULT_SETTINGS },
  trayCreated: false,
  trayAvailable: false,
  windowHidden: false,
  unreadCount: 0,
  /** @type {Map<string, number>} unread count per counted folder id */
  folderUnread: new Map(),
  recountTimer: null,
  iconImage: null,
  renderedIconKey: null,
};

const i18n = (name, substitutions) => messenger.i18n.getMessage(name, substitutions);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function loadSettings() {
  const stored = await messenger.storage.local.get(DEFAULT_SETTINGS);
  state.settings = { ...DEFAULT_SETTINGS, ...stored };
}

async function applyWindowOptions() {
  // Never hide anything if there is no tray icon to bring the window back.
  await messenger.trayWindow.setOptions({
    interceptClose: state.settings.interceptClose && state.trayAvailable,
    minimizeToTray: state.settings.minimizeToTray && state.trayAvailable,
  });
}

// ---------------------------------------------------------------------------
// Unread counting
// ---------------------------------------------------------------------------

function isCountedFolder(folder) {
  if (!folder || folder.isVirtual || folder.isUnified || folder.isTag || folder.isRoot) {
    return false;
  }
  const uses = folder.specialUse || (folder.type ? [folder.type] : []);
  if (state.settings.unreadScope == "inbox") {
    return uses.includes("inbox");
  }
  return !uses.some(use => EXCLUDED_FOLDER_USES.includes(use));
}

function collectFolders(folders, out) {
  for (const folder of folders || []) {
    out.push(folder);
    collectFolders(folder.subFolders, out);
  }
  return out;
}

async function recountAllFolders() {
  const counts = new Map();
  const accounts = await messenger.accounts.list(true);
  for (const account of accounts) {
    const topLevel = account.rootFolder?.subFolders ?? account.folders ?? [];
    for (const folder of collectFolders(topLevel, [])) {
      if (!isCountedFolder(folder)) {
        continue;
      }
      try {
        const info = await messenger.folders.getFolderInfo(folder.id ?? folder);
        counts.set(folder.id ?? `${folder.accountId}:${folder.path}`, info.unreadMessageCount || 0);
      } catch (e) {
        // Folder may have disappeared meanwhile; ignore it.
      }
    }
  }
  state.folderUnread = counts;
  await setUnreadCount(sumCounts());
}

function sumCounts() {
  let total = 0;
  for (const count of state.folderUnread.values()) {
    total += count;
  }
  return total;
}

function scheduleRecount() {
  clearTimeout(state.recountTimer);
  state.recountTimer = setTimeout(() => {
    recountAllFolders().catch(console.error);
  }, UNREAD_RECOUNT_DELAY_MS);
}

function onFolderInfoChanged(folder, info) {
  if (info.unreadMessageCount === undefined || !isCountedFolder(folder)) {
    return;
  }
  const key = folder.id ?? `${folder.accountId}:${folder.path}`;
  state.folderUnread.set(key, info.unreadMessageCount);
  setUnreadCount(sumCounts()).catch(console.error);
}

async function setUnreadCount(count) {
  if (count == state.unreadCount && state.renderedIconKey !== null) {
    return;
  }
  state.unreadCount = count;
  await updateTray();
}

// ---------------------------------------------------------------------------
// Tray icon rendering
// ---------------------------------------------------------------------------

function loadIconImage() {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Cannot load tray icon"));
    image.src = messenger.runtime.getURL("icons/tray.svg");
  });
}

/** Encode RGBA bytes as base64 for transfer to the experiment. */
function toBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function renderIcon(size, count) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(state.iconImage, 0, 0, size, size);

  if (count > 0) {
    const text = count > 99 ? "99+" : String(count);
    // Badge in the bottom right corner, wide enough for the text.
    const height = Math.round(size * 0.56);
    ctx.font = `bold ${Math.round(height * 0.78)}px sans-serif`;
    const textWidth = ctx.measureText(text).width;
    const width = Math.min(size, Math.max(height, Math.ceil(textWidth + height * 0.4)));
    const x = size - width;
    const y = size - height;
    const radius = height / 2;

    ctx.fillStyle = "#d70022";
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + width / 2, y + height / 2 + height * 0.04, width);
  }

  const { data } = ctx.getImageData(0, 0, size, size);
  return { width: size, height: size, rgba: toBase64(data) };
}

async function updateTray() {
  if (!state.trayCreated) {
    return;
  }
  const badgeCount = state.settings.showUnreadCount ? state.unreadCount : 0;
  const key = String(badgeCount);
  if (key != state.renderedIconKey) {
    state.renderedIconKey = key;
    await messenger.systemTray.setIcon(ICON_SIZES.map(size => renderIcon(size, badgeCount)));
  }
  const description =
    state.unreadCount > 0 ? i18n("tooltipUnread", [String(state.unreadCount)]) : i18n("tooltipNoUnread");
  await messenger.systemTray.setToolTip(i18n("trayTitle"), description);
}

async function updateMenu() {
  await messenger.systemTray.setMenu([
    { id: "toggle", label: state.windowHidden ? i18n("menuShow") : i18n("menuHide") },
    { id: "separator-1", type: "separator" },
    { id: "compose", label: i18n("menuCompose") },
    { id: "options", label: i18n("menuOptions") },
    { id: "separator-2", type: "separator" },
    { id: "quit", label: i18n("menuQuit") },
  ]);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

async function onMenuItemClicked(id) {
  switch (id) {
    case "toggle":
      if (state.windowHidden) {
        await messenger.trayWindow.show();
      } else {
        await messenger.trayWindow.hide();
      }
      break;
    case "compose":
      await messenger.compose.beginNew();
      break;
    case "options":
      // The options page opens as a tab of the main window: show it first.
      await messenger.trayWindow.show();
      await messenger.runtime.openOptionsPage();
      break;
    case "quit":
      await messenger.trayWindow.quit();
      break;
  }
}

async function onTrayAvailabilityChanged(available) {
  state.trayAvailable = available;
  if (!available) {
    // The tray host went away: never leave the user without a window.
    await messenger.trayWindow.show();
  }
  await applyWindowOptions();
}

async function onVisibilityChanged(hidden) {
  state.windowHidden = hidden;
  await updateMenu();
}

async function onSettingsChanged(changes, area) {
  if (area != "local") {
    return;
  }
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in DEFAULT_SETTINGS) {
      state.settings[key] = newValue ?? DEFAULT_SETTINGS[key];
    }
  }
  await applyWindowOptions();
  if ("unreadScope" in changes) {
    await recountAllFolders();
  } else if ("showUnreadCount" in changes) {
    await updateTray();
  }
}

function onRuntimeMessage(message) {
  if (message?.type == "getStatus") {
    return messenger.trayWindow.getEnvironment().then(environment => ({
      trayAvailable: state.trayAvailable,
      environment,
    }));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function init() {
  await loadSettings();

  state.iconImage = await loadIconImage();
  state.trayAvailable = await messenger.systemTray.create({ title: i18n("trayTitle") });
  state.trayCreated = true;
  state.windowHidden = await messenger.trayWindow.isHidden();

  await updateMenu();
  await recountAllFolders();
  await updateTray();
  await applyWindowOptions();
}

// Listeners are registered synchronously so that no event is missed.
messenger.systemTray.onActivate.addListener(token => messenger.trayWindow.toggle(token));
messenger.systemTray.onSecondaryActivate.addListener(token => messenger.trayWindow.show(token));
messenger.systemTray.onMenuItemClicked.addListener(id => onMenuItemClicked(id).catch(console.error));
messenger.systemTray.onAvailabilityChanged.addListener(available =>
  onTrayAvailabilityChanged(available).catch(console.error)
);
messenger.trayWindow.onVisibilityChanged.addListener(hidden => onVisibilityChanged(hidden).catch(console.error));
messenger.storage.onChanged.addListener((changes, area) => onSettingsChanged(changes, area).catch(console.error));
messenger.runtime.onMessage.addListener(onRuntimeMessage);

messenger.folders.onFolderInfoChanged.addListener(onFolderInfoChanged);
for (const event of ["onCreated", "onDeleted", "onMoved", "onRenamed", "onUpdated"]) {
  messenger.folders[event]?.addListener(scheduleRecount);
}
for (const event of ["onCreated", "onDeleted"]) {
  messenger.accounts[event]?.addListener(scheduleRecount);
}

const initialized = init().catch(e => console.error("Close to Tray: initialization failed", e));

// Fired only when Thunderbird itself starts (not when the add-on is enabled).
messenger.runtime.onStartup.addListener(async () => {
  await initialized;
  if (state.settings.startInTray && state.trayAvailable) {
    await messenger.trayWindow.hide();
  }
});
