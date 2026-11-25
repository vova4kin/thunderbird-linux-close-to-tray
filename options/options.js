/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

// KWin window rule that makes KDE Plasma (Wayland) remember the position of
// the main window. Wayland does not let applications position their own
// windows, so this has to be done by the compositor.
const KWIN_RULE = {
  description: "Thunderbird main window position (Close to Tray for Linux)",
  // Matches "thunderbird" (distribution package), "thunderbird_thunderbird"
  // (Snap) and "org.mozilla.Thunderbird" (Flatpak).
  windowClass: "(?i)thunderbird",
  // Main window titles end with " - Mozilla Thunderbird"; composer windows
  // ("Write: ..." / "Створення повідомлення: ...") are excluded so that they
  // do not overwrite the remembered position.
  windowTitle: "^(?!Write: |Створення повідомлення: ).* - Mozilla Thunderbird$",
};

function kwinRuleText() {
  return [
    `[${KWIN_RULE.description}]`,
    `Description=${KWIN_RULE.description}`,
    "position=0,0",
    "positionrule=4", // 4 = Remember
    `title=${KWIN_RULE.windowTitle}`,
    "titlematch=3", // 3 = Regular expression
    "types=1", // 1 = Normal window
    `wmclass=${KWIN_RULE.windowClass}`,
    "wmclassmatch=3", // 3 = Regular expression
    "",
  ].join("\n");
}

function setupKWinSection(environment) {
  const isKde = /KDE/i.test(environment?.desktop || "");
  if (!environment?.wayland || !isKde) {
    return;
  }
  document.getElementById("kwinClass").textContent = KWIN_RULE.windowClass;
  document.getElementById("kwinTitleRegex").textContent = KWIN_RULE.windowTitle;
  document.getElementById("kwinRuleText").textContent = kwinRuleText();

  document.getElementById("kwinDownload").addEventListener("click", () => {
    const blob = new Blob([kwinRuleText()], { type: "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "thunderbird-close-to-tray.kwinrule";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  });

  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      const source = document.getElementById(button.dataset.copy);
      try {
        await navigator.clipboard.writeText(source.textContent);
      } catch (e) {
        // Fallback: copy the selected text (allowed during a click).
        window.getSelection().selectAllChildren(source);
        document.execCommand("copy");
      }
      button.classList.add("copied");
      setTimeout(() => button.classList.remove("copied"), 1500);
    });
  }
  document.getElementById("kwinSection").hidden = false;
}

function localize() {
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = messenger.i18n.getMessage(element.dataset.i18n);
  }
  document.documentElement.lang = messenger.i18n.getUILanguage();
}

async function loadSettings() {
  const settings = await messenger.storage.local.get(DEFAULT_SETTINGS);
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
    const { trayAvailable, environment } = await messenger.runtime.sendMessage({ type: "getStatus" });
    setupKWinSection(environment);
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
