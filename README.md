# Graph Home

A Chrome New Tab replacement that turns your bookmarks and favorites into an interactive, force-directed 3D graph instead of a plain list.

![manifest](https://img.shields.io/badge/manifest-v3-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![permissions](https://img.shields.io/badge/permissions-bookmarks%2C%20storage-lightgrey)

## ✨ Features

- **3D force-directed graph**: nodes repel each other and are pulled toward a central hub by spring physics, rendered with Three.js. Drag to rotate, scroll to zoom.
- **Two modes**:
  - ⭐ **Favorites** — your own curated links and folders, stored locally.
  - 📁 **Bookmarks** — your real Chrome bookmarks, read live via the `bookmarks` API.
- **Two views per mode**:
  - **Explore** — drill into one folder at a time, with breadcrumbs to navigate back up.
  - **Whole picture** — see the entire tree at once; click a folder to jump into Explore mode right there.
- **Full CRUD everywhere**: create, rename, and delete both links and folders, in both Favorites and Bookmarks.
- **Cascading delete previews**: deleting a folder highlights everything inside it and tells you what's about to go, before you confirm.
- **Right-click context menus**: Edit / Delete on any node, plus *Add favorite here* / *Add folder here* on favorite folders.
- **Synthesized sound effects**: small UI blips and clicks generated with the Web Audio API — no audio files, togglable via the speaker icon.

---

## 🚀 How to Use

1. **Clone the repository**:

   ```
   git clone https://github.com/siop1/GraphHomepage.git
   ```
   Or, you can simply download the zip and extract it.

2. **Load it into Chrome**:
   - Open `chrome://extensions`
   - Enable **Developer mode** (top-right toggle)
   - Click **Load unpacked** and select the `GraphHomepage` folder containing app.js and other files
3. **Open a new tab** — Graph Home replaces Chrome's default New Tab page.

### Controls

| Action | Result |
|---|---|
| Click a link node | Opens the URL in a new tab |
| Click a folder node | Enters that folder (Explore) or jumps to it (Whole picture) |
| Double-click a node | Opens the edit modal |
| Right-click a node | Opens a context menu (Edit / Delete, plus Add options on favorite folders) |
| `+` button (Favorites mode) | Adds a new link or folder to the current context |
| Breadcrumbs | Jump back up to any ancestor folder |
| 🔊 icon | Mute/unmute sound effects |

---

## 💻 Local Development

No build step, no framework, no dependencies to install — it's a plain unpacked Chrome extension.

### Prerequisites

- A Chromium-based browser (Chrome, Edge, Brave, etc.)

### Project Structure

```
GraphHomepage/
├── manifest.json         # Extension manifest (MV3)
├── newtab.html           # New Tab page markup (modals, context menu, controls)
├── style.css             # All UI styling
├── app.js                # Graph engine, state, rendering, and all interaction logic
└── vendor/               # Bundled Three.js, OrbitControls, CSS2DRenderer
```

### Running the Application

Just load the folder as an unpacked extension (see **How to Use** above) — there's no server or build process to run.

---

## 🗄️ Data Storage

Favorites are stored locally via `chrome.storage.local` as a flat list mirroring the shape of Chrome's own bookmark tree:

```js
{ id, title, url, type: 'link' | 'folder', parentId }
```

Top-level items have `parentId: 'root'`. Bookmarks are **not** duplicated into this storage — Bookmarks mode reads directly from `chrome.bookmarks`, so any edits or deletes there affect your real Chrome bookmarks.

## 🔐 Permissions

- `bookmarks` — to read/edit/delete real Chrome bookmarks in Bookmarks mode.
- `storage` — to persist your Favorites tree and sound preference locally.

No data ever leaves your browser.

## 🧰 Tech Stack

- [Three.js](https://threejs.org/) (bundled under `vendor/`) for the 3D scene, camera, and rendering
- `OrbitControls` for drag-to-rotate / scroll-to-zoom camera control
- `CSS2DRenderer` for crisp, always-readable node labels
- Vanilla JS + the Web Audio API

---

## 🤝 Contributing

Contributions are welcome! If you have suggestions for improvements or new features, feel free to open an issue or submit a pull request.

## 🛡️ License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
