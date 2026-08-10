import { create } from 'zustand';
import type {
  Bubble,
  Connection,
  DrawingFragment,
  DrawingPoint,
  Frame,
  ID,
  ImageFragment,
  LinkFragment,
  PersistedState,
  Portal,
  SearchResult,
  Snapshot,
  Space,
  SpatialObject,
  TextFragment,
  Viewport,
} from '../domain/types';
import { makeId } from '../domain/ids';
import { getBounds } from '../utils/math';
import { linkMeta } from '../utils/link';

export type SaveStatus = 'saved' | 'saving' | 'error';
export type ThemeMode = 'light' | 'dark';

type FractalStore = PersistedState & {
  hydrated: boolean;
  revision: number;
  saveStatus: SaveStatus;
  selectedIds: ID[];
  selectedConnectionId?: ID;
  connectionSourceId?: ID;
  focusIds: ID[];
  theme: ThemeMode;
  hydrateFrom: (data: PersistedState | null) => void;
  setSaveStatus: (status: SaveStatus) => void;
  setTheme: (theme: ThemeMode) => void;
  setSelection: (ids: ID[]) => void;
  toggleSelection: (id: ID) => void;
  clearSelection: () => void;
  selectConnection: (id?: ID) => void;
  startConnection: (sourceId?: ID) => void;
  setFocus: (ids: ID[]) => void;
  createText: (spaceId: ID, x: number, y: number, content?: string) => ID;
  createImage: (spaceId: ID, x: number, y: number, src: string, dimensions?: { width: number; height: number }) => ID;
  createDrawing: (spaceId: ID, strokes: DrawingPoint[][], label?: string) => ID | undefined;
  createLink: (spaceId: ID, x: number, y: number, rawUrl: string) => ID;
  createEmptyBubble: (spaceId: ID, x: number, y: number, title?: string) => ID;
  createFrame: (spaceId: ID, x: number, y: number, title?: string) => ID;
  createPortal: (spaceId: ID, targetSpaceId: ID, x: number, y: number) => ID;
  createConnection: (spaceId: ID, sourceId: ID, targetId: ID) => ID | undefined;
  updateConnection: (id: ID, patch: Partial<Pick<Connection, 'label' | 'direction'>>) => void;
  deleteConnection: (id: ID) => void;
  updateObject: (id: ID, patch: Partial<SpatialObject>, record?: boolean, label?: string) => void;
  moveObjectsTransient: (positions: Record<ID, { x: number; y: number }>) => void;
  resizeObjectTransient: (id: ID, width: number, height: number) => void;
  recordSnapshot: (before: Snapshot, label: string) => void;
  makeSnapshot: () => Snapshot;
  renameObject: (id: ID, title: string) => void;
  duplicateObject: (id: ID) => ID | undefined;
  deleteSelected: () => void;
  createBubbleFromSelection: (ids: ID[], title: string) => ID | undefined;
  setViewport: (spaceId: ID, viewport: Viewport) => void;
  enterSpace: (spaceId: ID) => void;
  undoAction: () => void;
  redoAction: () => void;
  search: (query: string) => SearchResult[];
  loadDemo: () => void;
  resetAll: () => void;
};

const now = () => Date.now();
const defaultViewport = (): Viewport => ({ x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 });

const textAutoSize = (content: string) => {
  const lines = (content || 'Start typing…').split('\n');
  const longest = Math.max(8, ...lines.map((line) => line.length));
  const width = Math.max(158, Math.min(390, 82 + longest * 7.15));
  const charsPerLine = Math.max(14, Math.floor((width - 36) / 7.1));
  const visualLines = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(Math.max(1, line.length) / charsPerLine)), 0);
  const height = Math.max(60, Math.min(520, 32 + visualLines * 21));
  return { width: Math.round(width), height: Math.round(height) };
};

const createEmptyPersisted = (): PersistedState => {
  const ts = now();
  const home: Space = { id: 'space_home', title: 'Home', createdAt: ts, updatedAt: ts };
  return {
    version: 1,
    homeSpaceId: home.id,
    currentSpaceId: home.id,
    spaces: { [home.id]: home },
    objects: {},
    connections: {},
    viewports: { [home.id]: defaultViewport() },
    timeline: [],
    undo: [],
    redo: [],
  };
};

const initial = createEmptyPersisted();

