# Cheezy Launcher



Cheezy Launcher is a modern Pizza Tower Mod Manager, inspired of [Pizza Oven](https://github.com/TekkaGB/PizzaOven), but built with JavaScript and Rust (Tauri).

It aims to improve the Pizza Tower Modding Community experience by providing a more advanced launcher with additional features such as:



* Themes
* Proper GMLoader support
* Plugins (WIP)



Check the [Wiki](https://github.com/Aness6040/Cheezy-Launcher/wiki) for more information about Cheezy Launcher.

## ⚠️ WARNING: This project is still a Work In Progress (WIP). Expect bugs, missing features, and frequent changes.
## WINE/Proton (Steam) is required for the linux version (to make the xdelta patcher and the game working)
## Using Admin or Developer mode is more than recommended since it uses technologies like symlinks

### Fair Comparison

|Features|[Pizza Oven](https://github.com/TekkaGB/PizzaOven)|[Mod Organizer 2 (Senjay Edition)](https://github.com/Senjay-id/modorganizer2-senjay)|Cheezy Launcher|
|-|-|-|-|
|No admin rights or developer mode required|✅|✅|⚠️ Depends on the device and drive, it may disable VFS|
|VFS support|❌(Everything is overwritten and backed-up for mods)|✅ (USVFS)|⚠️ Yes but limited (depends on admin/dev permission, symlink)|
|Native linux support|❌|❌|✅ (You still need wine/proton to make the xdelta patcher and the game working)|
|Auto Updates|✅|❌|✅|
|Easy to use / Easy UI|✅|❌|✅|
|Simple Mod installation|✅|⚠️ xdelta mods require manual setup (GMLoader mods are easier)|✅|
|Plugins System|❌|✅|🚧 Very WIP and not sandboxed yet|
|Theme support|⚠️ [PO+](https://gamebanana.com/tools/21866) only|✅|✅|
|GMLoader support|⚠️ [PO+](https://gamebanana.com/tools/21866) only — GMLoader has limited support (manual workaround)|✅|✅|
|Gamebanana 1 click installer support|✅|❌|✅|

### Building Cheezy Launcher

Check the [Build page](./BUILD.md).


