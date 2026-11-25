/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * Experiment API "trayWindow"
 * ===========================
 *
 * Minimal bridge that lets background.js hide/show the main Thunderbird
 * window (windowtype "mail:3pane") and that turns its close button into
 * "hide to tray".
 *
 * - Both close buttons end up in a cancelable "close" event on the window:
 *   the window manager's button (native close request) and Thunderbird's own
 *   client-side titlebar button (requestWindowClose() in mailCore.js).
 *   Regular quitting (Ctrl+Q, File > Quit, tray "Quit") goes through
 *   nsIAppStartup.quit() and never fires "close", so it is not affected.
 * - Hiding uses nsIBaseWindow.visibility, which unmaps the toplevel (it also
 *   disappears from the task bar). This is the same mechanism Thunderbird
 *   uses for its own "start in tray" feature on Windows.
 * - On Wayland, raising a window requires an xdg-activation token. The tray
 *   host hands one to the StatusNotifierItem; background.js forwards it here
 *   and it is passed to GDK (gdk_wayland_display_set_startup_notification_id
 *   + gdk_window_focus) via js-ctypes. Without a token window.focus() is used.
 *
 * onShutdown() (add-on disabled/removed/updated) removes every listener and
 * observer and makes every window hidden by us visible again.
 *
 * NOTE: experiment scripts of one add-on share a single global object, so all
 * top-level bindings use `var` and are prefixed to avoid collisions.
 */

"use strict";

