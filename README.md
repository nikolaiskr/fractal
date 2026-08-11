# Fractal

**Fractal** is a local-first spatial workspace for connected thoughts, materials, research, and nested spaces.

> Ideas don't belong in folders.

This repository contains the working MVP built for static hosting on **GitHub Pages**. No backend or registration is required.

## Core interactions

- Double-click empty canvas → create a Text Fragment
- Paste text / URL / image → create the matching Fragment
- Drag an image file onto the canvas → add Image Fragment
- Drag objects → move them in world coordinates
- Drag empty canvas with `Space`, `Alt`, or middle mouse → pan
- Mouse wheel → zoom; trackpad scroll pans; pinch zoom works on touch devices
- Shift-click or drag a selection rectangle → multi-select
- Select one object → `Connect`, then select another object
- Select multiple objects → `Create Bubble`
- Double-click Bubble / Portal → enter its Space
- Zoom far enough out inside a nested Space → return to its parent
- `Cmd/Ctrl + K` → search across all Spaces
- `Cmd/Ctrl + Z` / `Cmd/Ctrl + Shift + Z` → undo / redo
- `T` → Text, `B` → Bubble, `F` → Frame, `D` → Draw, `C` → connection mode
- `Delete` → delete selection, `Esc` → cancel / exit focus
- Right-click → contextual actions

## Local persistence

The MVP persists the complete local Fractal in **IndexedDB**:

- spaces
- fragments
- bubbles / portals / frames
- connections
- viewports
- timeline
- undo / redo history

The History panel also contains **Export**, **Import**, and **Reset** controls. Export is useful when moving data between localhost and the deployed GitHub Pages origin.

## Run locally

```bash
npm install
npm run dev
```

Production check:

```bash
npm run build
npm run preview
```

## Deploy to GitHub Pages

The repo already contains `.github/workflows/deploy.yml`.

1. Create an empty GitHub repository, e.g. `fractal`.
2. From this folder:

```bash
git init
git add .
git commit -m "Initial Fractal MVP"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/fractal.git
git push -u origin main
```

3. In GitHub open **Settings → Pages** and choose **GitHub Actions** as the source if GitHub asks for a source.
4. The workflow builds `dist/` and deploys it automatically on each push to `main`.

Vite uses `base: './'`, so the same build works for a repository Pages path such as:

```text
https://YOUR_USERNAME.github.io/fractal/
```

Space navigation uses URL hashes (`#space=...`) instead of server routes, so refreshing a nested Space does not cause a GitHub Pages 404.

## Architecture

```text
src/
  components/FractalApp.tsx      spatial canvas + interactions + UI chrome
  state/useFractalStore.ts       normalized Zustand product state + commands
  data/indexedDbRepository.ts    persistence repository abstraction
  domain/types.ts                Space / Fragment / Bubble / Portal / Connection model
  utils/                         geometry, ids, link helpers
```

The canvas is a custom DOM/SVG spatial layer rather than a generic node-board abstraction. This keeps semantic zoom, nested Space transitions, world coordinates, edge rendering, and future viewport culling under product control.

## Semantic zoom

Objects are not merely CSS-scaled. Rendering changes by zoom band:

- close: full Fragment/Bubble content
- medium: secondary content is removed
- far: fragments simplify aggressively
- very far: non-space objects are culled and Bubbles collapse to a minimal spatial marker + label

The render path also culls off-screen objects with overscan before mapping them into React nodes.

## Notes

- Desktop is the primary editor experience.
- Mobile supports viewing, pan, pinch zoom, Bubble navigation, and basic creation.
- Link metadata is intentionally lightweight. The MVP derives domain/title locally and uses a favicon endpoint when available rather than introducing a bookmark backend.
- Data is local to the browser origin. `localhost` and `github.io` are separate stores; use Export/Import to move a Fractal between them.

## v0.2 interaction update

- Freehand **Draw mode**: press `D` or choose **+ → Draw**, draw on empty canvas, then move the resulting drawing like any other spatial object.
- Text fragments now auto-fit their content: short thoughts stay compact and longer notes grow up to a bounded readable size.
- Connections terminate on object/frame boundaries rather than at their centers, removing lines drawn across the inside of Frames.
- Frames, images, links and drawings can be labeled from the contextual **Label** action. Connections can be labeled from their edge toolbar or by double-clicking the edge.
- Bubbles have a richer organic visual treatment and show a miniature preview of their child Space at close zoom.
- Dragging uses a subtle spring-follow interaction so fragments trail the pointer and settle softly instead of snapping mechanically.

## v0.4 global tools + light drafting

- A global **Tools** button now lives under the theme switch and remains available when navigating between Spaces.
- **Calculator**: iPhone-style basic operations in Fractal's visual language. The global calculator stays independent of the current Space. `⌖` pins a fully functional calculator widget into the current Space; the current result can also be pinned as a Text Fragment.
- **Light drafting**: activate from Tools, drag a dimension line with LMB, and use RMB while the mode is active to switch between `cm`, `m`, and `km`. One canvas world unit is treated as one centimeter; changing the displayed unit converts the value. Dimension labels are attached to their line, so moving the measurement keeps the label aligned like a drawing annotation.
- Drafting remains active for repeated measurements until **Exit** or `Esc`.
- Text, Image, Link, Drawing, and pinned Calculator fragments can be scaled after LMB selection by turning the mouse wheel while the pointer is over the selected object. The bottom-right resize handle remains available for direct manipulation.
- The circular `↻` handle rotates a selected fragment by **90°**. The same **Rotate 90°** action is available from the RMB menu. Bubbles and Frames are intentionally excluded from fragment rotation.
