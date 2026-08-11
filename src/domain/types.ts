export type ID = string;

export type Viewport = {
  x: number;
  y: number;
  zoom: number;
};

export type Space = {
  id: ID;
  title: string;
  parentSpaceId?: ID;
  parentBubbleId?: ID;
  createdAt: number;
  updatedAt: number;
};

export type BaseObject = {
  id: ID;
  spaceId: ID;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation in degrees around the object's visual center. */
  rotation?: number;
  createdAt: number;
  updatedAt: number;
};

export type TextFragment = BaseObject & {
  type: 'text';
  content: string;
};

export type ImageFragment = BaseObject & {
  type: 'image';
  src: string;
  /** User-visible caption. Kept as alt for backwards compatibility with v0.1 data. */
  alt?: string;
};

export type LinkFragment = BaseObject & {
  type: 'link';
  url: string;
  title: string;
  domain: string;
  previewImage?: string;
};

export type DrawingPoint = {
  x: number;
  y: number;
  pressure?: number;
};

export type DrawingFragment = BaseObject & {
  type: 'drawing';
  /** Flattened points kept for backwards compatibility with older saves. */
  points: DrawingPoint[];
  /** Multi-stroke representation used by the continuous drawing mode. */
  strokes?: DrawingPoint[][];
  strokeWidth: number;
  label?: string;
};



export type CalculatorFragment = BaseObject & {
  type: 'calculator';
};

export type MeasureUnit = 'cm' | 'm' | 'km';

export type MeasureFragment = BaseObject & {
  type: 'measure';
  unit: MeasureUnit;
  /** Endpoints stored in local object coordinates so the label stays attached while moving. */
  start: { x: number; y: number };
  end: { x: number; y: number };
};

export type Bubble = BaseObject & {
  type: 'bubble';
  title: string;
  targetSpaceId: ID;
};

export type Frame = BaseObject & {
  type: 'frame';
  title: string;
};

export type Portal = BaseObject & {
  type: 'portal';
  title: string;
  targetSpaceId: ID;
};

export type SpatialObject = TextFragment | ImageFragment | LinkFragment | DrawingFragment | CalculatorFragment | MeasureFragment | Bubble | Frame | Portal;

export type Connection = {
  id: ID;
  spaceId: ID;
  sourceId: ID;
  targetId: ID;
  direction?: 'none' | 'forward';
  label?: string;
  createdAt: number;
  updatedAt: number;
};

export type TimelineEntry = {
  id: ID;
  at: number;
  label: string;
};

export type PersistedState = {
  version: 1;
  homeSpaceId: ID;
  currentSpaceId: ID;
  spaces: Record<ID, Space>;
  objects: Record<ID, SpatialObject>;
  connections: Record<ID, Connection>;
  viewports: Record<ID, Viewport>;
  timeline: TimelineEntry[];
  undo: Snapshot[];
  redo: Snapshot[];
};

export type Snapshot = Omit<PersistedState, 'undo' | 'redo'>;

export type SearchResult = {
  id: ID;
  spaceId: ID;
  kind: 'object' | 'space';
  title: string;
  subtitle: string;
};
