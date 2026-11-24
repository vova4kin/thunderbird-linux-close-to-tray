/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

// Must match DEFAULT_SETTINGS in background.js.
const DEFAULTS = {
  interceptClose: true,
  minimizeToTray: false,
  startInTray: false,
  showUnreadCount: true,
  unreadScope: "inbox",
};

function localize() {
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = messenger.i18n.getMessage(element.dataset.i18n);
  }
  document.documentElement.lang = messenger.i18n.getUILanguage();
}

async function loadSettings() {
  const settings = await messenger.storage.local.get(DEFAULTS);
  for (const input of document.querySelectorAll("[data-setting]")) {
    const key = input.dataset.setting;
    if (input.type == "checkbox") {
      input.checked = !!settings[key];
    } else {
      input.value = settings[key];
    }
    input.addEventListener("change", () => {
      const value = input.type == "checkbox" ? input.checked : input.value;
      messenger.storage.local.set({ [key]: value });
    });
  }
}

async function showStatus() {
  const status = document.getElementById("status");
  try {
    const { trayAvailable } = await messenger.runtime.sendMessage({ type: "getStatus" });
    status.textContent = messenger.i18n.getMessage(
      trayAvailable ? "statusTrayAvailable" : "statusTrayUnavailable"
    );
    status.classList.toggle("warning", !trayAvailable);
    status.hidden = false;
  } catch (e) {
    console.error(e);
  }
}

localize();
loadSettings();
showStatus();
