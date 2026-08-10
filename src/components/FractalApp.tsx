import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type MouseEvent as ReactMouseEvent,
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Bubble, Connection, DrawingPoint, ID, SpatialObject, Viewport } from '../domain/types';
import { fractalRepository } from '../data/indexedDbRepository';
import { serializeStore, useFractalStore } from '../state/useFractalStore';
import { clamp, getBounds } from '../utils/math';

const MIN_ZOOM = 0.12;
const MAX_ZOOM = 2.6;
const FAR_ZOOM = 0.48;
const VERY_FAR_ZOOM = 0.25;
const CLOSE_ZOOM = 0.86;

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

const screenToWorld = (clientX: number, clientY: number, viewport: Viewport) => ({
  x: (clientX - viewport.x) / viewport.zoom,
  y: (clientY - viewport.y) / viewport.zoom,
});

const objectTitle = (object: SpatialObject) => {
  if (object.type === 'text') return object.content.trim().split('\n')[0] || 'Untitled thought';
  if (object.type === 'image') return object.alt || 'Image';
  if (object.type === 'link') return object.title || object.domain;
  if (object.type === 'drawing') return object.label || 'Drawing';
  return object.title || 'Untitled';
};

const ease = (t: number) => 1 - Math.pow(1 - t, 3);


const textAutoSize = (content: string) => {
  const lines = (content || 'Start typing…').split('\n');
  const longest = Math.max(8, ...lines.map((line) => line.length));
  const width = clamp(82 + longest * 7.15, 158, 390);
  const charsPerLine = Math.max(14, Math.floor((width - 36) / 7.1));
  const visualLines = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(Math.max(1, line.length) / charsPerLine)), 0);
  const height = clamp(32 + visualLines * 21, 60, 520);
  return { width: Math.round(width), height: Math.round(height) };
};

const pathFromStroke = (points: DrawingPoint[]) => {
  if (points.length < 2) return '';
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    path += ` Q ${current.x} ${current.y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  path += ` T ${last.x} ${last.y}`;
  return path;
};

const pathFromStrokes = (strokes: DrawingPoint[][]) => strokes.map((stroke) => pathFromStroke(stroke)).filter(Boolean).join(' ');

const bubbleInformationScore = (children: SpatialObject[]) => children.reduce((score, child) => {
  if (child.type === 'text') return score + 1 + Math.min(4.4, child.content.trim().length / 170);
  if (child.type === 'image') return score + 1.35;
  if (child.type === 'link') return score + 1.15;
  if (child.type === 'drawing') return score + 1.05 + Math.min(2.2, child.points.length / 30);
  if (child.type === 'frame') return score + 0.35;
  if (child.type === 'portal') return score + 1.1;
  if (child.type === 'bubble') return score + 1.6;
  return score + 1;
}, 0);

const bubbleDimensions = (children: SpatialObject[]) => {
  const info = bubbleInformationScore(children);
  const count = children.length;
  const scale = clamp(0.92 + Math.min(0.78, info / 22) + Math.min(0.16, count / 70), 0.92, 1.72);
  return {
    width: Math.round(196 * scale),
    height: Math.round(158 * scale),
  };
};

const getVisualRect = (object: SpatialObject, objectsBySpace?: Map<ID, SpatialObject[]>) => {
  if (object.type !== 'bubble' || !objectsBySpace) return { x: object.x, y: object.y, width: object.width, height: object.height };
  const children = objectsBySpace.get(object.targetSpaceId) ?? [];
  const dims = bubbleDimensions(children);
  return { x: object.x, y: object.y, width: dims.width, height: dims.height };
};

const connectionAnchor = (object: SpatialObject, toward: { x: number; y: number }, objectsBySpace?: Map<ID, SpatialObject[]>) => {
  const rect = getVisualRect(object, objectsBySpace);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return { x: cx, y: cy };
  const halfW = Math.max(1, rect.width / 2);
  const halfH = Math.max(1, rect.height / 2);
  const scale = 1 / Math.max(Math.abs(dx) / halfW, Math.abs(dy) / halfH);
  const inset = object.type === 'frame' ? 0 : 3;
  const x = cx + dx * scale;
  const y = cy + dy * scale;
  const len = Math.max(1, Math.hypot(dx, dy));
  return { x: x - (dx / len) * inset, y: y - (dy / len) * inset };
};

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return reduced;
}


function BubbleMiniature({ children }: { children: SpatialObject[] }) {
  const candidates = children.filter((object) => object.type !== 'frame').slice(0, 7);
  if (!candidates.length) return <div className="bubble-mini-map empty" aria-hidden="true"><span /></div>;
  const bounds = getBounds(candidates);
  const rangeX = Math.max(1, bounds.width);
  const rangeY = Math.max(1, bounds.height);
  return (
    <div className="bubble-mini-map" aria-hidden="true">
      {candidates.map((child) => {
        const cx = child.x + child.width / 2;
        const cy = child.y + child.height / 2;
        const left = 15 + ((cx - bounds.x) / rangeX) * 70;
        const top = 12 + ((cy - bounds.y) / rangeY) * 54;
        const style = { left: `${left}%`, top: `${top}%` } as CSSProperties;
        if (child.type === 'image') return <span key={child.id} className="mini-node mini-image" style={style}><img src={child.src} alt="" /></span>;
        if (child.type === 'drawing') return <span key={child.id} className="mini-node mini-drawing" style={style}><svg viewBox={`0 0 ${Math.max(1, child.width)} ${Math.max(1, child.height)}`}><path d={pathFromStrokes(child.strokes?.length ? child.strokes : [child.points])} /></svg></span>;
        if (child.type === 'bubble' || child.type === 'portal') return <span key={child.id} className="mini-node mini-bubble" style={style} />;
        if (child.type === 'link') return <span key={child.id} className="mini-node mini-link" style={style}><img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(child.domain)}&sz=32`} alt="" /></span>;
        return <span key={child.id} className="mini-node mini-text" style={style} />;
      })}
    </div>
  );
}

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  initial: Record<ID, { x: number; y: number }>;
  targetDx: number;
  targetDy: number;
  currentDx: number;
  currentDy: number;
  released?: boolean;
  before: ReturnType<typeof useFractalStore.getState>['makeSnapshot'] extends () => infer T ? T : never;
};

type DrawingState = {
  pointerId: number;
  strokeIndex: number;
};

type SelectionState = {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  additive: boolean;
};

type PanState = {
  pointerId: number;
  startX: number;
  startY: number;
  viewport: Viewport;
};

type ResizeState = {
  pointerId: number;
  objectId: ID;
  startX: number;
  startY: number;
  width: number;
  height: number;
  before: ReturnType<typeof useFractalStore.getState>['makeSnapshot'] extends () => infer T ? T : never;
};

