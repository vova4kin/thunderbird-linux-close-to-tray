# Close to Tray for Linux

A Thunderbird add-on for Linux that hides the main window to the system tray
instead of closing it, and adds a tray icon with an unread counter and a
context menu.

Works on KDE Plasma, GNOME (with the *AppIndicator and KStatusNotifierItem
Support* extension), XFCE and other desktops that implement the
StatusNotifierItem / AppIndicator protocol, on Wayland and X11, including the
Snap and Flatpak packages of Thunderbird. It is a single self-contained `.xpi`:
no helper programs, no native messaging host.

## Features

- Clicking **✕** on the main window (`mail:3pane`) hides it from the screen and
  the task bar; Thunderbird keeps running in the tray.
- **Ctrl+Q**, **File › Quit** and **Quit** in the tray menu really quit.
  Secondary windows (composer, address book, settings…) close normally.
- Tray icon with the unread message count, a tooltip and a menu: *Show/Hide
  Thunderbird*, *Write a Message*, *Settings*, *Quit*.
- Left click on the icon shows and focuses the window (using the Wayland
  xdg-activation token provided by the tray host), or hides it if it is
  already active. Middle click always shows it.
- Optional: hide on minimize, start hidden in the tray, count unread messages
  in Inbox folders only or in all regular folders.
- English and Ukrainian user interface.

Requires Thunderbird 128 – 160.

## How it works

| Part | Responsibility |
|---|---|
| `background.js` | All logic: settings (`storage.local`), unread counting (`accounts`/`folders` API), icon rendering on a canvas, reacting to tray events. |
| `experiments/trayWindow` | Experiment API: hide/show the main window via `nsIBaseWindow.visibility`, cancel its `close` event, optional minimize-to-tray, Wayland focus via GDK. |
| `experiments/systemTray` | Experiment API: an in-process StatusNotifierItem + `com.canonical.dbusmenu` menu implemented with GIO/GDBus through js-ctypes. |
| `options/` | Settings page (follows the light/dark theme). |

Snap's AppArmor profile only allows these D-Bus names and paths, so they are
used everywhere: bus name `org.freedesktop.StatusNotifierItem-<PID>-<N>`, item
at `/StatusNotifierItem`, menu at `/MenuBar`.

The D-Bus objects are registered in a private `GMainContext`, which the add-on
iterates from a timer (every 50–100 ms). GLib therefore only calls the
js-ctypes callbacks from JavaScript that the add-on started itself, never from
Gecko's native event loop.

## Building

```sh
./build.sh
```

The script checks the JSON and JavaScript syntax and writes
`dist/close-to-tray-linux-<version>.xpi`. Only the files the add-on needs go
into the archive, with `manifest.json` at its root.

## Installing for testing

*Tools* (≡) › *Add-ons and Themes* › gear icon › *Install Add-on From File…* ›
choose the `.xpi`.

## Known limitations

- On Wayland the window manager's own minimize button may not tell the
  application that the window was minimized, so *hide on minimize* is reliable
  only with Thunderbird's own title bar buttons.
- Focus from the tray **menu** (as opposed to clicking the icon) gets no
  activation token from Plasma, so KWin may only highlight the window in the
  task bar instead of raising it.
- Without a tray host (for example stock GNOME), the add-on never hides the
  window, so you cannot lose it.

## License

[MPL-2.0](LICENSE)
