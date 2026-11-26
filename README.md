# Floor Planner

A simple floor plan drawing tool that runs entirely in the browser. There's no build step and there are no external libraries. It's an installable app (PWA): add it to your home screen, dock or desktop, and it works offline.

## Features

- **Walls**: a new, empty drawing opens ready to draw walls: click corner to corner. While drawing, type an exact length (`3.5`, `350cm`, `12'6"`) and press Enter. The **Walls / Room** switch at the top changes between drawing walls and dragging out whole rooms, and **Done** (or `Esc`) stops drawing.
- **Change a wall's length**: click or tap a length on the plan and type a new one (or select a wall and press Enter, or use the panel). The right-hand end of the wall moves (the lower end of an upright wall). If the wall at that end turns a corner, it slides along too, so a rectangular room stays rectangular and doors stay where they were.
- **Rooms**: drag a rectangle and walls are built around it, or type a size like `4 x 3`. To turn a space you've already enclosed into a room, click inside its walls; closing a loop of walls adds a room too. New rooms are named Room 1, Room 2 and so on, with no box popping up: to rename one, select it and click its name, double-click it, or type in the panel. Every room shows its area.
- **Doors and windows**: single, double and sliding doors, windows, and open doorways. They snap onto walls and cut the opening. You can flip the swing or hinge side and set the exact distance from either end of the wall.
- **Heights**: each drawing has a ceiling height and default door, window and window-sill heights (2.5 m, 2.1 m, 1.2 m and 0.9 m; 8', 6' 8", 4' and 32" in feet and inches), set under *Heights* in the panel when nothing is selected. Select a room to give it its own ceiling height (its volume is shown too), a door or open doorway to set its height, or a window to set its width, height and sill height (how high it starts above the floor). Select several to set them all at once. Anything without its own height follows the drawing's.
- **Stairs and objects**: straight and spiral stairs, columns, kitchen and bath fixtures, and furniture. You can move, rotate, mirror, resize and label them.
- **People for scale**: standing, walking, sitting and wheelchair figures, in a male or a female style (pick one with the switch next to *People* in the library). A man starts at 1.75 m (5' 9") and a woman at 1.63 m (5' 4"). Select a person to change their pose, style or height, and their footprint follows. They show in 3D too, and can be left out of PNG exports and the 3D view.
- **Dimensions**: wall lengths are shown automatically. The dimension tool measures between any two points, and one click adds overall dimensions.
- **Units**: metres, centimetres, millimetres, feet and inches, or inches. Switching units at any time just changes how lengths are shown.
- **Saving**: drawings are saved by name on the device, and the open drawing is autosaved. Saved drawings can be opened, renamed, duplicated or deleted.
- **Import and export drawings**: *Export → Drawing file* downloads a `.floorplan` file, and *Import* (or dropping the file onto the page) adds it back to your drawings on any device. *Export → All saved drawings* puts every drawing in one file. Older `.json` backups still import.
- **Export as PNG**: choose Small, Medium or Large (1200, 2400 or 4000 px on the long side) and a white or transparent background. You can also turn the title and scale bar, room names, areas and colours, wall lengths, dimension lines, furniture and grid on or off. A live preview shows the result. Download it, or copy it straight to the clipboard.
- Also exports SVG and print/PDF.
- **Apple Pencil**: once the Pencil touches the screen, the Pencil draws and edits, and your fingers only pan and pinch to zoom, so a resting palm won't draw anything. Draw a wall with one Pencil stroke or tap from corner to corner, then tap **Finish**. Without a Pencil, fingers draw as usual. You can turn this off in the panel under View.
- **3D preview (experimental)**: switch to 3D in the bottom-left corner of the canvas to look at the plan in 3D, with room colours, doors, windows, stairs and furniture. See below.
- **Installable and offline**: after the first visit, the app opens and works with no connection. New versions you deploy show up the next time it's opened online.
- Undo and redo, snapping (hold Alt to turn it off), keyboard shortcuts (press `?` in the app), and touch support with pinch to zoom.

## 3D preview (experimental)

Use the **Plan / 3D** switch in the bottom-left corner of the canvas.

- **Overview**: drag to turn the model. To move, right-drag, Shift-drag or use two fingers; the ground follows your pointer. Scroll or pinch to zoom toward the pointer (trackpad pinch works in Safari too), and double-click or double-tap a spot to glide in on it. Arrow keys turn, `W` `A` `S` `D` move, `+` and `-` zoom, `0` resets, and `Esc` goes back to the plan.
- **Walk**: walks you through the rooms at eye level (1.6 m). Click or tap the floor to walk there, drag to look around, scroll or pinch to step forward or back, or use `W` `A` `S` `D` and the arrow keys (hold Shift to hurry). Walls and windows stop you; doorways let you through. `Esc` or **Overview** takes you back out.
- **Picks up where you left off**: going back to the plan and into 3D again returns you to the same view, walking or not.
- **Settings** (bar at the top of the 3D view): **Overview / Walk**, show or hide furniture, people and room names, Reset view, Top view, and **Save image**, which saves a PNG of the current view.
- **What it shows**: each stretch of wall rises to the ceiling height of the room next to it (the taller one where two rooms meet, the drawing's ceiling height where there's no room). Openings are cut out at their own heights: doors are shown open, and windows have glass from the sill to the top of the window. A window taller than its wall stops at the top of the wall. Rooms show their floor colour, stairs climb to the ceiling of their room, and furniture uses typical heights.
- **It's a preview only.** The 3D view can't change your drawing: editing shortcuts don't work while it's open. Edits made in the side panel, and undo or redo, show up in 3D straight away. Picking a drawing tool switches back to the plan.
- **It stays out of the way.** `view3d.js` is only downloaded the first time 3D is opened, so the editor starts just as fast as before. If the 3D view can't run (for example the browser has WebGL turned off), it says so and the plan carries on normally. To hide the 3D button completely, untick **Show the 3D preview** under View in the right-hand panel.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app |
| `manifest.webmanifest` | App name, icons and colours used when it's installed |
| `sw.js` | Service worker that makes it work offline |
| `view3d.js` | The experimental 3D preview, loaded only when 3D is opened |
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

- Changes to `index.html` and `view3d.js` reach users the next time they open the app while online. There's nothing else to do.
- If you change the icons or `manifest.webmanifest`, also change `VERSION` in `sw.js` (for example `'v1'` → `'v2'`). The app then replaces its offline copy and removes the old one.

## Where drawings are stored

Drawings stay on the device where they were made. Nothing is uploaded anywhere.

- A drawing saved on your laptop won't appear on your phone. To move one, use **Export → Drawing file**, then **Import** it on the other device.
- **iPhone and iPad keep Home Screen apps separate from Safari.** Drawings made in Safari don't appear in the installed app, and the other way round. To bring drawings over, open the site in Safari, choose **Export → All saved drawings**, then **Import** that file in the Home Screen app. The app shows a reminder about this when it's first opened from the Home Screen.
- In the Home Screen app on iPhone and iPad, exports open the share sheet (Save Image, Save to Files, AirDrop), because file downloads don't work reliably there.
- Clearing the browser's site data deletes saved drawings, so use **Export → All saved drawings** now and then as a backup.
- On GitHub Pages, every repository under `<username>.github.io` shares the same storage. The app prefixes its keys with `floorplanner.` so it won't collide with other projects.
