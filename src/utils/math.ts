import type { SpatialObject, Viewport } from '../domain/types';

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const screenToWorld = (point: Point, viewport: Viewport): Point => ({
  x: (point.x - viewport.x) / viewport.zoom,
  y: (point.y - viewport.y) / viewport.zoom,
});

export const worldToScreen = (point: Point, viewport: Viewport): Point => ({
  x: point.x * viewport.zoom + viewport.x,
  y: point.y * viewport.zoom + viewport.y,
});

export const objectRect = (object: SpatialObject): Rect => ({
  x: object.x,
  y: object.y,
  width: object.width,
  height: object.height,
});

export const rectsIntersect = (a: Rect, b: Rect) =>
  a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;

export const getBounds = (objects: SpatialObject[]): Rect => {
  if (!objects.length) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...objects.map((o) => o.x));
  const minY = Math.min(...objects.map((o) => o.y));
  const maxX = Math.max(...objects.map((o) => o.x + o.width));
  const maxY = Math.max(...objects.map((o) => o.y + o.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

export const viewportWorldRect = (viewport: Viewport, width: number, height: number, overscan = 320): Rect => ({
  x: (-viewport.x - overscan) / viewport.zoom,
  y: (-viewport.y - overscan) / viewport.zoom,
  width: (width + overscan * 2) / viewport.zoom,
  height: (height + overscan * 2) / viewport.zoom,
});

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
