/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * Experiment API "systemTray"
 * ===========================
 *
 * A small, self-contained StatusNotifierItem (SNI) implementation with a
 * com.canonical.dbusmenu context menu. It talks to the session bus through
 * GIO/GDBus (libgio-2.0, always loaded in Thunderbird on Linux) via js-ctypes,
 * so no external helper process / native messaging host is needed. This is
 * what makes it work inside Snap and Flatpak sandboxes.
 *
 * Bus name and object paths are chosen to match what the Thunderbird Snap
 * AppArmor profile permits:
 *   - bus name    org.freedesktop.StatusNotifierItem-<PID>-<N>
 *   - item path   /StatusNotifierItem
 *   - menu path   /MenuBar  (dbusmenu is NOT allowed below /StatusNotifierItem)
 *   - signals     NewIcon, NewToolTip (SNI) and LayoutUpdated (dbusmenu)
 *
 * Threading / re-entrancy: GDBus dispatches incoming calls, signal callbacks
 * and GDestroyNotify in the thread-default GMainContext that was active when
 * the object was registered. We register everything inside a PRIVATE
 * GMainContext (pushed as thread-default only for the registration calls) and
 * iterate that context ourselves from a main-thread nsITimer. This guarantees
 * that GLib only ever calls our js-ctypes callbacks from JavaScript we
 * started, at a safe point, and never from inside Gecko's own native event
 * loop iteration (entering JS from there crashes Thunderbird).
 *
 * Callback lifetime: every C function pointer handed to GLib is kept alive
 * until GLib calls the matching GDestroyNotify, which guarantees that no
 * further invocation can happen. Only then are the references dropped and the
 * libraries closed (see SystemTrayService#maybeFinalize).
 *
 * NOTE: experiment scripts of one add-on share a single global object, so all
 * top-level bindings use `var` and are prefixed to avoid collisions.
 */

"use strict";

var { ExtensionCommon: SystemTrayExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { AppConstants: SystemTrayAppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
var { ctypes: SystemTrayCtypes } = ChromeUtils.importESModule(
  "resource://gre/modules/ctypes.sys.mjs"
);

var SYSTEM_TRAY_ITEM_PATH = "/StatusNotifierItem";
// Tried in order; both are allowed by the Snap AppArmor profile.
var SYSTEM_TRAY_MENU_PATHS = ["/MenuBar", "/com/canonical/dbusmenu"];
var SYSTEM_TRAY_WATCHER_NAME = "org.kde.StatusNotifierWatcher";
var SYSTEM_TRAY_WATCHER_PATH = "/StatusNotifierWatcher";
var SYSTEM_TRAY_SNI_IFACE = "org.kde.StatusNotifierItem";
var SYSTEM_TRAY_MENU_IFACE = "com.canonical.dbusmenu";
// First <N> tried for the bus name. Kept away from 1 so we never race with
// Thunderbird's own (Rust) tray icon for the same well-known name.
var SYSTEM_TRAY_FIRST_NAME_INDEX = 10;
// How often the private GMainContext is iterated: fast right after D-Bus
// activity (menu navigation), slower when idle to save wake-ups.
var SYSTEM_TRAY_PUMP_ACTIVE_MS = 50;
var SYSTEM_TRAY_PUMP_IDLE_MS = 100;
var SYSTEM_TRAY_PUMP_ACTIVE_PERIOD_MS = 2000;
// Upper bound for waiting on GDestroyNotify after the icon was removed.
var SYSTEM_TRAY_FINALIZE_TIMEOUT_MS = 10000;

var SYSTEM_TRAY_INTROSPECTION_XML = `
<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="WindowId" type="i" access="read"/>
    <property name="IconThemePath" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="OverlayIconName" type="s" access="read"/>
    <property name="OverlayIconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionMovieName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <method name="ContextMenu">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="Activate">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="SecondaryActivate">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="Scroll">
      <arg name="delta" type="i" direction="in"/>
      <arg name="orientation" type="s" direction="in"/>
    </method>
    <method name="ProvideXdgActivationToken">
      <arg name="token" type="s" direction="in"/>
    </method>
    <signal name="NewIcon"/>
    <signal name="NewToolTip"/>
  </interface>
  <interface name="com.canonical.dbusmenu">
    <property name="Version" type="u" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="as" access="read"/>
    <method name="GetLayout">
      <arg name="parentId" type="i" direction="in"/>
      <arg name="recursionDepth" type="i" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="revision" type="u" direction="out"/>
      <arg name="layout" type="(ia{sv}av)" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg name="ids" type="ai" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="properties" type="a(ia{sv})" direction="out"/>
    </method>
    <method name="GetProperty">
      <arg name="id" type="i" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="value" type="v" direction="out"/>
    </method>
    <method name="Event">
      <arg name="id" type="i" direction="in"/>
      <arg name="eventId" type="s" direction="in"/>
      <arg name="data" type="v" direction="in"/>
      <arg name="timestamp" type="u" direction="in"/>
    </method>
    <method name="EventGroup">
      <arg name="events" type="a(isvu)" direction="in"/>
      <arg name="idErrors" type="ai" direction="out"/>
    </method>
    <method name="AboutToShow">
      <arg name="id" type="i" direction="in"/>
      <arg name="needUpdate" type="b" direction="out"/>
    </method>
    <method name="AboutToShowGroup">
      <arg name="ids" type="ai" direction="in"/>
      <arg name="updatesNeeded" type="ai" direction="out"/>
      <arg name="idErrors" type="ai" direction="out"/>
    </method>
    <signal name="LayoutUpdated">
      <arg name="revision" type="u"/>
      <arg name="parent" type="i"/>
    </signal>
  </interface>
</node>`;

/**
 * Thin js-ctypes binding of the handful of GLib/GIO functions we need.
 * Only non-variadic functions are used.
 */
var SystemTrayGLib = class {
  constructor() {
    const ctypes = SystemTrayCtypes;
    const abi = ctypes.default_abi;
    const gp = ctypes.voidptr_t;
    const str = ctypes.char.ptr;
    const gboolean = ctypes.int;
    const guint = ctypes.unsigned_int;
    const gsize = ctypes.size_t;

    this.GError = new ctypes.StructType("GError", [
      { domain: ctypes.uint32_t },
      { code: ctypes.int },
      { message: ctypes.char.ptr },
    ]);
    const GErrorPP = this.GError.ptr.ptr;

    // Callback signatures.
    this.MethodCallFn = ctypes.FunctionType(abi, ctypes.void_t, [
      gp, // GDBusConnection *connection
      str, // const gchar *sender
      str, // const gchar *object_path
      str, // const gchar *interface_name
      str, // const gchar *method_name
      gp, // GVariant *parameters
      gp, // GDBusMethodInvocation *invocation
      gp, // gpointer user_data
    ]);
    this.GetPropertyFn = ctypes.FunctionType(abi, gp, [
      gp,
      str,
      str,
      str,
      str, // property_name
      GErrorPP,
      gp,
    ]);
    this.SetPropertyFn = ctypes.FunctionType(abi, gboolean, [
      gp,
      str,
      str,
      str,
      str,
      gp, // GVariant *value
      GErrorPP,
      gp,
    ]);
    this.SignalFn = ctypes.FunctionType(abi, ctypes.void_t, [
      gp, // connection
      str, // sender_name
      str, // object_path
      str, // interface_name
      str, // signal_name
      gp, // GVariant *parameters
      gp, // user_data
    ]);
    this.DestroyNotifyFn = ctypes.FunctionType(abi, ctypes.void_t, [gp]);

    this.VTable = new ctypes.StructType("GDBusInterfaceVTable", [
      { method_call: this.MethodCallFn.ptr },
      { get_property: this.GetPropertyFn.ptr },
      { set_property: this.SetPropertyFn.ptr },
      { padding: gp.array(8) },
    ]);

    this.glib = ctypes.open("libglib-2.0.so.0");
    this.gobject = ctypes.open("libgobject-2.0.so.0");
    this.gio = ctypes.open("libgio-2.0.so.0");

    const g = (lib, name, ret, ...args) => lib.declare(name, abi, ret, ...args);

    // GLib: GVariant construction / inspection.
    this.g_variant_new_string = g(this.glib, "g_variant_new_string", gp, str);
    this.g_variant_new_object_path = g(this.glib, "g_variant_new_object_path", gp, str);
    this.g_variant_new_int32 = g(this.glib, "g_variant_new_int32", gp, ctypes.int32_t);
    this.g_variant_new_uint32 = g(this.glib, "g_variant_new_uint32", gp, ctypes.uint32_t);
    this.g_variant_new_boolean = g(this.glib, "g_variant_new_boolean", gp, gboolean);
    this.g_variant_new_variant = g(this.glib, "g_variant_new_variant", gp, gp);
    this.g_variant_new_tuple = g(this.glib, "g_variant_new_tuple", gp, gp.ptr, gsize);
    this.g_variant_new_array = g(this.glib, "g_variant_new_array", gp, gp, gp.ptr, gsize);
    this.g_variant_new_dict_entry = g(this.glib, "g_variant_new_dict_entry", gp, gp, gp);
    this.g_variant_new_fixed_array = g(this.glib, "g_variant_new_fixed_array", gp, gp, gp, gsize, gsize);
    this.g_variant_type_new = g(this.glib, "g_variant_type_new", gp, str);
    this.g_variant_type_free = g(this.glib, "g_variant_type_free", ctypes.void_t, gp);
    this.g_variant_unref = g(this.glib, "g_variant_unref", ctypes.void_t, gp);
    this.g_variant_n_children = g(this.glib, "g_variant_n_children", gsize, gp);
    this.g_variant_get_child_value = g(this.glib, "g_variant_get_child_value", gp, gp, gsize);
    this.g_variant_get_int32 = g(this.glib, "g_variant_get_int32", ctypes.int32_t, gp);
    this.g_variant_get_uint32 = g(this.glib, "g_variant_get_uint32", ctypes.uint32_t, gp);
    this.g_variant_get_string = g(this.glib, "g_variant_get_string", str, gp, gsize.ptr);
    this.g_variant_get_type_string = g(this.glib, "g_variant_get_type_string", str, gp);
    this.g_error_free = g(this.glib, "g_error_free", ctypes.void_t, this.GError.ptr);
    this.g_main_context_new = g(this.glib, "g_main_context_new", gp);
    this.g_main_context_unref = g(this.glib, "g_main_context_unref", ctypes.void_t, gp);
    this.g_main_context_push_thread_default = g(this.glib, "g_main_context_push_thread_default", ctypes.void_t, gp);
    this.g_main_context_pop_thread_default = g(this.glib, "g_main_context_pop_thread_default", ctypes.void_t, gp);
    this.g_main_context_iteration = g(this.glib, "g_main_context_iteration", gboolean, gp, gboolean);

    // GObject.
    this.g_object_unref = g(this.gobject, "g_object_unref", ctypes.void_t, gp);

    // GIO: D-Bus.
    this.g_bus_get_sync = g(this.gio, "g_bus_get_sync", gp, ctypes.int, gp, GErrorPP);
    this.g_dbus_connection_get_unique_name = g(this.gio, "g_dbus_connection_get_unique_name", str, gp);
    this.g_dbus_node_info_new_for_xml = g(this.gio, "g_dbus_node_info_new_for_xml", gp, str, GErrorPP);
    this.g_dbus_node_info_lookup_interface = g(this.gio, "g_dbus_node_info_lookup_interface", gp, gp, str);
    this.g_dbus_node_info_unref = g(this.gio, "g_dbus_node_info_unref", ctypes.void_t, gp);
    this.g_dbus_connection_register_object = g(
      this.gio,
      "g_dbus_connection_register_object",
      guint,
      gp, // connection
      str, // object_path
      gp, // GDBusInterfaceInfo *interface_info
      this.VTable.ptr, // const GDBusInterfaceVTable *vtable
      gp, // user_data
      this.DestroyNotifyFn.ptr, // user_data_free_func
      GErrorPP
    );
    this.g_dbus_connection_unregister_object = g(this.gio, "g_dbus_connection_unregister_object", gboolean, gp, guint);
    this.g_dbus_connection_emit_signal = g(
      this.gio,
      "g_dbus_connection_emit_signal",
      gboolean,
      gp, // connection
      str, // destination_bus_name
      str, // object_path
      str, // interface_name
      str, // signal_name
      gp, // GVariant *parameters
      GErrorPP
    );
    this.g_dbus_connection_call_sync = g(
      this.gio,
      "g_dbus_connection_call_sync",
      gp, // GVariant * (reply)
      gp, // connection
      str, // bus_name
      str, // object_path
      str, // interface_name
      str, // method_name
      gp, // GVariant *parameters
      gp, // const GVariantType *reply_type
      ctypes.int, // GDBusCallFlags flags
      ctypes.int, // gint timeout_msec
      gp, // GCancellable *cancellable
      GErrorPP
    );
    this.g_dbus_connection_signal_subscribe = g(
      this.gio,
      "g_dbus_connection_signal_subscribe",
      guint,
      gp, // connection
      str, // sender
      str, // interface_name
      str, // member
      str, // object_path
      str, // arg0
      ctypes.int, // GDBusSignalFlags flags
      this.SignalFn.ptr, // callback
      gp, // user_data
      this.DestroyNotifyFn.ptr // user_data_free_func
    );
    this.g_dbus_connection_signal_unsubscribe = g(this.gio, "g_dbus_connection_signal_unsubscribe", ctypes.void_t, gp, guint);
    this.g_dbus_method_invocation_return_value = g(this.gio, "g_dbus_method_invocation_return_value", ctypes.void_t, gp, gp);
    this.g_dbus_method_invocation_return_dbus_error = g(
      this.gio,
      "g_dbus_method_invocation_return_dbus_error",
      ctypes.void_t,
      gp,
      str,
      str
    );
  }

  close() {
    for (const lib of [this.gio, this.gobject, this.glib]) {
      try {
        lib.close();
      } catch (e) {
        console.error(e);
      }
    }
  }

  // ---- GVariant builders (all return floating references) ----

  str(value) {
    return this.g_variant_new_string(String(value));
  }
  objectPath(value) {
    return this.g_variant_new_object_path(value);
  }
  int32(value) {
    return this.g_variant_new_int32(value | 0);
  }
  uint32(value) {
    return this.g_variant_new_uint32(value >>> 0);
  }
  bool(value) {
    return this.g_variant_new_boolean(value ? 1 : 0);
  }
  variant(child) {
    return this.g_variant_new_variant(child);
  }
  tuple(children) {
    if (!children.length) {
      return this.g_variant_new_tuple(null, 0);
    }
    const arr = SystemTrayCtypes.voidptr_t.array(children.length)(children);
    return this.g_variant_new_tuple(arr, children.length);
  }
  /**
   * @param {string} elementType - GVariant type string of the elements.
   * @param {CData[]} children - Floating GVariant pointers.
   */
  array(elementType, children) {
    const type = this.g_variant_type_new(elementType);
    try {
      if (!children.length) {
        return this.g_variant_new_array(type, null, 0);
      }
      const arr = SystemTrayCtypes.voidptr_t.array(children.length)(children);
      return this.g_variant_new_array(type, arr, children.length);
    } finally {
      this.g_variant_type_free(type);
    }
  }
  /** Build an a{sv} dictionary from a plain object of already built variants. */
  dict(entries) {
    return this.array(
      "{sv}",
      Object.entries(entries).map(([key, value]) =>
        this.g_variant_new_dict_entry(this.str(key), this.variant(value))
      )
    );
  }
  bytes(uint8Array) {
    const type = this.g_variant_type_new("y");
    try {
      // g_variant_new_fixed_array() copies the data.
      return this.g_variant_new_fixed_array(type, uint8Array, uint8Array.length, 1);
    } finally {
      this.g_variant_type_free(type);
    }
  }

  // ---- GVariant readers (borrowed input, no ownership transfer) ----

  childCount(variant) {
    return parseInt(this.g_variant_n_children(variant).toString(), 10);
  }
  /** Run fn(child) with a temporary reference to child #index. */
  withChild(variant, index, fn) {
    const child = this.g_variant_get_child_value(variant, index);
    try {
      return fn(child);
    } finally {
      this.g_variant_unref(child);
    }
  }
  childInt32(variant, index) {
    return this.withChild(variant, index, c => this.g_variant_get_int32(c));
  }
  childUint32(variant, index) {
    return this.withChild(variant, index, c => this.g_variant_get_uint32(c));
  }
  childString(variant, index) {
    return this.withChild(variant, index, c =>
      this.g_variant_get_string(c, null).readString()
    );
  }
  /** Read an "ai" child as a JS array of numbers. */
  childInt32Array(variant, index) {
    return this.withChild(variant, index, arr => {
      const result = [];
      const n = this.childCount(arr);
      for (let i = 0; i < n; i++) {
        result.push(this.childInt32(arr, i));
      }
      return result;
    });
  }

  /** Create an out-parameter for a GError and a helper to consume it. */
  makeError() {
    const errorPtr = this.GError.ptr();
    return {
      address: errorPtr.address(),
      take: () => {
        if (errorPtr.isNull()) {
          return null;
        }
        // Each makeError() result is meant for exactly one call.
        const message = errorPtr.contents.message.readString();
        this.g_error_free(errorPtr);
        return message;
      },
    };
  }
};

/**
 * The tray icon itself: exports the SNI + dbusmenu objects, owns the bus name,
 * registers with the watcher and forwards user interaction to `listener`.
 */
var SystemTrayService = class {
  /**
   * @param {object} listener - { onActivate(token), onSecondaryActivate(token),
   *   onMenuItemClicked(id), onAvailabilityChanged(available) }
   */
  constructor(listener) {
    this.listener = listener;
    this.lib = null;
    this.connection = null;
    this.nodeInfo = null;
    this.busName = null; // Well-known name, if we own one.
    this.menuPath = null;
    this.registrationIds = [];
    this.watcherSubscriptionId = 0;
    // Private GMainContext all our D-Bus callbacks are dispatched in, and the
    // timer that iterates it.
    this.context = null;
    this.pumpTimer = null;
    this.lastActivity = 0;
    this.finalizeDeadline = 0;
    this.finalizeScheduled = false;
    // Number of GDestroyNotify callbacks GLib still owes us.
    this.pendingDestroyNotifies = 0;
    this.destroyed = false;
    this.available = false;

    // Item state.
    this.title = "Thunderbird";
    this.itemId = "thunderbird-close-to-tray";
    this.icons = []; // [{ width, height, argb: Uint8Array }]
    this.toolTipTitle = "";
    this.toolTipDescription = "";
    this.activationToken = "";

    // Menu state. dbusmenu ids are int32; 0 is the root.
    this.menuItems = []; // [{ dbusId, id, type, label, enabled, visible }]
    this.menuRevision = 1;

    // C callbacks (kept alive until GLib released them, see maybeFinalize()).
    this.callbacks = null;
  }

  /**
   * @returns {boolean} true if a tray host accepted the icon.
   */
  create(properties) {
    if (this.connection) {
      return this.available;
    }
    this.title = properties.title || this.title;

    const lib = (this.lib = new SystemTrayGLib());

    const error = lib.makeError();
    const G_BUS_TYPE_SESSION = 2;
    this.connection = lib.g_bus_get_sync(G_BUS_TYPE_SESSION, null, error.address);
    const busError = error.take();
    if (busError || this.connection.isNull()) {
      this.connection = null;
      throw new Error(`Cannot connect to the session bus: ${busError}`);
    }

    const xmlErrorOut = lib.makeError();
    this.nodeInfo = lib.g_dbus_node_info_new_for_xml(
      SYSTEM_TRAY_INTROSPECTION_XML,
      xmlErrorOut.address
    );
    const xmlError = xmlErrorOut.take();
    if (xmlError) {
      this.nodeInfo = null;
      throw new Error(`Invalid introspection data: ${xmlError}`);
    }

    this.createCallbacks();

    this.context = lib.g_main_context_new();
    // Started first so that GDestroyNotify is delivered even if exporting
    // fails half-way and destroy() is called.
    this.startPump();
    lib.g_main_context_push_thread_default(this.context);
    try {
      this.exportObjects();
    } finally {
      lib.g_main_context_pop_thread_default(this.context);
    }

    this.available = this.registerWithWatcher();
    return this.available;
  }

  /** Must be called with this.context pushed as thread-default context. */
  exportObjects() {
    const lib = this.lib;

    // Export /StatusNotifierItem.
    this.registerObject(SYSTEM_TRAY_ITEM_PATH, SYSTEM_TRAY_SNI_IFACE);

    // Export the menu on the first permitted path that is still free.
    for (const path of SYSTEM_TRAY_MENU_PATHS) {
      try {
        this.registerObject(path, SYSTEM_TRAY_MENU_IFACE);
        this.menuPath = path;
        break;
      } catch (e) {
        console.warn(`systemTray: menu path ${path} unavailable: ${e.message}`);
      }
    }
    if (!this.menuPath) {
      throw new Error("Could not export the tray menu object");
    }

    this.busName = this.requestBusName();

    // Re-register whenever the watcher (e.g. plasmashell/kded) restarts.
    this.pendingDestroyNotifies++;
    this.watcherSubscriptionId = lib.g_dbus_connection_signal_subscribe(
      this.connection,
      "org.freedesktop.DBus",
      "org.freedesktop.DBus",
      "NameOwnerChanged",
      "/org/freedesktop/DBus",
      SYSTEM_TRAY_WATCHER_NAME,
      0,
      this.callbacks.signal,
      null,
      this.callbacks.destroyNotify
    );
  }

  // ---- Private main context pump ----

  startPump() {
    this.pumpTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this.pumpTimer.initWithCallback(
      () => this.pump(),
      SYSTEM_TRAY_PUMP_IDLE_MS,
      Ci.nsITimer.TYPE_REPEATING_SLACK
    );
  }

  /** Dispatch everything that is ready in our private context (non-blocking). */
  pump() {
    if (!this.lib || !this.context) {
      return;
    }
    let dispatched = 0;
    try {
      while (dispatched < 64 && this.lib.g_main_context_iteration(this.context, 0)) {
        dispatched++;
      }
    } catch (e) {
      console.error(e);
    }
    const now = Date.now();
    if (dispatched) {
      this.lastActivity = now;
    }
    const delay =
      now - this.lastActivity < SYSTEM_TRAY_PUMP_ACTIVE_PERIOD_MS
        ? SYSTEM_TRAY_PUMP_ACTIVE_MS
        : SYSTEM_TRAY_PUMP_IDLE_MS;
    if (this.pumpTimer && this.pumpTimer.delay != delay) {
      this.pumpTimer.delay = delay;
    }
    if (this.destroyed) {
      this.maybeFinalize();
    }
  }

  createCallbacks() {
    const lib = this.lib;
    const callbacks = {};

    callbacks.methodCall = lib.MethodCallFn.ptr(
      (conn, sender, path, iface, method, params, invocation) => {
        this.handleMethodCall(
          path.readString(),
          iface.readString(),
          method.readString(),
          params,
          invocation
        );
      }
    );

    callbacks.getProperty = lib.GetPropertyFn.ptr(
      (conn, sender, path, iface, property) => {
        try {
          return this.getProperty(iface.readString(), property.readString());
        } catch (e) {
          console.error(e);
          return SystemTrayCtypes.voidptr_t(0);
        }
      },
      null,
      SystemTrayCtypes.voidptr_t(0)
    );

    // All our properties are read-only; GDBus rejects writes before calling
    // this, but a vtable entry is still required to be valid or NULL.
    callbacks.setProperty = lib.SetPropertyFn.ptr(() => 0, null, 0);

    callbacks.signal = lib.SignalFn.ptr(
      (conn, senderName, objectPath, ifaceName, signalName, params) => {
        try {
          // NameOwnerChanged (s name, s old_owner, s new_owner)
          const newOwner = lib.childString(params, 2);
          this.onWatcherOwnerChanged(newOwner);
        } catch (e) {
          console.error(e);
        }
      }
    );

    callbacks.destroyNotify = lib.DestroyNotifyFn.ptr(() => {
      this.pendingDestroyNotifies--;
      this.maybeFinalize();
    });

    callbacks.vtable = new lib.VTable();
    callbacks.vtable.method_call = callbacks.methodCall;
    callbacks.vtable.get_property = callbacks.getProperty;
    callbacks.vtable.set_property = callbacks.setProperty;

    this.callbacks = callbacks;
  }

  registerObject(path, interfaceName) {
    const lib = this.lib;
    const ifaceInfo = lib.g_dbus_node_info_lookup_interface(this.nodeInfo, interfaceName);
    const error = lib.makeError();
    const id = lib.g_dbus_connection_register_object(
      this.connection,
      path,
      ifaceInfo,
      this.callbacks.vtable.address(),
      null,
      this.callbacks.destroyNotify,
      error.address
    );
    const message = error.take();
    if (message || !id) {
      // On failure GLib does not call the destroy notify.
      throw new Error(message || `register_object failed for ${path}`);
    }
    this.pendingDestroyNotifies++;
    this.registrationIds.push(id);
  }

  /** Synchronous call on the bus driver / watcher. Returns the reply or throws. */
  callSync(busName, path, iface, method, params, timeout = 3000) {
    const lib = this.lib;
    const error = lib.makeError();
    const reply = lib.g_dbus_connection_call_sync(
      this.connection,
      busName,
      path,
      iface,
      method,
      params,
      null,
      0,
      timeout,
      null,
      error.address
    );
    const message = error.take();
    if (message) {
      throw new Error(message);
    }
    return reply;
  }

  /**
   * Try to own org.freedesktop.StatusNotifierItem-<PID>-<N>. Returns the name
   * or null (e.g. inside Flatpak, which only allows names below the app id);
   * in that case the item is registered via our unique connection name.
   */
  requestBusName() {
    const lib = this.lib;
    const pid = Services.appinfo.processID;
    const DBUS_NAME_FLAG_DO_NOT_QUEUE = 4;
    const PRIMARY_OWNER = 1;
    const ALREADY_OWNER = 4;
    for (let n = SYSTEM_TRAY_FIRST_NAME_INDEX; n < SYSTEM_TRAY_FIRST_NAME_INDEX + 10; n++) {
      const name = `org.freedesktop.StatusNotifierItem-${pid}-${n}`;
      let reply;
      try {
        reply = this.callSync(
          "org.freedesktop.DBus",
          "/org/freedesktop/DBus",
          "org.freedesktop.DBus",
          "RequestName",
          lib.tuple([lib.str(name), lib.uint32(DBUS_NAME_FLAG_DO_NOT_QUEUE)])
        );
      } catch (e) {
        console.warn(`systemTray: cannot own a bus name (${e.message}); using the unique name.`);
        return null;
      }
      const result = lib.childUint32(reply, 0);
      lib.g_variant_unref(reply);
      if (result == PRIMARY_OWNER || result == ALREADY_OWNER) {
        return name;
      }
    }
    return null;
  }

  releaseBusName() {
    if (!this.busName) {
      return;
    }
    const lib = this.lib;
    try {
      const reply = this.callSync(
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "ReleaseName",
        lib.tuple([lib.str(this.busName)]),
        1000
      );
      lib.g_variant_unref(reply);
    } catch (e) {
      console.warn(`systemTray: ReleaseName failed: ${e.message}`);
    }
    this.busName = null;
  }

  /** @returns {boolean} true if the watcher accepted the registration. */
  registerWithWatcher() {
    const lib = this.lib;
    // The watcher accepts either a bus name or an object path; with a path it
    // uses the sender's unique name.
    const service = this.busName || SYSTEM_TRAY_ITEM_PATH;
    try {
      const reply = this.callSync(
        SYSTEM_TRAY_WATCHER_NAME,
        SYSTEM_TRAY_WATCHER_PATH,
        SYSTEM_TRAY_WATCHER_NAME,
        "RegisterStatusNotifierItem",
        lib.tuple([lib.str(service)])
      );
      lib.g_variant_unref(reply);
      return true;
    } catch (e) {
      console.warn(`systemTray: no StatusNotifierWatcher available (${e.message})`);
      return false;
    }
  }

  onWatcherOwnerChanged(newOwner) {
    if (this.destroyed) {
      return;
    }
    const available = newOwner ? this.registerWithWatcher() : false;
    if (available != this.available) {
      this.available = available;
      this.notify("onAvailabilityChanged", available);
    }
  }

  /** Forward an event to the extension asynchronously (outside the C stack). */
  notify(method, ...args) {
    Promise.resolve().then(() => {
      if (!this.destroyed) {
        this.listener[method](...args);
      }
    });
  }

  // ---- Incoming D-Bus calls ----

  handleMethodCall(path, iface, method, params, invocation) {
    const lib = this.lib;
    let reply = null;
    try {
      reply =
        iface == SYSTEM_TRAY_SNI_IFACE
          ? this.handleItemCall(method, params)
          : this.handleMenuCall(method, params);
    } catch (e) {
      console.error(e);
      lib.g_dbus_method_invocation_return_dbus_error(
        invocation,
        "org.freedesktop.DBus.Error.Failed",
        String(e.message || e)
      );
      return;
    }
    // Exactly one reply per invocation; an empty tuple for void methods.
    lib.g_dbus_method_invocation_return_value(invocation, reply || lib.tuple([]));
  }

  handleItemCall(method, params) {
    switch (method) {
      case "ProvideXdgActivationToken":
        // KDE Plasma sends this right before Activate/SecondaryActivate.
        this.activationToken = this.lib.childString(params, 0);
        break;
      case "Activate":
        this.notify("onActivate", this.takeActivationToken());
        break;
      case "SecondaryActivate":
        this.notify("onSecondaryActivate", this.takeActivationToken());
        break;
      case "ContextMenu":
      case "Scroll":
        // The host shows our dbusmenu itself; scrolling is not used.
        break;
    }
    return null;
  }

  takeActivationToken() {
    const token = this.activationToken;
    this.activationToken = "";
    return token;
  }

  handleMenuCall(method, params) {
    const lib = this.lib;
    switch (method) {
      case "GetLayout": {
        const parentId = lib.childInt32(params, 0);
        return lib.tuple([lib.uint32(this.menuRevision), this.buildLayout(parentId)]);
      }
      case "GetGroupProperties": {
        const ids = lib.childInt32Array(params, 0);
        const items = ids.length
          ? this.menuItems.filter(item => ids.includes(item.dbusId))
          : this.menuItems;
        return lib.tuple([
          lib.array(
            "(ia{sv})",
            items.map(item =>
              lib.tuple([lib.int32(item.dbusId), this.buildItemProperties(item)])
            )
          ),
        ]);
      }
      case "GetProperty": {
        const id = lib.childInt32(params, 0);
        const name = lib.childString(params, 1);
        const item = this.menuItems.find(i => i.dbusId == id);
        const value = item && this.buildItemPropertyMap(item)[name];
        if (!value) {
          throw new Error(`Unknown menu property ${id}/${name}`);
        }
        return lib.tuple([lib.variant(value())]);
      }
      case "Event": {
        const id = lib.childInt32(params, 0);
        const eventId = lib.childString(params, 1);
        this.handleMenuEvent(id, eventId);
        return null;
      }
      case "EventGroup": {
        const idErrors = [];
        lib.withChild(params, 0, events => {
          const n = lib.childCount(events);
          for (let i = 0; i < n; i++) {
            lib.withChild(events, i, event => {
              const id = lib.childInt32(event, 0);
              if (!this.handleMenuEvent(id, lib.childString(event, 1))) {
                idErrors.push(id);
              }
            });
          }
        });
        return lib.tuple([lib.array("i", idErrors.map(id => lib.int32(id)))]);
      }
      case "AboutToShow":
        return lib.tuple([lib.bool(false)]);
      case "AboutToShowGroup":
        return lib.tuple([lib.array("i", []), lib.array("i", [])]);
    }
    return null;
  }

  /** @returns {boolean} false if the id is unknown. */
  handleMenuEvent(dbusId, eventId) {
    if (dbusId == 0) {
      return true;
    }
    const item = this.menuItems.find(i => i.dbusId == dbusId);
    if (!item) {
      return false;
    }
    if (eventId == "clicked" && item.type != "separator" && item.enabled) {
      this.notify("onMenuItemClicked", item.id);
    }
    return true;
  }

  getProperty(iface, property) {
    const lib = this.lib;
    if (iface == SYSTEM_TRAY_MENU_IFACE) {
      switch (property) {
        case "Version":
          return lib.uint32(3);
        case "TextDirection":
          return lib.str("ltr");
        case "Status":
          return lib.str("normal");
        case "IconThemePath":
          return lib.array("s", []);
      }
      return SystemTrayCtypes.voidptr_t(0);
    }

    switch (property) {
      case "Category":
        return lib.str("Communications");
      case "Id":
        return lib.str(this.itemId);
      case "Title":
        return lib.str(this.title);
      case "Status":
        return lib.str("Active");
      case "WindowId":
        return lib.int32(0);
      case "IconThemePath":
      case "IconName":
      case "OverlayIconName":
      case "AttentionIconName":
      case "AttentionMovieName":
        return lib.str("");
      case "IconPixmap":
        return this.buildPixmaps(this.icons);
      case "OverlayIconPixmap":
      case "AttentionIconPixmap":
        return this.buildPixmaps([]);
      case "ToolTip":
        return lib.tuple([
          lib.str(""),
          this.buildPixmaps([]),
          lib.str(this.toolTipTitle),
          lib.str(this.toolTipDescription),
        ]);
      case "ItemIsMenu":
        return lib.bool(false);
      case "Menu":
        return lib.objectPath(this.menuPath);
    }
    return SystemTrayCtypes.voidptr_t(0);
  }

  // ---- GVariant construction for our data ----

  buildPixmaps(icons) {
    const lib = this.lib;
    return lib.array(
      "(iiay)",
      icons.map(icon =>
        lib.tuple([lib.int32(icon.width), lib.int32(icon.height), lib.bytes(icon.argb)])
      )
    );
  }

  /** Lazily evaluated property builders of a menu item, keyed by dbusmenu name. */
  buildItemPropertyMap(item) {
    const lib = this.lib;
    if (item.type == "separator") {
      return {
        type: () => lib.str("separator"),
        visible: () => lib.bool(item.visible),
      };
    }
    return {
      // dbusmenu treats "_" as a mnemonic marker; escape literal underscores.
      label: () => lib.str(item.label.replace(/_/g, "__")),
      enabled: () => lib.bool(item.enabled),
      visible: () => lib.bool(item.visible),
    };
  }

  buildItemProperties(item) {
    const props = {};
    for (const [name, build] of Object.entries(this.buildItemPropertyMap(item))) {
      props[name] = build();
    }
    return this.lib.dict(props);
  }

  buildLayout(parentId) {
    const lib = this.lib;
    if (parentId != 0) {
      const item = this.menuItems.find(i => i.dbusId == parentId);
      if (!item) {
        throw new Error(`Unknown menu id ${parentId}`);
      }
      return lib.tuple([lib.int32(item.dbusId), this.buildItemProperties(item), lib.array("v", [])]);
    }
    const children = this.menuItems.map(item =>
      lib.variant(
        lib.tuple([lib.int32(item.dbusId), this.buildItemProperties(item), lib.array("v", [])])
      )
    );
    return lib.tuple([
      lib.int32(0),
      lib.dict({ "children-display": lib.str("submenu") }),
      lib.array("v", children),
    ]);
  }

  emitSignal(path, iface, name, params) {
    const lib = this.lib;
    const error = lib.makeError();
    lib.g_dbus_connection_emit_signal(this.connection, null, path, iface, name, params, error.address);
    const message = error.take();
    if (message) {
      console.warn(`systemTray: cannot emit ${name}: ${message}`);
    }
  }

  // ---- Updates coming from the extension ----

  setIcon(images) {
    this.icons = images.map(image => {
      // The experiment sandbox has no atob(); ChromeUtils decodes base64url.
      const rgba = new Uint8Array(
        ChromeUtils.base64URLDecode(
          image.rgba.replace(/\+/g, "-").replace(/\//g, "_"),
          { padding: "ignore" }
        )
      );
      if (rgba.length != image.width * image.height * 4) {
        throw new Error("Icon data size does not match its dimensions");
      }
      // SNI expects ARGB32 in network byte order: A, R, G, B per pixel.
      const argb = new Uint8Array(rgba.length);
      for (let i = 0; i < rgba.length; i += 4) {
        argb[i] = rgba[i + 3];
        argb[i + 1] = rgba[i];
        argb[i + 2] = rgba[i + 1];
        argb[i + 3] = rgba[i + 2];
      }
      return { width: image.width, height: image.height, argb };
    });
    if (this.connection) {
      this.emitSignal(SYSTEM_TRAY_ITEM_PATH, SYSTEM_TRAY_SNI_IFACE, "NewIcon", null);
    }
  }

  setToolTip(title, description) {
    this.toolTipTitle = title;
    this.toolTipDescription = description;
    if (this.connection) {
      this.emitSignal(SYSTEM_TRAY_ITEM_PATH, SYSTEM_TRAY_SNI_IFACE, "NewToolTip", null);
    }
  }

  setMenu(items) {
    this.menuItems = items.map((item, index) => ({
      dbusId: index + 1,
      id: item.id,
      type: item.type || "normal",
      label: item.label || "",
      enabled: item.enabled !== false,
      visible: item.visible !== false,
    }));
    this.menuRevision++;
    if (this.connection) {
      const lib = this.lib;
      this.emitSignal(
        this.menuPath,
        SYSTEM_TRAY_MENU_IFACE,
        "LayoutUpdated",
        lib.tuple([lib.uint32(this.menuRevision), lib.int32(0)])
      );
    }
  }

  // ---- Teardown ----

  /**
   * Remove everything from the bus. C callbacks and libraries are released in
   * maybeFinalize() once GLib confirmed (via GDestroyNotify) that it will not
   * call them anymore.
   */
  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (!this.lib) {
      return;
    }
    const lib = this.lib;
    if (this.connection) {
      if (this.watcherSubscriptionId) {
        lib.g_dbus_connection_signal_unsubscribe(this.connection, this.watcherSubscriptionId);
        this.watcherSubscriptionId = 0;
      }
      for (const id of this.registrationIds) {
        lib.g_dbus_connection_unregister_object(this.connection, id);
      }
      this.registrationIds = [];
      // Releasing the well-known name makes the watcher drop the icon.
      this.releaseBusName();
    }
    if (this.nodeInfo) {
      lib.g_dbus_node_info_unref(this.nodeInfo);
      this.nodeInfo = null;
    }
    this.maybeFinalize();
  }

  maybeFinalize() {
    if (!this.destroyed || !this.lib || this.finalizeScheduled) {
      return;
    }
    if (this.pendingDestroyNotifies > 0) {
      if (!this.pumpTimer) {
        return;
      }
      // Keep pumping until GLib delivered all GDestroyNotify callbacks, but do
      // not spin forever: after the deadline the timer stops and the callbacks
      // and libraries are intentionally kept alive (never freed while GLib may
      // still reference them).
      if (!this.finalizeDeadline) {
        this.finalizeDeadline = Date.now() + SYSTEM_TRAY_FINALIZE_TIMEOUT_MS;
      } else if (Date.now() > this.finalizeDeadline) {
        console.warn("systemTray: GLib did not release all callbacks; keeping them alive.");
        this.stopPump();
      }
      return;
    }
    // We may be inside a ctypes callback right now; finish on a clean stack.
    this.finalizeScheduled = true;
    Services.tm.dispatchToMainThread(() => {
      this.stopPump();
      if (!this.lib) {
        return;
      }
      if (this.connection) {
        // g_bus_get_sync() returned a reference to the shared connection.
        this.lib.g_object_unref(this.connection);
        this.connection = null;
      }
      if (this.context) {
        this.lib.g_main_context_unref(this.context);
        this.context = null;
      }
      this.callbacks = null;
      this.lib.close();
      this.lib = null;
    });
  }

  stopPump() {
    this.pumpTimer?.cancel();
    this.pumpTimer = null;
  }
};

this.systemTray = class extends SystemTrayExtensionCommon.ExtensionAPI {
  constructor(extension) {
    super(extension);
    this.service = null;
    this.eventListeners = {
      onActivate: new Set(),
      onSecondaryActivate: new Set(),
      onMenuItemClicked: new Set(),
      onAvailabilityChanged: new Set(),
    };
  }

  emit(eventName, ...args) {
    for (const fire of this.eventListeners[eventName]) {
      fire.async(...args);
    }
  }

  getAPI(context) {
    const api = this;
    const makeEvent = name =>
      new SystemTrayExtensionCommon.EventManager({
        context,
        name: `systemTray.${name}`,
        register: fire => {
          api.eventListeners[name].add(fire);
          return () => api.eventListeners[name].delete(fire);
        },
      }).api();

    return {
      systemTray: {
        async create(properties) {
          if (SystemTrayAppConstants.platform != "linux") {
            return false;
          }
          if (!api.service) {
            api.service = new SystemTrayService({
              onActivate: token => api.emit("onActivate", token),
              onSecondaryActivate: token => api.emit("onSecondaryActivate", token),
              onMenuItemClicked: id => api.emit("onMenuItemClicked", id),
              onAvailabilityChanged: available => api.emit("onAvailabilityChanged", available),
            });
          }
          try {
            return api.service.create(properties);
          } catch (e) {
            console.error("systemTray: failed to create the tray icon", e);
            api.service.destroy();
            api.service = null;
            return false;
          }
        },
        async setIcon(images) {
          api.service?.setIcon(images);
        },
        async setToolTip(title, description) {
          api.service?.setToolTip(title, description);
        },
        async setMenu(items) {
          api.service?.setMenu(items);
        },
        async destroy() {
          api.service?.destroy();
          api.service = null;
        },
        onActivate: makeEvent("onActivate"),
        onSecondaryActivate: makeEvent("onSecondaryActivate"),
        onMenuItemClicked: makeEvent("onMenuItemClicked"),
        onAvailabilityChanged: makeEvent("onAvailabilityChanged"),
      },
    };
  }

  onShutdown(isAppShutdown) {
    // Always remove the icon from the bus: on add-on disable/uninstall this is
    // required, on application shutdown it is cheap and keeps hosts tidy.
    this.service?.destroy();
    this.service = null;
    for (const listeners of Object.values(this.eventListeners)) {
      listeners.clear();
    }
  }
};
