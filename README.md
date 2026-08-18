# Graph Home Advanced

An advanced, deeply customizable Chrome New Tab replacement that turns your bookmarks and favorites into an interactive force-directed graph — now with **2D/3D modes, full theming, search, safer local storage, and a real settings panel.**

---

## 🚀 How to Use

1. Extract this folder (keep the `vendor`, `css`, `js` subfolders together).
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder.
5. Open a new tab.

### Settings

Click the ⚙️ icon in the top bar to open the settings panel, or go to `chrome://extensions` → Graph Home Advanced → **Extension options** for the same panel full-page.

- **Appearance** — theme presets, custom colors, labels, sound
- **Graph** — 2D/3D mode, physics tuning, max visible nodes
- **Visibility** — see and restore hidden nodes
- **Data** — auto-backup settings, restore from a snapshot, export/import JSON
- **About** — reset everything to defaults

### Controls

| Action | Result |
|---|---|
| Click a link node | Opens the URL in a new tab |
| Click a folder node | Enters that folder (Explore) or jumps to it (Whole picture) |
| Double-click a node | Opens the edit modal |
| Right-click a node | Edit / **Hide** / Delete, plus Add options on favorite folders |
| Search bar | Live results as you type; click a result to jump to it |
| `+` button (Favorites mode) | Adds a new link or folder to the current context |
| 2D mode: drag empty space | Pan |
| 2D mode: scroll | Zoom |
| 3D mode: drag | Rotate |
| 3D mode: scroll | Zoom |
| 🔊 icon | Mute/unmute sound effects |
| ⚙️ icon | Open Settings |

---

## 🗄️ Data Storage & Safety

Favorites are stored in `chrome.storage.local` as a flat list mirroring Chrome's bookmark tree shape:

```js
{ id, title, url, type: 'link' | 'folder', parentId }
```

Every add/edit/delete also pushes a timestamped snapshot into a rolling backup ring (default: last 10), configurable in Settings → Data. You can:

- **Restore** any recent snapshot with one click
- **Export** a full JSON backup (favorites + hidden-node state + settings) to a file at any time
- **Import** that file later — merge into your current favorites, or replace them entirely
- Get a **reminder toast** if you haven't exported in a while (configurable, default 14 days)

Bookmarks mode is unchanged: it reads/writes your real Chrome bookmarks directly via `chrome.bookmarks`, so nothing is duplicated there.

No data ever leaves your browser.

## 🔐 Permissions

- `bookmarks` — read/edit/delete real Chrome bookmarks in Bookmarks mode
- `storage` — persist Favorites, hidden-node sets, backups, and settings
- `downloads` — save your manual export file

## 🧰 Tech Stack

- [Three.js](https://threejs.org/) (bundled under `vendor/`) for the 3D scene
- A hand-rolled Canvas 2D engine for the lightweight 2D mode
- Vanilla JS ES modules (no build step), Web Audio API for sound

## 🤝 Contributing

Contributions welcome — open an issue or PR.

## 🛡️ License

MIT — see [LICENSE](LICENSE).