const makeSnapshotFrom = (state: FractalStore | PersistedState): Snapshot => ({
  version: 1,
  homeSpaceId: state.homeSpaceId,
  currentSpaceId: state.currentSpaceId,
  spaces: structuredClone(state.spaces),
  objects: structuredClone(state.objects),
  connections: structuredClone(state.connections),
  viewports: structuredClone(state.viewports),
  timeline: structuredClone(state.timeline),
});

const withSnapshot = (state: FractalStore, before: Snapshot, label: string) => ({
  undo: [...state.undo.slice(-39), before],
  redo: [],
  timeline: [...state.timeline.slice(-199), { id: makeId('event'), at: now(), label }],
  revision: state.revision + 1,
  saveStatus: 'saving' as SaveStatus,
});

const titleOf = (object: SpatialObject, spaces: Record<ID, Space>) => {
  if (object.type === 'text') return object.content.trim().split('\n')[0] || 'Untitled thought';
  if (object.type === 'image') return object.alt || 'Image';
  if (object.type === 'link') return object.title || object.domain;
  if (object.type === 'drawing') return object.label || 'Drawing';
  if (object.type === 'bubble' || object.type === 'frame' || object.type === 'portal') return object.title || spaces[(object as Bubble | Portal).targetSpaceId]?.title || 'Untitled';
  return 'Object';
};

