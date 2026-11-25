/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * Settings shared by the background script and the options page.
 * Stored in messenger.storage.local under these keys.
 */

"use strict";

// eslint-disable-next-line no-unused-vars
const DEFAULT_SETTINGS = Object.freeze({
  interceptClose: true,
  minimizeToTray: false,
  startInTray: false,
  showUnreadCount: true,
  // "inbox": only Inbox folders; "all": all folders except trash, junk,
  // sent, drafts, templates, archives and outbox.
  unreadScope: "inbox",
});
