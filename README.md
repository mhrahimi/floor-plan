# Floor Planner

A simple floor plan drawing tool that runs entirely in the browser. There's no build step and there are no external libraries. It's an installable app (PWA): add it to your home screen, dock or desktop, and it works offline.

## Features

- **Walls**: click corner to corner. While drawing, type an exact length (`3.5`, `350cm`, `12'6"`) and press Enter.
- **Rooms**: drag a rectangle and walls are built around it, or type a size like `4 x 3`. To name a space you've already enclosed, click inside its walls. Closing a wall loop asks for the room's name, and every room shows its area.
- **Doors and windows**: single, double and sliding doors, windows, and open doorways. They snap onto walls and cut the opening. You can flip the swing or hinge side and set the exact distance from either end of the wall.
- **Stairs and objects**: straight and spiral stairs, columns, kitchen and bath fixtures, and furniture. You can move, rotate, mirror, resize and label them.
- **Dimensions**: wall lengths are shown automatically. The dimension tool measures between any two points, and one click adds overall dimensions.
- **Units**: metres, centimetres, millimetres, feet and inches, or inches. Switching units at any time just changes how lengths are shown.
- **Saving**: drawings are saved by name on the device, and the open drawing is autosaved. Saved drawings can be opened, renamed, duplicated or deleted.
- **Import and export drawings**: *Export → Drawing file* downloads a `.floorplan` file, and *Import* (or dropping the file onto the page) adds it back to your drawings on any device. *Export → All saved drawings* puts every drawing in one file. Older `.json` backups still import.
- **Export as PNG**: choose Small, Medium or Large (1200, 2400 or 4000 px on the long side) and a white or transparent background. You can also turn the title and scale bar, room names, areas and colours, wall lengths, dimension lines, furniture and grid on or off. A live preview shows the result. Download it, or copy it straight to the clipboard.
- Also exports SVG and print/PDF.
- **Apple Pencil**: once the Pencil touches the screen, the Pencil draws and edits, and your fingers only pan and pinch to zoom, so a resting palm won't draw anything. Draw a wall with one Pencil stroke or tap from corner to corner, then tap **Finish**. Without a Pencil, fingers draw as usual. You can turn this off in the panel under View.
- **Installable and offline**: after the first visit, the app opens and works with no connection. New versions you deploy show up the next time it's opened online.
- Undo and redo, snapping (hold Alt to turn it off), keyboard shortcuts (press `?` in the app), and touch support with pinch to zoom.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app |
| `manifest.webmanifest` | App name, icons and colours used when it's installed |
| `sw.js` | Service worker that makes it work offline |
| `icons/` | App icons (Android, iPhone/iPad, desktop, favicon) |
| `screenshots/` | Previews shown in Chrome's install dialog |

## Put it on GitHub Pages

1. Create a new repository on GitHub, for example `floor-planner`.
2. Upload **everything** in this folder to the root of the repository, keeping the `icons` and `screenshots` folders. The easiest way is to drag the files and both folders onto the repository's "Add file → Upload files" page.
3. Go to **Settings → Pages**. Under "Build and deployment", set **Source** to *Deploy from a branch*, then choose the `main` branch and the `/ (root)` folder. Click **Save**.
4. After a minute the site is live at `https://<your-username>.github.io/floor-planner/`.

All paths are relative, so it works at any repository name or at the root of a custom domain.

## Try it on your computer before deploying

Offline support and installing only work when the app is served over `http://localhost` or `https://`, not when `index.html` is opened directly as a file. To test it the way GitHub Pages will serve it:

```sh
cd floor-planner        # this folder
python3 -m http.server 8000
```

Then open <http://localhost:8000/> in Chrome or Edge. The Install button appears in the top bar after a moment. To check offline mode, open DevTools → Application → Service workers, tick **Offline**, and reload.

Opening `index.html` directly still works for drawing; it just won't install or cache itself.

## Installing the app

- **Chrome or Edge (Windows, Mac, Linux, Android)**: use the **Install** button in the top bar, or the install icon in the address bar.
- **iPhone and iPad**: open the site in Safari, tap **Share**, then **Add to Home Screen**.
- **Safari on a Mac**: choose **File → Add to Dock**.

## Publishing updates

- Changes to `index.html` reach users the next time they open the app while online. There's nothing else to do.
- If you change the icons or `manifest.webmanifest`, also change `VERSION` in `sw.js` (for example `'v1'` → `'v2'`). The app then replaces its offline copy and removes the old one.

## Where drawings are stored

Drawings stay on the device where they were made. Nothing is uploaded anywhere.

- A drawing saved on your laptop won't appear on your phone. To move one, use **Export → Drawing file**, then **Import** it on the other device.
- **iPhone and iPad keep Home Screen apps separate from Safari.** Drawings made in Safari don't appear in the installed app, and the other way round. To bring drawings over, open the site in Safari, choose **Export → All saved drawings**, then **Import** that file in the Home Screen app. The app shows a reminder about this when it's first opened from the Home Screen.
- In the Home Screen app on iPhone and iPad, exports open the share sheet (Save Image, Save to Files, AirDrop), because file downloads don't work reliably there.
- Clearing the browser's site data deletes saved drawings, so use **Export → All saved drawings** now and then as a backup.
- On GitHub Pages, every repository under `<username>.github.io` shares the same storage. The app prefixes its keys with `floorplanner.` so it won't collide with other projects.