export const useFractalStore = create<FractalStore>((set, get) => ({
  ...initial,
  hydrated: false,
  revision: 0,
  saveStatus: 'saved',
  selectedIds: [],
  selectedConnectionId: undefined,
  connectionSourceId: undefined,
  focusIds: [],
  theme: (localStorage.getItem('fractal-theme') as ThemeMode) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),

  hydrateFrom: (data) => {
    const source = data?.version === 1 ? data : createEmptyPersisted();
    const normalizedObjects = Object.fromEntries(Object.entries(source.objects ?? {}).map(([id, object]) => {
      if (object.type !== 'text') return [id, object];
      return [id, { ...object, ...textAutoSize(object.content) } as SpatialObject];
    }));
    set({
      ...source,
      objects: normalizedObjects,
      undo: source.undo ?? [],
      redo: source.redo ?? [],
      hydrated: true,
      revision: 0,
      saveStatus: 'saved',
      selectedIds: [],
      selectedConnectionId: undefined,
      connectionSourceId: undefined,
      focusIds: [],
    });
  },

  setSaveStatus: (saveStatus) => set({ saveStatus }),

  setTheme: (theme) => {
    localStorage.setItem('fractal-theme', theme);
    set({ theme });
  },

  setSelection: (selectedIds) => set({ selectedIds, selectedConnectionId: undefined }),
  toggleSelection: (id) => set((s) => ({
    selectedIds: s.selectedIds.includes(id) ? s.selectedIds.filter((item) => item !== id) : [...s.selectedIds, id],
    selectedConnectionId: undefined,
  })),
  clearSelection: () => set({ selectedIds: [], selectedConnectionId: undefined, connectionSourceId: undefined }),
  selectConnection: (selectedConnectionId) => set({ selectedConnectionId, selectedIds: [] }),
  startConnection: (connectionSourceId) => set({ connectionSourceId }),
  setFocus: (focusIds) => set({ focusIds }),

  makeSnapshot: () => makeSnapshotFrom(get()),
  recordSnapshot: (before, label) => set((state) => withSnapshot(state, before, label)),

  createText: (spaceId, x, y, content = '') => {
    const id = makeId('text');
    const ts = now();
    const size = textAutoSize(content);
    const object: TextFragment = { id, spaceId, x, y, ...size, type: 'text', content, createdAt: ts, updatedAt: ts };
    const before = makeSnapshotFrom(get());
    set((state) => ({
      objects: { ...state.objects, [id]: object },
      selectedIds: [id],
      ...withSnapshot(state, before, 'Created thought'),
    }));
    return id;
  },

  createImage: (spaceId, x, y, src, dimensions) => {
    const id = makeId('image');
    const ts = now();
    const ratio = dimensions ? dimensions.width / Math.max(1, dimensions.height) : 1.45;
    const width = 280;
    const height = Math.max(150, Math.min(320, width / ratio));
    const object: ImageFragment = { id, spaceId, x, y, width, height, type: 'image', src, createdAt: ts, updatedAt: ts };
    const before = makeSnapshotFrom(get());
    set((state) => ({ objects: { ...state.objects, [id]: object }, selectedIds: [id], ...withSnapshot(state, before, 'Added image') }));
    return id;
  },

  createDrawing: (spaceId, strokes, label = '') => {
    const normalizedStrokes = strokes.map((stroke) => stroke.filter(Boolean)).filter((stroke) => stroke.length > 0);
    const points = normalizedStrokes.flat();
    if (points.length < 2) return undefined;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const pad = 12;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const maxX = Math.max(...xs) + pad;
    const maxY = Math.max(...ys) + pad;
    const width = Math.max(28, maxX - minX);
    const height = Math.max(28, maxY - minY);
    const id = makeId('drawing');
    const ts = now();
    const localStrokes = normalizedStrokes.map((stroke) => stroke.map((point) => ({ ...point, x: point.x - minX, y: point.y - minY })));
    const object: DrawingFragment = {
      id,
      spaceId,
      x: minX,
      y: minY,
      width,
      height,
      type: 'drawing',
      points: localStrokes.flat(),
      strokes: localStrokes,
      strokeWidth: 3.2,
      label: label.trim() || undefined,
      createdAt: ts,
      updatedAt: ts,
    };
    const before = makeSnapshotFrom(get());
    set((state) => ({ objects: { ...state.objects, [id]: object }, selectedIds: [id], ...withSnapshot(state, before, 'Added drawing') }));
    return id;
  },

  createLink: (spaceId, x, y, rawUrl) => {
    const id = makeId('link');
    const ts = now();
    const meta = linkMeta(rawUrl);
    const object: LinkFragment = { id, spaceId, x, y, width: 300, height: 128, type: 'link', ...meta, createdAt: ts, updatedAt: ts };
    const before = makeSnapshotFrom(get());
    set((state) => ({ objects: { ...state.objects, [id]: object }, selectedIds: [id], ...withSnapshot(state, before, `Added ${meta.domain}`) }));
    return id;
  },

  createEmptyBubble: (spaceId, x, y, title = 'Untitled space') => {
    const id = makeId('bubble');
    const childId = makeId('space');
    const ts = now();
    const child: Space = { id: childId, title, parentSpaceId: spaceId, parentBubbleId: id, createdAt: ts, updatedAt: ts };
    const bubble: Bubble = { id, spaceId, x, y, width: 208, height: 166, type: 'bubble', title, targetSpaceId: childId, createdAt: ts, updatedAt: ts };
    const before = makeSnapshotFrom(get());
    set((state) => ({
      spaces: { ...state.spaces, [childId]: child },
      objects: { ...state.objects, [id]: bubble },
      viewports: { ...state.viewports, [childId]: defaultViewport() },
      selectedIds: [id],
      ...withSnapshot(state, before, `Created space “${title}”`),
    }));
    return id;
  },

  createFrame: (spaceId, x, y, title = 'Frame') => {
    const id = makeId('frame');
    const ts = now();
    const object: Frame = { id, spaceId, x, y, width: 520, height: 340, type: 'frame', title, createdAt: ts, updatedAt: ts };
    const before = makeSnapshotFrom(get());
    set((state) => ({ objects: { ...state.objects, [id]: object }, selectedIds: [id], ...withSnapshot(state, before, `Created frame “${title}”`) }));
    return id;
  },

  createPortal: (spaceId, targetSpaceId, x, y) => {
    const target = get().spaces[targetSpaceId];
    const id = makeId('portal');
    const ts = now();
    const object: Portal = { id, spaceId, x, y, width: 180, height: 118, type: 'portal', title: target?.title || 'Portal', targetSpaceId, createdAt: ts, updatedAt: ts };
    const before = makeSnapshotFrom(get());
    set((state) => ({ objects: { ...state.objects, [id]: object }, selectedIds: [id], ...withSnapshot(state, before, `Created portal to “${object.title}”`) }));
    return id;
  },

  createConnection: (spaceId, sourceId, targetId) => {
    if (sourceId === targetId) return undefined;
    const state = get();
    const duplicate = Object.values(state.connections).find((edge) => edge.spaceId === spaceId && ((edge.sourceId === sourceId && edge.targetId === targetId) || (edge.sourceId === targetId && edge.targetId === sourceId)));
    if (duplicate) return duplicate.id;
    const id = makeId('edge');
    const ts = now();
    const connection: Connection = { id, spaceId, sourceId, targetId, direction: 'none', createdAt: ts, updatedAt: ts };
    const before = makeSnapshotFrom(state);
    set((current) => ({ connections: { ...current.connections, [id]: connection }, connectionSourceId: undefined, selectedIds: [], selectedConnectionId: id, ...withSnapshot(current, before, 'Connected objects') }));
    return id;
  },

  updateConnection: (id, patch) => {
    const current = get().connections[id];
    if (!current) return;
    const before = makeSnapshotFrom(get());
    set((state) => ({
      connections: { ...state.connections, [id]: { ...current, ...patch, updatedAt: now() } },
      ...withSnapshot(state, before, 'Updated connection'),
    }));
  },

  deleteConnection: (id) => {
    if (!get().connections[id]) return;
    const before = makeSnapshotFrom(get());
    set((state) => {
      const connections = { ...state.connections };
      delete connections[id];
      return { connections, selectedConnectionId: undefined, ...withSnapshot(state, before, 'Deleted connection') };
    });
  },

  updateObject: (id, patch, record = true, label = 'Updated object') => {
    const current = get().objects[id];
    if (!current) return;
    const before = record ? makeSnapshotFrom(get()) : undefined;
    set((state) => ({
      objects: { ...state.objects, [id]: { ...current, ...patch, updatedAt: now() } as SpatialObject },
      revision: state.revision + 1,
      saveStatus: 'saving',
      ...(before ? withSnapshot(state, before, label) : {}),
    }));
  },

  moveObjectsTransient: (positions) => set((state) => {
    const objects = { ...state.objects };
    const ts = now();
    for (const [id, pos] of Object.entries(positions)) {
      const object = objects[id];
      if (object) objects[id] = { ...object, ...pos, updatedAt: ts } as SpatialObject;
    }
    return { objects, revision: state.revision + 1, saveStatus: 'saving' };
  }),

  resizeObjectTransient: (id, width, height) => set((state) => {
    const object = state.objects[id];
    if (!object) return state;
    return {
      objects: { ...state.objects, [id]: { ...object, width, height, updatedAt: now() } as SpatialObject },
      revision: state.revision + 1,
      saveStatus: 'saving',
    };
  }),

  renameObject: (id, title) => {
    const object = get().objects[id];
    if (!object) return;
    const raw = title.trim();
    const value = object.type === 'image' || object.type === 'drawing' ? raw : raw || 'Untitled';
    const before = makeSnapshotFrom(get());
    set((state) => {
      const updated = object.type === 'text'
        ? ({ ...object, content: value, ...textAutoSize(value), updatedAt: now() } as SpatialObject)
        : object.type === 'image'
          ? ({ ...object, alt: value || undefined, updatedAt: now() } as SpatialObject)
          : object.type === 'drawing'
            ? ({ ...object, label: value || undefined, updatedAt: now() } as SpatialObject)
            : object.type === 'bubble' || object.type === 'portal' || object.type === 'frame' || object.type === 'link'
              ? ({ ...object, title: value, updatedAt: now() } as SpatialObject)
              : object;
      const spaces = { ...state.spaces };
      if (object.type === 'bubble') {
        const child = spaces[object.targetSpaceId];
        if (child) spaces[child.id] = { ...child, title: value, updatedAt: now() };
      }
      return { objects: { ...state.objects, [id]: updated }, spaces, ...withSnapshot(state, before, value ? `Renamed to “${value}”` : 'Removed label') };
    });
  },

  duplicateObject: (id) => {
    const object = get().objects[id];
    if (!object) return undefined;
    const cloneId = makeId(object.type);
    const ts = now();
    const clone = { ...structuredClone(object), id: cloneId, x: object.x + 28, y: object.y + 28, createdAt: ts, updatedAt: ts } as SpatialObject;
    const before = makeSnapshotFrom(get());
    set((state) => ({ objects: { ...state.objects, [cloneId]: clone }, selectedIds: [cloneId], ...withSnapshot(state, before, 'Duplicated object') }));
    return cloneId;
  },

  deleteSelected: () => {
    const ids = get().selectedIds;
    const edgeId = get().selectedConnectionId;
    if (!ids.length && !edgeId) return;
    if (edgeId) return get().deleteConnection(edgeId);
    const before = makeSnapshotFrom(get());
    const idSet = new Set(ids);
    set((state) => {
      const objects = { ...state.objects };
      ids.forEach((id) => delete objects[id]);
      const connections = Object.fromEntries(Object.entries(state.connections).filter(([, edge]) => !idSet.has(edge.sourceId) && !idSet.has(edge.targetId)));
      return { objects, connections, selectedIds: [], ...withSnapshot(state, before, `Deleted ${ids.length} object${ids.length === 1 ? '' : 's'}`) };
    });
  },

  createBubbleFromSelection: (ids, title) => {
    const state = get();
    const selected = ids.map((id) => state.objects[id]).filter(Boolean);
    if (!selected.length) return undefined;
    const spaceId = selected[0].spaceId;
    if (selected.some((object) => object.spaceId !== spaceId)) return undefined;
    const before = makeSnapshotFrom(state);
    const bounds = getBounds(selected);
    const bubbleId = makeId('bubble');
    const childSpaceId = makeId('space');
    const ts = now();
    const safeTitle = title.trim() || 'Untitled space';
    const child: Space = { id: childSpaceId, title: safeTitle, parentSpaceId: spaceId, parentBubbleId: bubbleId, createdAt: ts, updatedAt: ts };
    const bubble: Bubble = {
      id: bubbleId,
      spaceId,
      x: bounds.x + bounds.width / 2 - 104,
      y: bounds.y + bounds.height / 2 - 83,
      width: 208,
      height: 166,
      type: 'bubble',
      title: safeTitle,
      targetSpaceId: childSpaceId,
      createdAt: ts,
      updatedAt: ts,
    };
    const idSet = new Set(ids);
    const objects = { ...state.objects, [bubbleId]: bubble };
    for (const object of selected) {
      objects[object.id] = {
        ...object,
        spaceId: childSpaceId,
        x: object.x - bounds.x + 140,
        y: object.y - bounds.y + 140,
        updatedAt: ts,
      } as SpatialObject;
    }
    const connections = { ...state.connections };
    for (const [edgeId, edge] of Object.entries(connections)) {
      if (edge.spaceId !== spaceId) continue;
      const sourceInside = idSet.has(edge.sourceId);
      const targetInside = idSet.has(edge.targetId);
      if (sourceInside && targetInside) {
        connections[edgeId] = { ...edge, spaceId: childSpaceId, updatedAt: ts };
      } else if (sourceInside || targetInside) {
        connections[edgeId] = {
          ...edge,
          sourceId: sourceInside ? bubbleId : edge.sourceId,
          targetId: targetInside ? bubbleId : edge.targetId,
          updatedAt: ts,
        };
      }
    }
    set((current) => ({
      spaces: { ...current.spaces, [childSpaceId]: child },
      objects,
      connections,
      viewports: { ...current.viewports, [childSpaceId]: { x: window.innerWidth / 2 - (bounds.width / 2 + 140), y: window.innerHeight / 2 - (bounds.height / 2 + 140), zoom: 1 } },
      selectedIds: [bubbleId],
      ...withSnapshot(current, before, `Created Bubble “${safeTitle}” from ${ids.length} objects`),
    }));
    return bubbleId;
  },

  setViewport: (spaceId, viewport) => set((state) => ({
    viewports: { ...state.viewports, [spaceId]: viewport },
    revision: state.revision + 1,
    saveStatus: 'saving',
  })),

  enterSpace: (spaceId) => {
    if (!get().spaces[spaceId]) return;
    set((state) => ({
      currentSpaceId: spaceId,
      selectedIds: [],
      selectedConnectionId: undefined,
      connectionSourceId: undefined,
      focusIds: [],
      viewports: state.viewports[spaceId] ? state.viewports : { ...state.viewports, [spaceId]: defaultViewport() },
      revision: state.revision + 1,
      saveStatus: 'saving',
    }));
  },

  undoAction: () => {
    const state = get();
    const target = state.undo.at(-1);
    if (!target) return;
    const current = makeSnapshotFrom(state);
    set({
      ...structuredClone(target),
      undo: state.undo.slice(0, -1),
      redo: [...state.redo.slice(-39), current],
      selectedIds: [],
      selectedConnectionId: undefined,
      connectionSourceId: undefined,
      revision: state.revision + 1,
      saveStatus: 'saving',
    });
  },

  redoAction: () => {
    const state = get();
    const target = state.redo.at(-1);
    if (!target) return;
    const current = makeSnapshotFrom(state);
    set({
      ...structuredClone(target),
      undo: [...state.undo.slice(-39), current],
      redo: state.redo.slice(0, -1),
      selectedIds: [],
      selectedConnectionId: undefined,
      connectionSourceId: undefined,
      revision: state.revision + 1,
      saveStatus: 'saving',
    });
  },

  search: (query) => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const state = get();
    const results: SearchResult[] = [];
    for (const space of Object.values(state.spaces)) {
      if (space.title.toLowerCase().includes(q)) {
        results.push({ id: space.id, spaceId: space.id, kind: 'space', title: space.title, subtitle: 'Space' });
      }
    }
    for (const object of Object.values(state.objects)) {
      let haystack = titleOf(object, state.spaces);
      if (object.type === 'text') haystack += ` ${object.content}`;
      if (object.type === 'link') haystack += ` ${object.url} ${object.domain}`;
      if (haystack.toLowerCase().includes(q)) {
        results.push({ id: object.id, spaceId: object.spaceId, kind: 'object', title: titleOf(object, state.spaces), subtitle: state.spaces[object.spaceId]?.title || 'Space' });
      }
    }
    return results.slice(0, 30);
  },

  loadDemo: () => {
    const state = get();
    if (Object.keys(state.objects).length) return;
    const before = makeSnapshotFrom(state);
    const ts = now();
    const home = state.homeSpaceId;
    const spaces = { ...state.spaces };
    const objects = { ...state.objects };
    const connections = { ...state.connections };
    const addBubble = (title: string, x: number, y: number, parent = home) => {
      const bubbleId = makeId('bubble');
      const spaceId = makeId('space');
      spaces[spaceId] = { id: spaceId, title, parentSpaceId: parent, parentBubbleId: bubbleId, createdAt: ts, updatedAt: ts };
      objects[bubbleId] = { id: bubbleId, spaceId: parent, x, y, width: 208, height: 166, type: 'bubble', title, targetSpaceId: spaceId, createdAt: ts, updatedAt: ts } as Bubble;
      return { bubbleId, spaceId };
    };
    const work = addBubble('Work', -420, -110);
    addBubble('Learning', 240, -330);
    addBubble('Travel', 360, 240);
    addBubble('Personal', -520, 300);
    const fractal = addBubble('Fractal', 20, -40, work.spaceId);
    const research = addBubble('Research', -300, -190, fractal.spaceId);
    const design = addBubble('Design', 230, 80, fractal.spaceId);
    const market = addBubble('Market', -20, 260, fractal.spaceId);
    const thoughtId = makeId('text');
    objects[thoughtId] = { id: thoughtId, spaceId: fractal.spaceId, x: -20, y: -50, width: 270, height: 150, type: 'text', content: 'Ideas don’t belong in folders.\n\nCreate first. Organize later.', createdAt: ts, updatedAt: ts } as TextFragment;
    const connect = (spaceId: ID, sourceId: ID, targetId: ID, label?: string) => {
      const id = makeId('edge');
      connections[id] = { id, spaceId, sourceId, targetId, direction: 'none', label, createdAt: ts, updatedAt: ts };
    };
    connect(fractal.spaceId, research.bubbleId, thoughtId, 'informs');
    connect(fractal.spaceId, thoughtId, design.bubbleId);
    connect(fractal.spaceId, thoughtId, market.bubbleId);
    set((current) => ({
      spaces,
      objects,
      connections,
      viewports: { ...current.viewports, ...Object.fromEntries(Object.keys(spaces).map((id) => [id, defaultViewport()])) },
      ...withSnapshot(current, before, 'Loaded demo universe'),
    }));
  },

  resetAll: () => {
    const fresh = createEmptyPersisted();
    set((state) => ({
      ...fresh,
      hydrated: true,
      selectedIds: [],
      selectedConnectionId: undefined,
      connectionSourceId: undefined,
      focusIds: [],
      revision: state.revision + 1,
      saveStatus: 'saving',
    }));
  },
}));

export const serializeStore = (state: FractalStore): PersistedState => ({
  version: 1,
  homeSpaceId: state.homeSpaceId,
  currentSpaceId: state.currentSpaceId,
  spaces: state.spaces,
  objects: state.objects,
  connections: state.connections,
  viewports: state.viewports,
  timeline: state.timeline,
  undo: state.undo,
  redo: state.redo,
});
