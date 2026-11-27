import type { DrawioCell, Rect } from './types';

export const isImageCell = (c: DrawioCell) => c.style.shape === 'image' || c.baseStyle === 'image';
export const isTextCell = (c: DrawioCell) => c.baseStyle === 'text' || c.style.shape === 'text';

/**
 * Calcula bounds absolutos y la jerarquía de contenedores.
 *
 * draw.io permite anidar de verdad (atributo `parent` apuntando a otro vértice, con geometría
 * relativa al padre), pero muchos diagramas —como los de arquitectura AWS— dibujan los
 * "contenedores" como rectángulos sueltos encima de los que se colocan los iconos, con todo
 * colgando de la capa raíz. Para darles profundidad en 3D inferimos la anidación por contención
 * geométrica: el contenedor de un vértice es el rectángulo (no imagen, no texto) más pequeño que
 * lo encierra por completo.
 */
export function resolveHierarchy(cells: DrawioCell[]): void {
  const byId = new Map(cells.map((c) => [c.id, c]));

  // 1. Bounds absolutos (sumando el offset de los padres reales).
  const computing = new Set<string>();
  const absOf = (c: DrawioCell): Rect | undefined => {
    if (c.bounds) return c.bounds;
    if (!c.vertex || !c.geometry || c.geometry.relative) return undefined;
    if (computing.has(c.id)) return undefined;
    computing.add(c.id);
    const parent = c.parent ? byId.get(c.parent) : undefined;
    if (parent?.edge) {
      computing.delete(c.id);
      return undefined; // etiqueta de arista: se posiciona sobre el trazo
    }
    const pAbs = parent?.vertex ? absOf(parent) : undefined;
    const g = c.geometry;
    c.bounds = { x: g.x + (pAbs?.x ?? 0), y: g.y + (pAbs?.y ?? 0), width: g.width, height: g.height };
    computing.delete(c.id);
    return c.bounds;
  };
  cells.forEach(absOf);

  // 2. Contenedor: padre real si es vértice; si no, inferido por contención.
  const vertices = cells.filter((c) => c.bounds);
  const candidates = vertices.filter((c) => !isImageCell(c) && !isTextCell(c) && c.bounds!.width > 0 && c.bounds!.height > 0);
  const area = (r: Rect) => r.width * r.height;
  const EPS = 1;
  const contains = (o: Rect, i: Rect) =>
    i.x >= o.x - EPS && i.y >= o.y - EPS && i.x + i.width <= o.x + o.width + EPS && i.y + i.height <= o.y + o.height + EPS;

  for (const c of vertices) {
    const parent = c.parent ? byId.get(c.parent) : undefined;
    if (parent?.vertex && parent.bounds) {
      c.container = parent.id;
      continue;
    }
    let best: DrawioCell | undefined;
    for (const k of candidates) {
      if (k === c) continue;
      if (area(k.bounds!) <= area(c.bounds!)) continue;
      if (!contains(k.bounds!, c.bounds!)) continue;
      if (!best || area(k.bounds!) < area(best.bounds!)) best = k;
    }
    if (best) c.container = best.id;
  }

  // 3. Profundidad y marca de contenedor.
  const depthOf = (c: DrawioCell, guard = 0): number => {
    if (!c.container || guard > 64) return 0;
    const p = byId.get(c.container);
    return p ? depthOf(p, guard + 1) + 1 : 0;
  };
  for (const c of vertices) {
    c.depth = depthOf(c);
    if (c.container) byId.get(c.container)!.isContainer = true;
  }
}
