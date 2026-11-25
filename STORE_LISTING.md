# addons.thunderbird.net listing

Copy-paste material for the ATN submission form. The add-on's own UI is
English and Ukrainian, so the listing is provided in both languages.

## Basic information

| Field | Value |
|---|---|
| Name | Close to Tray for Linux |
| Add-on URL (slug) | `close-to-tray-linux` |
| Categories | Appearance and Customization; Miscellaneous |
| Platform | Linux (the add-on does nothing on other platforms) |
| License | Mozilla Public License 2.0 |
| Homepage | https://vevidi.com/ |
| Support site | https://github.com/vova4kin/thunderbird-linux-close-to-tray/issues |
| Source code | https://github.com/vova4kin/thunderbird-linux-close-to-tray |
| Requires source code upload? | No: plain, unminified JavaScript, no build step |
| Privacy policy | Not needed: no data is collected or transmitted (see the description) |
| Notes to Reviewer | Contents of `REVIEWER_NOTES.md` |

## Summary (English, max. 250 characters)

Keep Thunderbird running in the system tray on Linux: the close button hides
the window instead of quitting. Tray icon with unread counter and menu. Works
on KDE Plasma Wayland and with the Snap package.

## Summary (Ukrainian)

Thunderbird на Linux працює далі в системному треї: кнопка закриття ховає
вікно замість виходу. Іконка в треї з лічильником непрочитаних і меню.
Працює в KDE Plasma Wayland і зі Snap-пакетом.

## Description (English)

Close to Tray for Linux keeps Thunderbird running in the background when you
close its main window.

**Features**
- Clicking ✕ on the main window hides it from the screen and the task bar;
  Thunderbird keeps checking mail in the tray.
- Ctrl+Q, File › Quit and "Quit" in the tray menu still quit as usual. Other
  windows (composer, settings…) close normally.
- Tray icon with the number of unread messages (Inbox only or all folders)
  and a menu: Show/Hide, Write a Message, Settings, Quit.
- Left click shows and focuses the window, also on Wayland.
- Optional: hide on minimize, start hidden in the tray.
- On KDE Plasma (Wayland) the settings page explains how to make KDE
  remember the window position (Wayland does not let applications do that).

**Requirements**
A desktop with a StatusNotifierItem / AppIndicator tray: KDE Plasma, XFCE, or
GNOME with the "AppIndicator and KStatusNotifierItem Support" extension.
Tested on Thunderbird 160–161 (Snap) with KDE Plasma 6 (Wayland). Without a
tray the window is never hidden, so it cannot get lost.

**Permissions and privacy**
The add-on reads folder unread counts and stores its own settings locally.
It collects no data and makes no network connections.
It needs Thunderbird's "Experiment" APIs to hide the window and to create a
tray icon, because no regular add-on API can do that. That is why
Thunderbird asks for "full, unrestricted access". The add-on uses this access
only for the main window and the tray icon. The source code is public (MPL-2.0).

## Description (Ukrainian)

Close to Tray for Linux залишає Thunderbird працювати у фоні, коли ви
закриваєте головне вікно.

**Можливості**
- Клік на ✕ головного вікна ховає його з екрана й панелі задач; Thunderbird
  далі перевіряє пошту в треї.
- Ctrl+Q, Файл › Вийти та «Вийти» в меню трею, як і раніше, закривають
  програму. Інші вікна (написання листа, налаштування…) закриваються звично.
- Іконка в треї з кількістю непрочитаних листів (лише «Вхідні» або всі папки)
  і меню: Показати/Сховати, Написати листа, Налаштування, Вийти.
- Лівий клік показує вікно й передає йому фокус, зокрема у Wayland.
- За бажанням: ховати при згортанні, запускатися одразу в треї.
- У KDE Plasma (Wayland) сторінка налаштувань пояснює, як змусити KDE
  запам'ятовувати позицію вікна (Wayland не дозволяє цього програмам).

**Вимоги**
Робоче середовище з треєм StatusNotifierItem / AppIndicator: KDE Plasma, XFCE
або GNOME з розширенням «AppIndicator and KStatusNotifierItem Support».
Перевірено на Thunderbird 160–161 (Snap) з KDE Plasma 6 (Wayland). Без трею
вікно ніколи не ховається, тож його неможливо загубити.

**Дозволи та приватність**
Розширення читає кількість непрочитаних листів у папках і зберігає свої
налаштування локально. Воно не збирає жодних даних і не виходить у мережу.
Для приховування вікна та іконки в треї потрібні «Experiment» API Thunderbird,
бо жоден звичайний API розширень цього не вміє. Тому Thunderbird показує
запит на «повний, необмежений доступ». Розширення використовує цей доступ
лише для головного вікна та іконки в треї. Код відкритий (MPL-2.0).

## Version notes for 1.0.7 (release notes)

First public release.