var { ExtensionCommon: TrayWindowExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { ExtensionSupport: TrayWindowExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
var { AppConstants: TrayWindowAppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
var { ctypes: TrayWindowCtypes } = ChromeUtils.importESModule(
  "resource://gre/modules/ctypes.sys.mjs"
);

var TRAY_WINDOW_MAIN_URL = "chrome://messenger/content/messenger.xhtml";
var TRAY_WINDOW_MAIN_TYPE = "mail:3pane";
// Delay before post-show fixups run (the window must be mapped again).
var TRAY_WINDOW_AFTER_SHOW_DELAY_MS = 100;
// Delay between the two steps of the post-show 1 px resize.
var TRAY_WINDOW_RESIZE_STEP_MS = 150;

/**
 * Small GDK helper: detects Wayland and raises a window with an
 * xdg-activation token. Every failure (no GTK3/GDK, missing symbol) simply
 * disables it; callers fall back to window.focus() / environment variables.
 */
var TrayWindowGdk = class {
  constructor() {
    this.gdk = null;
    this.gobject = null;
    if (TrayWindowAppConstants.platform != "linux") {
      return;
    }
    try {
      const ctypes = TrayWindowCtypes;
      const abi = ctypes.default_abi;
      const gp = ctypes.voidptr_t;
      const GType = ctypes.size_t;
      this.gdk = ctypes.open("libgdk-3.so.0");
      this.gobject = ctypes.open("libgobject-2.0.so.0");
      this.gdk_window_get_type = this.gdk.declare("gdk_window_get_type", abi, GType);
      this.gdk_window_get_toplevel = this.gdk.declare("gdk_window_get_toplevel", abi, gp, gp);
      this.gdk_window_get_display = this.gdk.declare("gdk_window_get_display", abi, gp, gp);
      this.gdk_window_focus = this.gdk.declare("gdk_window_focus", abi, ctypes.void_t, gp, ctypes.uint32_t);
      this.gdk_display_get_default = this.gdk.declare("gdk_display_get_default", abi, gp);
      this.gdk_wayland_display_get_type = this.gdk.declare("gdk_wayland_display_get_type", abi, GType);
      this.gdk_wayland_display_set_startup_notification_id = this.gdk.declare(
        "gdk_wayland_display_set_startup_notification_id",
        abi,
        ctypes.void_t,
        gp,
        ctypes.char.ptr
      );
      this.g_type_check_instance_is_a = this.gobject.declare(
        "g_type_check_instance_is_a",
        abi,
        ctypes.int,
        gp,
        GType
      );
    } catch (e) {
      console.warn("trayWindow: Wayland activation via GDK unavailable", e);
      this.close();
    }
  }

  /**
   * @returns {boolean} true if GTK runs on a Wayland display. Falls back to
   *   the session environment if GDK is not usable.
   */
  isWayland() {
    if (this.gdk) {
      try {
        const display = this.gdk_display_get_default();
        if (!display.isNull()) {
          return !!this.g_type_check_instance_is_a(display, this.gdk_wayland_display_get_type());
        }
      } catch (e) {
        console.error(e);
      }
    }
    return Services.env.get("XDG_SESSION_TYPE") == "wayland" && Services.env.get("GDK_BACKEND") != "x11";
  }

  /**
   * @param {nsIBaseWindow} baseWindow
   * @param {string} token - xdg-activation token.
   * @returns {boolean} true if the activation request was sent.
   */
  activate(baseWindow, token) {
    if (!this.gdk || !token) {
      return false;
    }
    // nativeHandle is "0x..." formatted from the widget's GdkWindow pointer.
    const handle = baseWindow.nativeHandle;
    if (!handle || /^0x0*$/.test(handle)) {
      return false;
    }
    const gdkWindow = TrayWindowCtypes.voidptr_t(TrayWindowCtypes.UInt64(handle));
    if (!this.g_type_check_instance_is_a(gdkWindow, this.gdk_window_get_type())) {
      return false;
    }
    const toplevel = this.gdk_window_get_toplevel(gdkWindow);
    const display = this.gdk_window_get_display(toplevel);
    // Only touch the Wayland specific API on a Wayland display (on X11 the
    // struct layout differs and the call would be invalid).
    if (!this.g_type_check_instance_is_a(display, this.gdk_wayland_display_get_type())) {
      return false;
    }
    this.gdk_wayland_display_set_startup_notification_id(display, token);
    this.gdk_window_focus(toplevel, 0 /* GDK_CURRENT_TIME */);
    return true;
  }

  close() {
    for (const lib of [this.gdk, this.gobject]) {
      try {
        lib?.close();
      } catch (e) {
        console.error(e);
      }
    }
    this.gdk = null;
    this.gobject = null;
  }
};

/**
 * Tracks the main windows, intercepts their close/minimize and performs
 * hide/show. One instance per add-on.
 */
var TrayWindowController = class {
  constructor(extensionId) {
    this.listenerId = `${extensionId}:trayWindow`;
    this.options = { interceptClose: false, minimizeToTray: false };
    /** @type {Map<Window, object>} per-window state and bound handlers */
    this.windows = new Map();
    this.hideNextWindow = false;
    this.quitting = false;
    this.visibilityListeners = new Set();
    this.gdk = new TrayWindowGdk();

    this.observe = this.observe.bind(this);
    Services.obs.addObserver(this.observe, "quit-application-granted");

    TrayWindowExtensionSupport.registerWindowListener(this.listenerId, {
      chromeURLs: [TRAY_WINDOW_MAIN_URL],
      onLoadWindow: win => this.attach(win),
      onUnloadWindow: win => this.detach(win),
    });
  }

  observe(subject, topic) {
    if (topic == "quit-application-granted") {
      // The application is really quitting now: never block anything.
      this.quitting = true;
    }
  }

  isMainWindow(win) {
    return win.document.documentElement.getAttribute("windowtype") == TRAY_WINDOW_MAIN_TYPE;
  }

  attach(win) {
    if (!this.isMainWindow(win) || this.windows.has(win)) {
      return;
    }
    const state = {
      hidden: false,
      wasMaximized: false,
      // Size mode before the last minimize, to restore it correctly.
      lastNormalState: win.windowState,
      onClose: event => this.onClose(win, event),
      onSizeModeChange: () => this.onSizeModeChange(win),
    };
    this.windows.set(win, state);
    win.addEventListener("close", state.onClose);
    win.addEventListener("sizemodechange", state.onSizeModeChange);

    if (this.hideNextWindow) {
      this.hideNextWindow = false;
      this.hideWindow(win);
      this.notifyVisibility();
    }
  }

  /**
   * @param {Window} win
   * @param {boolean} restore - make the window visible again if we hid it.
   */
  detach(win, restore = false) {
    const state = this.windows.get(win);
    if (!state) {
      return;
    }
    win.removeEventListener("close", state.onClose);
    win.removeEventListener("sizemodechange", state.onSizeModeChange);
    if (restore && state.hidden && !win.closed) {
      this.showWindow(win);
    }
    this.windows.delete(win);
  }

  getBaseWindow(win) {
    return win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow);
  }

  /** Open main windows that are currently hidden (true) or visible (false). */
  windowsWithHidden(hidden) {
    return [...this.windows]
      .filter(([win, state]) => state.hidden == hidden && !win.closed)
      .map(([win]) => win);
  }

  visibleWindows() {
    return this.windowsWithHidden(false);
  }

  hiddenWindows() {
    return this.windowsWithHidden(true);
  }

  onClose(win, event) {
    if (!this.options.interceptClose || this.quitting || event.defaultPrevented) {
      return;
    }
    // With several main windows open, closing one of them is a normal close;
    // only the last visible main window goes to the tray.
    if (this.visibleWindows().some(w => w != win)) {
      return;
    }
    event.preventDefault();
    this.hideWindow(win);
    this.notifyVisibility();
  }

  onSizeModeChange(win) {
    const state = this.windows.get(win);
    if (!state) {
      return;
    }
    if (win.windowState != win.STATE_MINIMIZED) {
      state.lastNormalState = win.windowState;
      return;
    }
    if (this.options.minimizeToTray && !state.hidden && !this.quitting) {
      // Let the minimize finish before unmapping the window.
      Services.tm.dispatchToMainThread(() => {
        if (this.windows.has(win) && !win.closed && !state.hidden) {
          this.hideWindow(win);
          this.notifyVisibility();
        }
      });
    }
  }

  hideWindow(win) {
    const state = this.windows.get(win);
    if (!state || state.hidden) {
      return;
    }
    state.wasMaximized =
      win.windowState == win.STATE_MAXIMIZED ||
      (win.windowState == win.STATE_MINIMIZED && state.lastNormalState == win.STATE_MAXIMIZED);
    // Window position is only known (and settable) on X11; on Wayland the
    // compositor places the window (see the KWin rule on the options page).
    state.screenX = win.screenX;
    state.screenY = win.screenY;
    this.getBaseWindow(win).visibility = false;
    state.hidden = true;
  }

  /**
   * Make a hidden window visible again, restoring its size mode and position.
   *
   * Gecko/Wayland issue: after the toplevel is unmapped and mapped again, the
   * rendering subsurface loses its offset inside the client-side decorated
   * (shadowed) surface, so the UI is drawn shifted while input is not. Any
   * resize makes Gecko re-position it:
   *   - normal window: resize by 1 px while still hidden, so the first frame
   *     is already correct (no visible jump); the direction alternates so the
   *     size never drifts by more than one pixel;
   *   - minimized window: resizing it while hidden breaks its size mode, so
   *     it gets a +1/-1 px resize right after being restored;
   *   - maximized window: has no shadow, so no resize (that would drop the
   *     maximized state); it is only maximized again if mapped unmaximized.
   */
  showWindow(win) {
    const state = this.windows.get(win);
    if (!state || !state.hidden) {
      return;
    }
    const wasMinimized = win.windowState == win.STATE_MINIMIZED;

    if (!state.wasMaximized && win.windowState == win.STATE_NORMAL) {
      state.resizeDelta = state.resizeDelta == 1 ? -1 : 1;
      win.resizeBy(state.resizeDelta, state.resizeDelta);
    }

    this.getBaseWindow(win).visibility = true;
    state.hidden = false;

    if (state.wasMaximized) {
      if (win.windowState != win.STATE_MAXIMIZED) {
        win.maximize();
      }
      this.afterShow(win, () => {
        if (win.windowState == win.STATE_NORMAL) {
          win.maximize();
        }
      });
      return;
    }

    if (wasMinimized) {
      win.restore();
      this.afterShow(win, () => {
        win.resizeBy(1, 1);
        win.setTimeout(() => win.resizeBy(-1, -1), TRAY_WINDOW_RESIZE_STEP_MS);
      });
    }
    if (!this.gdk.isWayland()) {
      // X11: put the window back where it was (impossible on Wayland).
      win.moveTo(state.screenX, state.screenY);
    }
  }

  /** Run fn shortly after a window was shown, unless it was closed/hidden. */
  afterShow(win, fn) {
    win.setTimeout(() => {
      if (!win.closed && !this.windows.get(win)?.hidden) {
        fn();
      }
    }, TRAY_WINDOW_AFTER_SHOW_DELAY_MS);
  }

  focusWindow(win, token) {
    win.focus();
    // Try the token once the window is mapped again (next frame), with a
    // timeout guard because hidden windows may not produce frames at all.
    let done = false;
    const raise = () => {
      if (done || win.closed) {
        return;
      }
      done = true;
      try {
        if (token && this.gdk.activate(this.getBaseWindow(win), token)) {
          return;
        }
      } catch (e) {
        console.error("trayWindow: Wayland activation failed", e);
      }
      win.focus();
    };
    win.requestAnimationFrame(raise);
    win.setTimeout(raise, 250);
  }

  mostRecentMainWindow() {
    const recent = Services.wm.getMostRecentWindow(TRAY_WINDOW_MAIN_TYPE);
    if (recent && this.windows.has(recent)) {
      return recent;
    }
    return [...this.windows.keys()].find(w => !w.closed) || null;
  }

  // ---- API ----

  hide() {
    const visible = this.visibleWindows();
    if (!visible.length) {
      if (!this.windows.size) {
        // Called during startup before the main window loaded.
        this.hideNextWindow = true;
      }
      return;
    }
    for (const win of visible) {
      this.hideWindow(win);
    }
    this.notifyVisibility();
  }

  show(token) {
    this.hideNextWindow = false;
    const hidden = this.hiddenWindows();
    for (const win of hidden) {
      this.showWindow(win);
    }
    const target = this.mostRecentMainWindow();
    if (target) {
      if (target.windowState == target.STATE_MINIMIZED) {
        target.restore();
      }
      this.focusWindow(target, token);
    }
    if (hidden.length) {
      this.notifyVisibility();
    }
  }

  toggle(token) {
    const target = this.mostRecentMainWindow();
    if (!target) {
      return;
    }
    const state = this.windows.get(target);
    const isActive = Services.focus.activeWindow == target;
    if (state.hidden || target.windowState == target.STATE_MINIMIZED || !isActive) {
      this.show(token);
    } else {
      this.hide();
    }
  }

  isHidden() {
    return this.hideNextWindow || (this.windows.size > 0 && this.visibleWindows().length == 0);
  }

  quit() {
    // Same sequence as Thunderbird's goQuitApplication().
    const cancelQuit = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
    Services.obs.notifyObservers(cancelQuit, "quit-application-requested");
    if (cancelQuit.data) {
      return false;
    }
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
    return true;
  }

  notifyVisibility() {
    const hidden = this.isHidden();
    for (const listener of this.visibilityListeners) {
      listener(hidden);
    }
  }

  /**
   * @param {boolean} isAppShutdown - true if Thunderbird itself is quitting.
   */
  destroy(isAppShutdown) {
    TrayWindowExtensionSupport.unregisterWindowListener(this.listenerId);
    Services.obs.removeObserver(this.observe, "quit-application-granted");
    for (const win of [...this.windows.keys()]) {
      // On add-on disable/uninstall make sure no window stays invisible.
      this.detach(win, !isAppShutdown);
    }
    this.windows.clear();
    this.visibilityListeners.clear();
    this.gdk.close();
  }
};

this.trayWindow = class extends TrayWindowExtensionCommon.ExtensionAPI {
  constructor(extension) {
    super(extension);
    this.controller = null;
  }

  getController() {
    if (!this.controller) {
      this.controller = new TrayWindowController(this.extension.id);
    }
    return this.controller;
  }

  getAPI(context) {
    const api = this;
    return {
      trayWindow: {
        async setOptions(options) {
          const controller = api.getController();
          for (const key of ["interceptClose", "minimizeToTray"]) {
            if (typeof options[key] == "boolean") {
              controller.options[key] = options[key];
            }
          }
        },
        async hide() {
          api.getController().hide();
        },
        async show(activationToken) {
          api.getController().show(activationToken || "");
        },
        async toggle(activationToken) {
          api.getController().toggle(activationToken || "");
        },
        async isHidden() {
          return api.getController().isHidden();
        },
        async getEnvironment() {
          return {
            wayland: api.getController().gdk.isWayland(),
            desktop: Services.env.get("XDG_CURRENT_DESKTOP") || "",
          };
        },
        async quit() {
          return api.getController().quit();
        },
        onVisibilityChanged: new TrayWindowExtensionCommon.EventManager({
          context,
          name: "trayWindow.onVisibilityChanged",
          register: fire => {
            const listener = hidden => fire.async(hidden);
            api.getController().visibilityListeners.add(listener);
            return () => api.controller?.visibilityListeners.delete(listener);
          },
        }).api(),
      },
    };
  }

  onShutdown(isAppShutdown) {
    this.controller?.destroy(isAppShutdown);
    this.controller = null;
  }
};