export function FractalApp() {
  const store = useFractalStore();
  const {
    hydrated,
    currentSpaceId,
    homeSpaceId,
    spaces,
    objects,
    connections,
    selectedIds,
    selectedConnectionId,
    connectionSourceId,
    focusIds,
    theme,
    saveStatus,
  } = store;

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragAnimationRef = useRef<number | undefined>(undefined);
  const drawingRef = useRef<DrawingState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const selectionRef = useRef<SelectionState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const touchPointsRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ initialDistance: number; initialMidX: number; initialMidY: number; worldX: number; worldY: number; viewport: Viewport } | null>(null);
  const viewportRef = useRef<Viewport>({ x: innerWidth / 2, y: innerHeight / 2, zoom: 1 });
  const persistenceTimer = useRef<number | undefined>(undefined);
  const cameraAnimation = useRef<number | undefined>(undefined);
  const editingBefore = useRef<ReturnType<typeof store.makeSnapshot> | null>(null);
  const [viewport, setViewportLocal] = useState<Viewport>(() => store.viewports[currentSpaceId] ?? { x: innerWidth / 2, y: innerHeight / 2, zoom: 1 });
  const [selectionBox, setSelectionBox] = useState<SelectionState | null>(null);
  const [drawingMode, setDrawingMode] = useState(false);
  const [draftDrawing, setDraftDrawing] = useState<DrawingPoint[][]>([]);
  const [draggingIds, setDraggingIds] = useState<ID[]>([]);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [editingId, setEditingId] = useState<ID | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [bubbleDialog, setBubbleDialog] = useState<{ ids: ID[]; title: string } | null>(null);
  const [connectionEditor, setConnectionEditor] = useState<Connection | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<ID | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; worldX: number; worldY: number; objectId?: ID; connectionId?: ID } | null>(null);
  const reducedMotion = useReducedMotion();

  const currentSpace = spaces[currentSpaceId];
  const currentObjects = useMemo(() => Object.values(objects).filter((o) => o.spaceId === currentSpaceId), [objects, currentSpaceId]);
  const objectsBySpace = useMemo(() => {
    const index = new Map<ID, SpatialObject[]>();
    for (const object of Object.values(objects)) {
      const list = index.get(object.spaceId);
      if (list) list.push(object);
      else index.set(object.spaceId, [object]);
    }
    return index;
  }, [objects]);
  const currentConnections = useMemo(() => Object.values(connections).filter((e) => e.spaceId === currentSpaceId), [connections, currentSpaceId]);
  const visibleObjects = useMemo(() => {
    const root = rootRef.current;
    if (!root) return currentObjects;
    const w = root.clientWidth;
    const h = root.clientHeight;
    const pad = 500 / viewport.zoom;
    const left = (-viewport.x) / viewport.zoom - pad;
    const top = (-viewport.y) / viewport.zoom - pad;
    const right = left + w / viewport.zoom + pad * 2;
    const bottom = top + h / viewport.zoom + pad * 2;
    return currentObjects.filter((o) => o.x + o.width >= left && o.x <= right && o.y + o.height >= top && o.y <= bottom);
  }, [currentObjects, viewport]);
  const visibleIds = useMemo(() => new Set(visibleObjects.map((o) => o.id)), [visibleObjects]);

  const breadcrumb = useMemo(() => {
    const chain = [] as { id: ID; title: string }[];
    let cursor: typeof currentSpace | undefined = currentSpace;
    const guard = new Set<ID>();
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      chain.unshift({ id: cursor.id, title: cursor.title });
      cursor = cursor.parentSpaceId ? spaces[cursor.parentSpaceId] : undefined;
    }
    return chain;
  }, [currentSpace, spaces]);

  const setViewport = useCallback((next: Viewport, persist = false) => {
    viewportRef.current = next;
    setViewportLocal(next);
    if (persist) useFractalStore.getState().setViewport(useFractalStore.getState().currentSpaceId, next);
  }, []);

  const animateViewport = useCallback((target: Viewport, duration = 420, after?: () => void) => {
    if (cameraAnimation.current) cancelAnimationFrame(cameraAnimation.current);
    if (reducedMotion || duration <= 0) {
      setViewport(target, true);
      after?.();
      return;
    }
    const start = { ...viewportRef.current };
    const started = performance.now();
    const frame = (now: number) => {
      const t = clamp((now - started) / duration, 0, 1);
      const k = ease(t);
      const next = {
        x: start.x + (target.x - start.x) * k,
        y: start.y + (target.y - start.y) * k,
        zoom: start.zoom + (target.zoom - start.zoom) * k,
      };
      setViewport(next, false);
      if (t < 1) cameraAnimation.current = requestAnimationFrame(frame);
      else {
        useFractalStore.getState().setViewport(useFractalStore.getState().currentSpaceId, target);
        after?.();
      }
    };
    cameraAnimation.current = requestAnimationFrame(frame);
  }, [reducedMotion, setViewport]);

  const centerOnObject = useCallback((object: SpatialObject, zoom = Math.max(viewportRef.current.zoom, 1)) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const target = {
      x: rect.width / 2 - (object.x + object.width / 2) * zoom,
      y: rect.height / 2 - (object.y + object.height / 2) * zoom,
      zoom,
    };
    animateViewport(target, 460);
  }, [animateViewport]);

  const syncHash = useCallback((spaceId: ID, replace = false) => {
    const hash = `#space=${encodeURIComponent(spaceId)}`;
    if (location.hash === hash) return;
    if (replace) history.replaceState({ spaceId }, '', hash);
    else history.pushState({ spaceId }, '', hash);
  }, []);

  const enterSpace = useCallback((spaceId: ID, pushHistory = true, focusObjectId?: ID) => {
    const targetSpace = useFractalStore.getState().spaces[spaceId];
    if (!targetSpace) return;
    useFractalStore.getState().enterSpace(spaceId);
    const nextView = useFractalStore.getState().viewports[spaceId] ?? { x: innerWidth / 2, y: innerHeight / 2, zoom: 1 };
    viewportRef.current = nextView;
    setViewportLocal(nextView);
    if (pushHistory) syncHash(spaceId);
    window.setTimeout(() => {
      if (focusObjectId) {
        const target = useFractalStore.getState().objects[focusObjectId];
        if (target) centerOnObject(target, 1.12);
      }
    }, reducedMotion ? 0 : 60);
  }, [centerOnObject, reducedMotion, syncHash]);

  const openBubble = useCallback((bubble: Bubble) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    useFractalStore.getState().setSelection([bubble.id]);
    const targetZoom = Math.min(MAX_ZOOM, Math.max(viewportRef.current.zoom * 2.5, 2.25));
    const target = {
      x: rect.width / 2 - (bubble.x + bubble.width / 2) * targetZoom,
      y: rect.height / 2 - (bubble.y + bubble.height / 2) * targetZoom,
      zoom: targetZoom,
    };
    animateViewport(target, 430, () => {
      enterSpace(bubble.targetSpaceId, true);
      const childView = useFractalStore.getState().viewports[bubble.targetSpaceId] ?? { x: rect.width / 2, y: rect.height / 2, zoom: 0.76 };
      const staged = { ...childView, zoom: Math.min(childView.zoom, 0.72) };
      viewportRef.current = staged;
      setViewportLocal(staged);
      requestAnimationFrame(() => animateViewport({ ...childView, zoom: Math.max(childView.zoom, 1) }, 360));
    });
  }, [animateViewport, enterSpace]);

  const goParent = useCallback((pushHistory = true) => {
    const state = useFractalStore.getState();
    const space = state.spaces[state.currentSpaceId];
    if (!space?.parentSpaceId) return;
    const oldSpaceId = space.id;
    const bubble = space.parentBubbleId ? state.objects[space.parentBubbleId] : undefined;
    const rect = rootRef.current?.getBoundingClientRect();
    const zoomOut = { ...viewportRef.current, zoom: Math.max(MIN_ZOOM, viewportRef.current.zoom * 0.55) };
    animateViewport(zoomOut, 220, () => {
      enterSpace(space.parentSpaceId!, pushHistory);
      if (bubble && rect) {
        const targetZoom = 1;
        const target = {
          x: rect.width / 2 - (bubble.x + bubble.width / 2) * targetZoom,
          y: rect.height / 2 - (bubble.y + bubble.height / 2) * targetZoom,
          zoom: targetZoom,
        };
        viewportRef.current = { ...target, zoom: 1.45 };
        setViewportLocal(viewportRef.current);
        requestAnimationFrame(() => animateViewport(target, 350));
      }
      void oldSpaceId;
    });
  }, [animateViewport, enterSpace]);

  useEffect(() => {
    fractalRepository.load().then((data) => {
      useFractalStore.getState().hydrateFrom(data);
      const idFromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('space');
      const state = useFractalStore.getState();
      const target = idFromHash && state.spaces[idFromHash] ? idFromHash : state.currentSpaceId;
      if (target !== state.currentSpaceId) state.enterSpace(target);
      const view = state.viewports[target] ?? { x: innerWidth / 2, y: innerHeight / 2, zoom: 1 };
      viewportRef.current = view;
      setViewportLocal(view);
      history.replaceState({ spaceId: target }, '', `#space=${encodeURIComponent(target)}`);
    }).catch(() => useFractalStore.getState().hydrateFrom(null));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (persistenceTimer.current) clearTimeout(persistenceTimer.current);
    persistenceTimer.current = window.setTimeout(async () => {
      const state = useFractalStore.getState();
      state.setSaveStatus('saving');
      try {
        await fractalRepository.save(serializeStore(state));
        useFractalStore.getState().setSaveStatus('saved');
      } catch {
        useFractalStore.getState().setSaveStatus('error');
      }
    }, 240);
    return () => {
      if (persistenceTimer.current) clearTimeout(persistenceTimer.current);
    };
  }, [store.revision, hydrated]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (currentSpace?.title) document.title = `${currentSpace.title} — Fractal`;
  }, [currentSpace?.title]);

  useEffect(() => {
    const state = useFractalStore.getState();
    const next = state.viewports[currentSpaceId] ?? { x: innerWidth / 2, y: innerHeight / 2, zoom: 1 };
    viewportRef.current = next;
    setViewportLocal(next);
  }, [currentSpaceId]);

  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const id = event.state?.spaceId ?? new URLSearchParams(location.hash.replace(/^#/, '')).get('space');
      if (!id || !useFractalStore.getState().spaces[id]) return;
      const from = useFractalStore.getState().spaces[useFractalStore.getState().currentSpaceId];
      if (from?.parentSpaceId === id) goParent(false);
      else enterSpace(id, false);
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [enterSpace, goParent]);

  const createTextAt = useCallback((clientX: number, clientY: number, initial = '') => {
    const world = screenToWorld(clientX, clientY, viewportRef.current);
    const id = useFractalStore.getState().createText(useFractalStore.getState().currentSpaceId, world.x - 82, world.y - 32, initial);
    setEditingId(id);
    editingBefore.current = useFractalStore.getState().makeSnapshot();
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-editor="${id}"]`)?.focus());
  }, []);

  const createBubbleAtCenter = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const p = screenToWorld(rect.width / 2, rect.height / 2, viewportRef.current);
    const id = useFractalStore.getState().createEmptyBubble(currentSpaceId, p.x - 104, p.y - 83, 'New Space');
    const object = useFractalStore.getState().objects[id];
    if (object) centerOnObject(object, viewportRef.current.zoom);
  }, [centerOnObject, currentSpaceId]);

  const createFrameAtCenter = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const p = screenToWorld(rect.width / 2, rect.height / 2, viewportRef.current);
    useFractalStore.getState().createFrame(currentSpaceId, p.x - 260, p.y - 170, 'Frame');
  }, [currentSpaceId]);

  const commitContinuousDrawing = useCallback(() => {
    const strokes = draftDrawing.map((stroke) => stroke.filter(Boolean)).filter((stroke) => stroke.length > 1);
    if (strokes.length) useFractalStore.getState().createDrawing(currentSpaceId, strokes);
    drawingRef.current = null;
    setDraftDrawing([]);
  }, [currentSpaceId, draftDrawing]);

  const stopDrawingMode = useCallback((commit = true) => {
    if (commit) commitContinuousDrawing();
    else {
      drawingRef.current = null;
      setDraftDrawing([]);
    }
    setDrawingMode(false);
  }, [commitContinuousDrawing]);

  const beginDraftStroke = useCallback((pointerId: number, clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return false;
    const world = screenToWorld(clientX - rect.left, clientY - rect.top, viewportRef.current);
    const point = { x: world.x, y: world.y, pressure: 0.5 };
    setDraftDrawing((current) => {
      const strokeIndex = current.length;
      drawingRef.current = { pointerId, strokeIndex };
      return [...current, [point]];
    });
    useFractalStore.getState().clearSelection();
    return true;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.matches('input, textarea, [contenteditable="true"]');
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        setSearchQuery('');
        return;
      }
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) useFractalStore.getState().redoAction();
        else useFractalStore.getState().undoAction();
        return;
      }
      if (typing) return;
      if (event.code === 'Space') {
        event.preventDefault();
        setSpaceHeld(true);
      }
      if (event.key === 'Escape') {
        setSearchOpen(false);
        setCreateMenuOpen(false);
        setTimelineOpen(false);
        setEditingId(null);
        stopDrawingMode(true);
        useFractalStore.getState().startConnection(undefined);
        useFractalStore.getState().setFocus([]);
        useFractalStore.getState().clearSelection();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        useFractalStore.getState().deleteSelected();
      } else if (event.key.toLowerCase() === 't') {
        const rect = rootRef.current?.getBoundingClientRect();
        if (rect) createTextAt(rect.width / 2, rect.height / 2);
      } else if (event.key.toLowerCase() === 'b') {
        createBubbleAtCenter();
      } else if (event.key.toLowerCase() === 'f') {
        createFrameAtCenter();
      } else if (event.key.toLowerCase() === 'd') {
        if (drawingMode) stopDrawingMode(true);
        else setDrawingMode(true);
      } else if (event.key.toLowerCase() === 'c' && selectedIds.length === 1) {
        useFractalStore.getState().startConnection(selectedIds[0]);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false);
    };
    addEventListener('keydown', onKeyDown);
    addEventListener('keyup', onKeyUp);
    return () => {
      removeEventListener('keydown', onKeyDown);
      removeEventListener('keyup', onKeyUp);
    };
  }, [createBubbleAtCenter, createFrameAtCenter, createTextAt, drawingMode, selectedIds, stopDrawingMode]);

  const onWheel = (event: ReactWheelEvent) => {
    event.preventDefault();
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = viewportRef.current;
    const looksLikeTrackpadPan = !event.ctrlKey && !event.metaKey && (Math.abs(event.deltaX) > 0.2 || Math.abs(event.deltaY) < 18);
    if (looksLikeTrackpadPan && !event.altKey) {
      setViewport({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }, false);
      window.clearTimeout(persistenceTimer.current);
      persistenceTimer.current = window.setTimeout(() => useFractalStore.getState().setViewport(currentSpaceId, viewportRef.current), 160);
      return;
    }
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const world = screenToWorld(px, py, current);
    const factor = Math.exp(-event.deltaY * 0.0015);
    if (factor < 1 && current.zoom <= 0.145 && useFractalStore.getState().spaces[currentSpaceId]?.parentSpaceId) {
      goParent();
      return;
    }
    const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const next = { x: px - world.x * zoom, y: py - world.y * zoom, zoom };
    setViewport(next, false);
    window.clearTimeout(persistenceTimer.current);
    persistenceTimer.current = window.setTimeout(() => useFractalStore.getState().setViewport(currentSpaceId, viewportRef.current), 160);
  };

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    setContextMenu(null);
    if (event.button !== 0 && event.button !== 1) return;
    const target = event.target as HTMLElement;
    const onObject = target.closest('[data-object-id]');
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    if (drawingMode && event.button === 0 && event.pointerType !== 'touch') {
      if (beginDraftStroke(event.pointerId, event.clientX, event.clientY)) return;
    }
    if (onObject) return;
    if (event.pointerType === 'touch') {
      touchPointsRef.current.set(event.pointerId, { x, y });
      if (touchPointsRef.current.size === 1) {
        panRef.current = { pointerId: event.pointerId, startX: x, startY: y, viewport: { ...viewportRef.current } };
      } else if (touchPointsRef.current.size === 2) {
        const [a, b] = [...touchPointsRef.current.values()];
        const initialDistance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
        const initialMidX = (a.x + b.x) / 2;
        const initialMidY = (a.y + b.y) / 2;
        const world = screenToWorld(initialMidX, initialMidY, viewportRef.current);
        pinchRef.current = { initialDistance, initialMidX, initialMidY, worldX: world.x, worldY: world.y, viewport: { ...viewportRef.current } };
        panRef.current = null;
      }
      return;
    }
    if (event.button === 1 || spaceHeld || event.altKey) {
      panRef.current = { pointerId: event.pointerId, startX: x, startY: y, viewport: { ...viewportRef.current } };
      return;
    }
    useFractalStore.getState().clearSelection();
    const next = { pointerId: event.pointerId, startX: x, startY: y, currentX: x, currentY: y, additive: event.shiftKey };
    selectionRef.current = next;
    setSelectionBox(next);
  };

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const activeDrawing = drawingRef.current;
    if (activeDrawing && activeDrawing.pointerId === event.pointerId) {
      const world = screenToWorld(x, y, viewportRef.current);
      setDraftDrawing((current) => {
        const next = current.map((stroke) => [...stroke]);
        const stroke = next[activeDrawing.strokeIndex] ?? [];
        const last = stroke[stroke.length - 1];
        if (!last || Math.hypot(world.x - last.x, world.y - last.y) >= 1.8 / viewportRef.current.zoom) {
          stroke.push({ x: world.x, y: world.y, pressure: event.pressure || 0.5 });
          next[activeDrawing.strokeIndex] = stroke;
        }
        return next;
      });
      return;
    }
    if (event.pointerType === 'touch' && touchPointsRef.current.has(event.pointerId)) {
      touchPointsRef.current.set(event.pointerId, { x, y });
      if (touchPointsRef.current.size >= 2 && pinchRef.current) {
        const [a, b] = [...touchPointsRef.current.values()];
        const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const zoom = clamp(pinchRef.current.viewport.zoom * (distance / pinchRef.current.initialDistance), MIN_ZOOM, MAX_ZOOM);
        setViewport({ x: midX - pinchRef.current.worldX * zoom, y: midY - pinchRef.current.worldY * zoom, zoom }, false);
        return;
      }
    }
    const activePan = panRef.current;
    if (activePan && activePan.pointerId === event.pointerId) {
      setViewport({ ...activePan.viewport, x: activePan.viewport.x + (x - activePan.startX), y: activePan.viewport.y + (y - activePan.startY) }, false);
      return;
    }
    const activeSelection = selectionRef.current;
    if (activeSelection && activeSelection.pointerId === event.pointerId) {
      const next: SelectionState = { ...activeSelection, currentX: x, currentY: y };
      selectionRef.current = next;
      setSelectionBox(next);
    }
  };

  const onCanvasPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const activeDrawing = drawingRef.current;
    if (activeDrawing && activeDrawing.pointerId === event.pointerId) {
      drawingRef.current = null;
      return;
    }
    if (event.pointerType === 'touch') {
      touchPointsRef.current.delete(event.pointerId);
      if (touchPointsRef.current.size < 2) pinchRef.current = null;
      if (touchPointsRef.current.size === 1) {
        const [remainingId, point] = [...touchPointsRef.current.entries()][0];
        panRef.current = { pointerId: remainingId, startX: point.x, startY: point.y, viewport: { ...viewportRef.current } };
      } else if (touchPointsRef.current.size === 0) {
        panRef.current = null;
      }
      useFractalStore.getState().setViewport(currentSpaceId, viewportRef.current);
    }
    if (panRef.current?.pointerId === event.pointerId) {
      panRef.current = null;
      useFractalStore.getState().setViewport(currentSpaceId, viewportRef.current);
    }
    const sel = selectionRef.current;
    if (sel && sel.pointerId === event.pointerId) {
      const minX = Math.min(sel.startX, sel.currentX);
      const maxX = Math.max(sel.startX, sel.currentX);
      const minY = Math.min(sel.startY, sel.currentY);
      const maxY = Math.max(sel.startY, sel.currentY);
      if (Math.hypot(maxX - minX, maxY - minY) > 4) {
        const a = screenToWorld(minX, minY, viewportRef.current);
        const b = screenToWorld(maxX, maxY, viewportRef.current);
        const hits = currentObjects.filter((o) => o.x + o.width >= a.x && o.x <= b.x && o.y + o.height >= a.y && o.y <= b.y).map((o) => o.id);
        const previous = sel.additive ? useFractalStore.getState().selectedIds : [];
        useFractalStore.getState().setSelection(Array.from(new Set([...previous, ...hits])));
      }
      selectionRef.current = null;
      setSelectionBox(null);
    }
  };

  const onCanvasContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const objectNode = (event.target as HTMLElement).closest<HTMLElement>('[data-object-id]');
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top, viewportRef.current);
    const objectId = objectNode?.dataset.objectId;

    if (objectId) {
      const state = useFractalStore.getState();
      const object = state.objects[objectId];
      if (!object) return;
      if (!state.selectedIds.includes(objectId)) state.setSelection([objectId]);

      const visual = getVisualRect(object, objectsBySpace);
      const objectLeft = visual.x * viewportRef.current.zoom + viewportRef.current.x;
      const objectRight = (visual.x + visual.width) * viewportRef.current.zoom + viewportRef.current.x;
      const objectTop = visual.y * viewportRef.current.zoom + viewportRef.current.y;
      const menuWidth = 188;
      const gap = 14;
      const margin = 10;
      const preferredRight = objectRight + gap;
      const fallbackLeft = objectLeft - menuWidth - gap;
      const x = preferredRight + menuWidth <= rect.width - margin
        ? preferredRight
        : Math.max(margin, fallbackLeft);
      const y = clamp(objectTop, margin, Math.max(margin, rect.height - 290));
      setContextMenu({ x, y, worldX: world.x, worldY: world.y, objectId });
      return;
    }

    setContextMenu({
      x: clamp(event.clientX - rect.left, 10, Math.max(10, rect.width - 188 - 10)),
      y: clamp(event.clientY - rect.top, 10, Math.max(10, rect.height - 220)),
      worldX: world.x,
      worldY: world.y,
    });
  };

  const onCanvasDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (drawingMode) return;
    if ((event.target as HTMLElement).closest('[data-object-id]')) return;
    createTextAt(event.clientX, event.clientY);
  };

  const queueDragFrame = useCallback(() => {
    if (dragAnimationRef.current !== undefined) return;
    const tick = () => {
      dragAnimationRef.current = undefined;
      const drag = dragRef.current;
      if (!drag) return;
      const follow = reducedMotion ? 1 : 0.34;
      drag.currentDx += (drag.targetDx - drag.currentDx) * follow;
      drag.currentDy += (drag.targetDy - drag.currentDy) * follow;
      const positions: Record<ID, { x: number; y: number }> = {};
      for (const [id, p] of Object.entries(drag.initial)) {
        positions[id] = { x: p.x + drag.currentDx, y: p.y + drag.currentDy };
      }
      useFractalStore.getState().moveObjectsTransient(positions);
      if (Math.hypot(drag.targetDx - drag.currentDx, drag.targetDy - drag.currentDy) > 0.08) {
        dragAnimationRef.current = requestAnimationFrame(tick);
      } else if (drag.released) {
        const moved = Math.hypot(drag.targetDx, drag.targetDy) > 0.5;
        dragRef.current = null;
        setDraggingIds([]);
        if (moved) useFractalStore.getState().recordSnapshot(drag.before, 'Moved objects');
      }
    };
    dragAnimationRef.current = requestAnimationFrame(tick);
  }, [reducedMotion]);

  const onObjectPointerDown = (event: ReactPointerEvent<HTMLElement>, object: SpatialObject) => {
    if (event.button === 2) return;
    setContextMenu(null);
    if (editingId === object.id) return;
    if ((event.target as HTMLElement).closest('button, input, textarea, a, [data-resize-handle]')) return;
    if (drawingMode && event.button === 0) {
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      beginDraftStroke(event.pointerId, event.clientX, event.clientY);
      return;
    }
    event.stopPropagation();
    if (connectionSourceId && connectionSourceId !== object.id) {
      useFractalStore.getState().createConnection(currentSpaceId, connectionSourceId, object.id);
      return;
    }
    const state = useFractalStore.getState();
    if (event.shiftKey) state.toggleSelection(object.id);
    else if (!state.selectedIds.includes(object.id)) state.setSelection([object.id]);
    const ids = event.shiftKey ? useFractalStore.getState().selectedIds : (state.selectedIds.includes(object.id) ? state.selectedIds : [object.id]);
    const initial: Record<ID, { x: number; y: number }> = {};
    ids.forEach((id) => {
      const o = state.objects[id];
      if (o) initial[id] = { x: o.x, y: o.y };
    });
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      initial,
      targetDx: 0,
      targetDy: 0,
      currentDx: 0,
      currentDy: 0,
      before: state.makeSnapshot(),
    };
    setDraggingIds(Object.keys(initial));
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onObjectPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = (event.clientX - drag.startX) / viewportRef.current.zoom;
    const dy = (event.clientY - drag.startY) / viewportRef.current.zoom;
    if (Math.hypot(dx, dy) < 0.25) return;
    drag.targetDx = dx;
    drag.targetDy = dy;
    queueDragFrame();
  };

  const onObjectPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.targetDx = (event.clientX - drag.startX) / viewportRef.current.zoom;
    drag.targetDy = (event.clientY - drag.startY) / viewportRef.current.zoom;
    drag.released = true;
    queueDragFrame();
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, object: SpatialObject) => {
    event.stopPropagation();
    const state = useFractalStore.getState();
    resizeRef.current = {
      pointerId: event.pointerId,
      objectId: object.id,
      startX: event.clientX,
      startY: event.clientY,
      width: object.width,
      height: object.height,
      before: state.makeSnapshot(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const dx = (event.clientX - resize.startX) / viewportRef.current.zoom;
    const dy = (event.clientY - resize.startY) / viewportRef.current.zoom;
    useFractalStore.getState().resizeObjectTransient(resize.objectId, clamp(resize.width + dx, 110, 720), clamp(resize.height + dy, 72, 620));
  };

  const onResizePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    useFractalStore.getState().recordSnapshot(resize.before, 'Resized object');
  };

  const handlePaste = useCallback((event: ClipboardEvent) => {
    if ((event.target as HTMLElement)?.matches?.('textarea,input,[contenteditable="true"]')) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const center = screenToWorld(rect.width / 2, rect.height / 2, viewportRef.current);
    const image = Array.from(event.clipboardData?.items ?? []).find((item) => item.type.startsWith('image/'));
    if (image) {
      event.preventDefault();
      const file = image.getAsFile();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => useFractalStore.getState().createImage(currentSpaceId, center.x - 140, center.y - 100, String(reader.result));
      reader.readAsDataURL(file);
      return;
    }
    const text = event.clipboardData?.getData('text/plain')?.trim();
    if (!text) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(text)) useFractalStore.getState().createLink(currentSpaceId, center.x - 150, center.y - 64, text);
    else { const size = textAutoSize(text); useFractalStore.getState().createText(currentSpaceId, center.x - size.width / 2, center.y - size.height / 2, text); }
  }, [currentSpaceId]);

  useEffect(() => {
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top, viewportRef.current);
    const image = Array.from(event.dataTransfer.files).find((file) => file.type.startsWith('image/'));
    if (!image) return;
    const reader = new FileReader();
    reader.onload = () => useFractalStore.getState().createImage(currentSpaceId, world.x - 140, world.y - 100, String(reader.result));
    reader.readAsDataURL(image);
  };

  const searchResults = useMemo(() => store.search(searchQuery), [searchQuery, store.revision]);

  const navigateSearchResult = (result: ReturnType<typeof store.search>[number]) => {
    setSearchOpen(false);
    setSearchQuery('');
    if (result.kind === 'space') enterSpace(result.spaceId, true);
    else enterSpace(result.spaceId, true, result.id);
  };

  const createBubbleFromDialog = () => {
    if (!bubbleDialog) return;
    const id = useFractalStore.getState().createBubbleFromSelection(bubbleDialog.ids, bubbleDialog.title);
    setBubbleDialog(null);
    if (id) {
      const bubble = useFractalStore.getState().objects[id];
      if (bubble) centerOnObject(bubble, Math.max(viewportRef.current.zoom, 0.85));
    }
  };

  const addImageViaPicker = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return;
        const p = screenToWorld(rect.width / 2, rect.height / 2, viewportRef.current);
        useFractalStore.getState().createImage(currentSpaceId, p.x - 140, p.y - 100, String(reader.result));
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const addLinkPrompt = () => {
    const url = prompt('Paste a URL');
    if (!url) return;
    try {
      new URL(url);
    } catch {
      setToast('That does not look like a valid URL');
      window.setTimeout(() => setToast(null), 1800);
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const p = screenToWorld(rect.width / 2, rect.height / 2, viewportRef.current);
    useFractalStore.getState().createLink(currentSpaceId, p.x - 150, p.y - 64, url);
  };

  const goHome = () => {
    if (currentSpaceId === homeSpaceId) {
      const next = { x: innerWidth / 2, y: innerHeight / 2, zoom: 0.78 };
      animateViewport(next, 420);
      return;
    }
    enterSpace(homeSpaceId, true);
  };

  const handleObjectDoubleClick = (event: ReactMouseEvent<HTMLElement>, object: SpatialObject) => {
    event.stopPropagation();
    if (object.type === 'bubble' || object.type === 'portal') {
      openBubble(object as Bubble);
      return;
    }
    if (object.type === 'text') {
      editingBefore.current = useFractalStore.getState().makeSnapshot();
      setEditingId(object.id);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-editor="${object.id}"]`)?.focus());
      return;
    }
    if (object.type === 'image' || object.type === 'drawing' || object.type === 'frame') {
      const value = prompt('Label', objectTitle(object) === 'Image' || objectTitle(object) === 'Drawing' ? '' : objectTitle(object));
      if (value !== null) useFractalStore.getState().renameObject(object.id, value);
    }
  };

  const finishEditing = (id: ID) => {
    setEditingId(null);
    if (editingBefore.current) {
      useFractalStore.getState().recordSnapshot(editingBefore.current, 'Edited thought');
      editingBefore.current = null;
    }
  };

  const renderObject = (object: SpatialObject) => {
    const selected = selectedIds.includes(object.id);
    const focused = focusIds.length === 0 || focusIds.includes(object.id) || currentConnections.some((e) => (e.sourceId === object.id && focusIds.includes(e.targetId)) || (e.targetId === object.id && focusIds.includes(e.sourceId)));
    const zoomClass = viewport.zoom < VERY_FAR_ZOOM ? 'zoom-very-far' : viewport.zoom < FAR_ZOOM ? 'zoom-far' : viewport.zoom < CLOSE_ZOOM ? 'zoom-medium' : 'zoom-close';
    const visualRect = getVisualRect(object, objectsBySpace);
    const style: CSSProperties = {
      width: visualRect.width,
      height: visualRect.height,
      left: visualRect.x,
      top: visualRect.y,
      zIndex: object.type === 'frame' ? 1 : selected ? 8 : 3,
    };
    const common = {
      key: object.id,
      className: `spatial-object ${object.type} ${selected ? 'selected' : ''} ${focused ? '' : 'deemphasized'} ${draggingIds.includes(object.id) ? 'dragging' : ''} ${zoomClass}`,
      style,
      'data-object-id': object.id,
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => onObjectPointerDown(event, object),
      onPointerMove: onObjectPointerMove,
      onPointerUp: onObjectPointerUp,
      onPointerCancel: onObjectPointerUp,
      onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => handleObjectDoubleClick(event, object),
      onMouseEnter: () => setHoveredId(object.id),
      onMouseLeave: () => setHoveredId((id) => id === object.id ? null : id),
    };

    if (object.type === 'bubble') {
      const childObjects = objectsBySpace.get(object.targetSpaceId) ?? [];
      const count = childObjects.length;
      const infoScore = bubbleInformationScore(childObjects);
      const sizeBand = infoScore > 55 ? 'xl' : infoScore > 24 ? 'l' : infoScore > 8 ? 'm' : 's';
      return (
        <article {...common} className={`${common.className} bubble-size-${sizeBand}`} data-density={sizeBand}>
          <div className="bubble-glow" />
          <div className="bubble-specular bubble-specular-a" />
          <div className="bubble-specular bubble-specular-b" />
          <div className="bubble-rim" />
          <BubbleMiniature children={childObjects} />
          <div className="bubble-content">
            <span className="bubble-glyph">◉</span>
            <strong>{object.title}</strong>
            <span className="bubble-count">{count} {count === 1 ? 'object' : 'objects'}</span>
            <span className="bubble-preview">Double-click to enter</span>
          </div>
          {selected && <ResizeHandle object={object} onDown={onResizePointerDown} onMove={onResizePointerMove} onUp={onResizePointerUp} />}
        </article>
      );
    }

    if (object.type === 'portal') {
      return (
        <article {...common}>
          <div className="portal-mark">◎</div>
          <div className="portal-copy"><small>PORTAL</small><strong>{object.title}</strong><span>{spaces[object.targetSpaceId]?.title ?? 'Space'}</span></div>
          {selected && <ResizeHandle object={object} onDown={onResizePointerDown} onMove={onResizePointerMove} onUp={onResizePointerUp} />}
        </article>
      );
    }

    if (object.type === 'frame') {
      return (
        <section {...common}>
          <span className="frame-title">{object.title}</span>
          {selected && <ResizeHandle object={object} onDown={onResizePointerDown} onMove={onResizePointerMove} onUp={onResizePointerUp} />}
        </section>
      );
    }

    if (object.type === 'text') {
      return (
        <article {...common}>
          {editingId === object.id ? (
            <textarea
              data-editor={object.id}
              className="text-editor"
              value={object.content}
              onChange={(event) => {
                const content = event.target.value;
                useFractalStore.getState().updateObject(object.id, { content, ...textAutoSize(content) } as Partial<SpatialObject>, false);
              }}
              onBlur={() => finishEditing(object.id)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') event.currentTarget.blur();
              }}
            />
          ) : (
            <div className="text-content">
              {object.content ? object.content.split('\n').map((line, index) => renderTextLine(line, index)) : <span className="placeholder">Start typing…</span>}
            </div>
          )}
        </article>
      );
    }

    if (object.type === 'drawing') {
      return (
        <figure {...common}>
          <svg className="drawing-svg" viewBox={`0 0 ${Math.max(1, object.width)} ${Math.max(1, object.height)}`} preserveAspectRatio="none">
            <path d={pathFromStrokes(object.strokes?.length ? object.strokes : [object.points])} style={{ strokeWidth: object.strokeWidth }} />
          </svg>
          {object.label && <figcaption className="drawing-caption">{object.label}</figcaption>}
        </figure>
      );
    }

    if (object.type === 'image') {
      return (
        <figure {...common}>
          <img src={object.src} alt={object.alt ?? ''} draggable={false} />
          {object.alt && <figcaption className="image-caption">{object.alt}</figcaption>}
          {selected && <ResizeHandle object={object} onDown={onResizePointerDown} onMove={onResizePointerMove} onUp={onResizePointerUp} />}
        </figure>
      );
    }

    return (
      <article {...common}>
        <a href={object.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          <div className="link-icon"><img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(object.domain)}&sz=64`} alt="" /></div>
          <div className="link-copy"><strong>{object.title}</strong><span>{object.domain}</span><small>{object.url}</small></div>
        </a>
        {selected && <ResizeHandle object={object} onDown={onResizePointerDown} onMove={onResizePointerMove} onUp={onResizePointerUp} />}
      </article>
    );
  };

  if (!hydrated) {
    return <div className="boot-screen"><div className="brand-dot">◉</div><strong>FRACTAL</strong><span>Opening your universe…</span></div>;
  }

  const isEmpty = currentObjects.length === 0 && currentSpaceId === homeSpaceId;

  return (
    <div className="app-shell" ref={rootRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="topbar">
        <button className="brand-button" onClick={goHome} aria-label="Go home"><span>◉</span><strong>Fractal</strong></button>
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          {breadcrumb.map((item, index) => <span key={item.id}><button onClick={() => enterSpace(item.id, true)}>{item.title}</button>{index < breadcrumb.length - 1 && <i>/</i>}</span>)}
        </nav>
        <div className="top-actions">
          <span className={`save-status ${saveStatus}`}>{saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Save error' : 'Saved'}</span>
          <button className="icon-button" onClick={() => setSearchOpen(true)} aria-label="Search">⌕</button>
          <button className="icon-button" onClick={() => useFractalStore.getState().setTheme(theme === 'light' ? 'dark' : 'light')} aria-label="Toggle theme">{theme === 'light' ? '◐' : '◑'}</button>
        </div>
      </header>

      <div
        className={`canvas ${spaceHeld ? 'panning-ready' : ''} ${drawingMode ? 'drawing-mode' : ''}`}
        ref={canvasRef}
        onWheel={onWheel}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerUp}
        onDoubleClick={onCanvasDoubleClick}
        onContextMenu={onCanvasContextMenu}
      >
        <div className="world" style={{ transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})` }}>
          <ConnectionsLayer
            connections={currentConnections}
            objects={objects}
            objectsBySpace={objectsBySpace}
            selectedIds={selectedIds}
            selectedConnectionId={selectedConnectionId}
            connectionSourceId={connectionSourceId}
            hoveredId={hoveredId}
            focusIds={focusIds}
            visibleIds={visibleIds}
            zoom={viewport.zoom}
            onSelect={(id) => useFractalStore.getState().selectConnection(id)}
            onContextMenu={(id, x, y) => {
              const rect = rootRef.current?.getBoundingClientRect();
              if (!rect) return;
              useFractalStore.getState().selectConnection(id);
              setContextMenu({
                x: clamp(x - rect.left + 12, 10, Math.max(10, rect.width - 188 - 10)),
                y: clamp(y - rect.top, 10, Math.max(10, rect.height - 140)),
                worldX: 0,
                worldY: 0,
                connectionId: id,
              });
            }}
          />
          {draftDrawing.some((stroke) => stroke.length > 1) && <svg className="drawing-draft" overflow="visible"><path d={pathFromStrokes(draftDrawing)} /></svg>}
          {visibleObjects
            .filter((object) => !(viewport.zoom < VERY_FAR_ZOOM && object.type !== 'bubble' && object.type !== 'portal'))
            .sort((a, b) => (a.type === 'frame' ? -1 : 0) - (b.type === 'frame' ? -1 : 0))
            .map(renderObject)}
        </div>

        {selectionBox && <div className="selection-rect" style={{ left: Math.min(selectionBox.startX, selectionBox.currentX), top: Math.min(selectionBox.startY, selectionBox.currentY), width: Math.abs(selectionBox.currentX - selectionBox.startX), height: Math.abs(selectionBox.currentY - selectionBox.startY) }} />}

        {isEmpty && (
          <div className="empty-state" onPointerDown={(e) => e.stopPropagation()}>
            <div className="empty-orb">◉</div>
            <h1>FRACTAL</h1>
            <p>Double-click anywhere<br />to create your first thought.</p>
            <div className="empty-hints"><span>Double-click <b>→ create</b></span><span>Drag <b>→ move</b></span><span>Scroll <b>→ explore</b></span></div>
            <button onClick={() => useFractalStore.getState().loadDemo()}>Explore demo universe</button>
          </div>
        )}
      </div>




      {connectionEditor && (
        <div className="modal-backdrop" onMouseDown={() => setConnectionEditor(null)}>
          <form className="small-dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            useFractalStore.getState().updateConnection(connectionEditor.id, { label: String(form.get('label') || ''), direction: form.get('direction') === 'forward' ? 'forward' : 'none' });
            setConnectionEditor(null);
          }}>
            <label>Connection</label>
            <input name="label" defaultValue={connectionEditor.label ?? ''} placeholder="Optional label" autoFocus />
            <label className="check-row"><input type="checkbox" name="direction" value="forward" defaultChecked={connectionEditor.direction === 'forward'} /> Directed →</label>
            <div><button type="button" onClick={() => setConnectionEditor(null)}>Cancel</button><button type="submit" className="primary">Apply</button></div>
          </form>
        </div>
      )}

      {contextMenu && (
        <div className={`right-click-menu ${contextMenu.objectId ? 'object-context-menu' : ''}`} style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(e) => e.stopPropagation()}>
          {contextMenu.connectionId ? <>
            <button onClick={() => {
              const edge = connections[contextMenu.connectionId!];
              if (edge) setConnectionEditor(edge);
              setContextMenu(null);
            }}>Label / direction</button>
            <button className="danger" onClick={() => { useFractalStore.getState().deleteConnection(contextMenu.connectionId!); setContextMenu(null); }}>Delete connection</button>
          </> : contextMenu.objectId ? (() => {
            const object = objects[contextMenu.objectId!];
            if (!object) return null;
            const selection = useFractalStore.getState().selectedIds;
            const selectedForMenu = selection.includes(object.id) ? selection.map((id) => objects[id]).filter((item): item is SpatialObject => Boolean(item)) : [object];
            const isMulti = selectedForMenu.length > 1;
            return <>
              {!isMulti && (object.type === 'bubble' || object.type === 'portal') && <button onClick={() => { openBubble(object as Bubble); setContextMenu(null); }}>Open</button>}
              {!isMulti && <button onClick={() => { useFractalStore.getState().startConnection(object.id); setContextMenu(null); }}>Connect</button>}
              {!isMulti && object.type === 'text' && <button onClick={() => {
                editingBefore.current = useFractalStore.getState().makeSnapshot();
                setEditingId(object.id);
                setContextMenu(null);
                requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-editor="${object.id}"]`)?.focus());
              }}>Edit text</button>}
              {!isMulti && object.type !== 'text' && <button onClick={() => {
                const fallback = objectTitle(object);
                const value = prompt(object.type === 'link' ? 'Link title' : 'Label', fallback === 'Image' || fallback === 'Drawing' ? '' : fallback);
                if (value !== null) useFractalStore.getState().renameObject(object.id, value);
                setContextMenu(null);
              }}>Rename / label</button>}
              {isMulti && <button onClick={() => { setBubbleDialog({ ids: selectedForMenu.map((item) => item.id), title: 'Research' }); setContextMenu(null); }}>Create Bubble</button>}
              <button onClick={() => { useFractalStore.getState().setFocus(selectedForMenu.map((item) => item.id)); setContextMenu(null); }}>Focus</button>
              {!isMulti && <button onClick={() => { useFractalStore.getState().duplicateObject(object.id); setContextMenu(null); }}>Duplicate</button>}
              {!isMulti && object.type === 'bubble' && <button onClick={() => {
                const p = screenToWorld((contextMenu.x + 220), (contextMenu.y + 80), viewportRef.current);
                useFractalStore.getState().createPortal(currentSpaceId, object.targetSpaceId, p.x - 90, p.y - 60);
                setContextMenu(null);
              }}>Create portal</button>}
              <button className="danger" onClick={() => { useFractalStore.getState().deleteSelected(); setContextMenu(null); }}>Delete{isMulti ? ` ${selectedForMenu.length} objects` : ''}</button>
            </>;
          })() : <>
            <button onClick={() => { const id = useFractalStore.getState().createText(currentSpaceId, contextMenu.worldX - 82, contextMenu.worldY - 32, ''); setEditingId(id); setContextMenu(null); }}>New text <kbd>T</kbd></button>
            <button onClick={() => { useFractalStore.getState().createEmptyBubble(currentSpaceId, contextMenu.worldX - 104, contextMenu.worldY - 83, 'New Space'); setContextMenu(null); }}>New Bubble <kbd>B</kbd></button>
            <button onClick={() => { useFractalStore.getState().createFrame(currentSpaceId, contextMenu.worldX - 260, contextMenu.worldY - 170, 'Frame'); setContextMenu(null); }}>New Frame <kbd>F</kbd></button>
            <button onClick={() => { setDrawingMode(true); setContextMenu(null); }}>Draw here <kbd>D</kbd></button>
          </>}
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    return <span key={index}>{part}</span>;
  });
}

function renderTextLine(line: string, index: number) {
  if (line.startsWith('## ')) return <h4 key={index}>{renderInline(line.slice(3))}</h4>;
  if (line.startsWith('# ')) return <h3 key={index}>{renderInline(line.slice(2))}</h3>;
  if (/^[-*] /.test(line)) return <div className="text-list-item" key={index}><i>•</i><span>{renderInline(line.slice(2))}</span></div>;
  const numbered = line.match(/^(\d+)\. (.*)$/);
  if (numbered) return <div className="text-list-item" key={index}><i>{numbered[1]}.</i><span>{renderInline(numbered[2])}</span></div>;
  return <p key={index}>{line ? renderInline(line) : '\u00A0'}</p>;
}

function ResizeHandle({
  object,
  onDown,
  onMove,
  onUp,
}: {
  object: SpatialObject;
  onDown: (event: ReactPointerEvent<HTMLButtonElement>, object: SpatialObject) => void;
  onMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  return <button className="resize-handle" data-resize-handle aria-label="Resize" onPointerDown={(e) => onDown(e, object)} onPointerMove={onMove} onPointerUp={onUp} />;
}

function ConnectionsLayer({
  connections,
  objects,
  objectsBySpace,
  selectedIds,
  selectedConnectionId,
  connectionSourceId,
  hoveredId,
  focusIds,
  visibleIds,
  zoom,
  onSelect,
  onContextMenu,
}: {
  connections: Connection[];
  objects: Record<ID, SpatialObject>;
  objectsBySpace: Map<ID, SpatialObject[]>;
  selectedIds: ID[];
  selectedConnectionId?: ID;
  connectionSourceId?: ID;
  hoveredId: ID | null;
  focusIds: ID[];
  visibleIds: Set<ID>;
  zoom: number;
  onSelect: (id: ID) => void;
  onContextMenu: (id: ID, clientX: number, clientY: number) => void;
}) {
  const edges = connections.filter((e) => visibleIds.has(e.sourceId) || visibleIds.has(e.targetId));
  return (
    <svg className="connections" overflow="visible">
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L7,4 L0,8 Z" /></marker>
      </defs>
      {edges.map((edge) => {
        const a = objects[edge.sourceId];
        const b = objects[edge.targetId];
        if (!a || !b) return null;
        const aRect = getVisualRect(a, objectsBySpace);
        const bRect = getVisualRect(b, objectsBySpace);
        const aCenter = { x: aRect.x + aRect.width / 2, y: aRect.y + aRect.height / 2 };
        const bCenter = { x: bRect.x + bRect.width / 2, y: bRect.y + bRect.height / 2 };
        const start = connectionAnchor(a, bCenter, objectsBySpace);
        const end = connectionAnchor(b, aCenter, objectsBySpace);
        const ax = start.x;
        const ay = start.y;
        const bx = end.x;
        const by = end.y;
        const dx = bx - ax;
        const curve = Math.min(160, Math.max(36, Math.abs(dx) * 0.4));
        const path = `M ${ax} ${ay} C ${ax + (dx >= 0 ? curve : -curve)} ${ay}, ${bx - (dx >= 0 ? curve : -curve)} ${by}, ${bx} ${by}`;
        const emphasized = selectedIds.includes(a.id) || selectedIds.includes(b.id) || hoveredId === a.id || hoveredId === b.id || connectionSourceId === a.id || connectionSourceId === b.id || selectedConnectionId === edge.id;
        const focusVisible = focusIds.length === 0 || focusIds.includes(a.id) || focusIds.includes(b.id);
        const midX = (ax + bx) / 2;
        const midY = (ay + by) / 2;
        return <g key={edge.id} className={`connection ${emphasized ? 'emphasized' : ''} ${focusVisible ? '' : 'deemphasized'} ${selectedConnectionId === edge.id ? 'selected' : ''}`}>
          <path className="edge-hit" d={path} onClick={(e) => { e.stopPropagation(); onSelect(edge.id); }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(edge.id, e.clientX, e.clientY); }} />
          <path className="edge-path" d={path} markerEnd={edge.direction === 'forward' ? 'url(#arrowhead)' : undefined} />
          {edge.label && zoom > 0.45 && <text x={midX} y={midY - 8} textAnchor="middle">{edge.label}</text>}
        </g>;
      })}
    </svg>
  );
}
