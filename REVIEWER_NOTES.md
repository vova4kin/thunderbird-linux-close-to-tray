# Notes to Reviewer (addons.thunderbird.net)

**What it does.** On Linux it turns the main window's close button into
"hide to tray" and provides a tray icon (StatusNotifierItem) with an unread
counter and a menu (Show/Hide, Write a Message, Settings, Quit). On other
platforms the experiments do nothing (`AppConstants.platform != "linux"`).

**Why Experiment APIs are needed.** No WebExtension API can (a) cancel the
main window's close or hide/show a window, or (b) create a system tray icon.
Thunderbird's own Linux tray integration (`nsIMessengerOSIntegration`, only
in recent releases) offers neither a click hook nor custom menu items.

**Architecture / separation of concerns.**

- `common/settings.js`: default settings shared with the options page.
- `background.js`: all logic (settings in `storage.local`, unread counting via
  `messenger.accounts`/`messenger.folders`, icon rendering on a canvas, event
  handling).
- `experiments/trayWindow/implementation.js`: a thin bridge. It uses
  `ExtensionSupport.registerWindowListener` for `messenger.xhtml`, calls
  `preventDefault()` on the cancelable `close` event of the *last visible*
  main window only (this event is fired both by the WM close button and by
  TB's CSD button through `requestWindowClose()`), and hides/shows via
  `nsIBaseWindow.visibility`. Quit (`Services.startup.quit`) does not fire
  `close`, so Ctrl+Q / File › Quit are untouched. It also sets a flag on
  `quit-application-granted`. On Wayland, the activation token from the tray
  host is passed to GDK (`gdk_wayland_display_set_startup_notification_id` +
  `gdk_window_focus`) through js-ctypes. That call happens only after verifying
  with `g_type_check_instance_is_a` that the window is a `GdkWindow` and the
  display is a `GdkWaylandDisplay`. When re-showing, the window is resized by
  1 px (queued while still hidden, so no visible jump; maximized windows have
  no shadow and are only re-maximized if the compositor mapped them
  unmaximized). This works around a Gecko/Wayland issue where, after unmap/remap,
  the rendering subsurface loses its offset inside the shadowed CSD surface
  (the UI is drawn shifted while input is not).
- `experiments/systemTray/implementation.js`: a StatusNotifierItem plus a
  `com.canonical.dbusmenu` menu, implemented in-process with GIO/GDBus through
  js-ctypes. The libraries are the system GLib/GIO already loaded by
  Thunderbird. No external binaries or native messaging are used, because
  Snap and Flatpak block them. The bus name and object paths follow the
  Thunderbird Snap AppArmor profile.

**js-ctypes safety.**

- Only non-variadic functions are declared.
- Every GVariant is built as a floating reference and consumed by the GDBus
  call it is passed to. Readers unref every child they obtain.
- All D-Bus objects and the signal subscription are registered inside a
  private `GMainContext`, which the add-on iterates from an `nsITimer`
  (50 ms after activity, 100 ms when idle). GLib therefore only invokes the
  js-ctypes callbacks from JavaScript started by the add-on, never re-entrantly
  from Gecko's native event loop.
- C callback pointers (vtable, signal callback, `GDestroyNotify`) are kept
  referenced until GLib has delivered every `GDestroyNotify`. Only then is the
  connection unref'd, the private context freed and the libraries closed.
  There is a 10 s cap, after which the callbacks are deliberately kept alive
  rather than freed while GLib might still reference them.

**Window position.** On X11 the add-on restores the position with
`window.moveTo()`. On Wayland that is impossible, so the options page
(shown only on KDE Wayland, detected via `trayWindow.getEnvironment()`) offers
a KWin window rule as a downloadable text file plus instructions. The add-on
never runs external programs or changes desktop settings itself.

**onShutdown(isAppShutdown).**

- `systemTray`: unsubscribes the signal, unregisters both D-Bus objects,
  releases the well-known bus name (so the tray host removes the icon), unrefs
  the introspection data and finishes the finalization described above.
- `trayWindow`: unregisters the window listener, removes the `close` and
  `sizemodechange` listeners from every window, removes the `Services.obs`
  observer and closes the GDK libraries. On disable/uninstall
  (`!isAppShutdown`) every window it hid is made visible again (size mode is
  restored), so the user is never left with an invisible Thunderbird.
- No Thunderbird preferences are modified at any time.

**Safety net.** The close button is intercepted only while a tray host has
accepted the icon. If the tray host disappears, the window is shown again and
interception stops until the host comes back.

**Permissions.** `accountsRead` to read folder unread counts, and `storage`
for the settings. `compose.beginNew` needs no permission.

**Code.** Plain, unminified JavaScript with no bundler and no third-party
code. There is no remote code, `eval` or network access. `build.sh` zips the
listed files as they are.

**How to test.** Linux with KDE Plasma (or GNOME + AppIndicator extension).
Install, then:

1. Click ✕ on the main window → it hides and the tray icon stays.
2. Left-click the icon → the window comes back focused.
3. Right-click → use the menu.
4. Press Ctrl+Q → Thunderbird quits.
5. Hide the window, then disable the add-on in the Add-ons Manager → the
   window reappears and the icon disappears.

Tested on Thunderbird 160.0 and 161.0 (Snap) with KDE Plasma 6.6 Wayland on Ubuntu 26.04.
