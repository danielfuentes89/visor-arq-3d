import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { DrawioCell, DrawioPage, Point, Rect } from './types';
import { isImageCell, isTextCell } from './hierarchy';
import { defaultIconTexture, type IconTextureProvider } from './textures';

export interface DrawioBuildOptions {
  /** Píxeles de draw.io por unidad de three.js. */
  scale?: number;
  /** Separación vertical entre niveles de anidación (unidades). 0 = diagrama plano. */
  levelGap?: number;
  /** Altura de los bloques (rectángulos con relleno). */
  blockHeight?: number;
  /** Proveedor de texturas para shape=image (inyectable en tests). */
  iconTexture?: IconTextureProvider | null;
  /** Crear etiquetas HTML (CSS2DObject). */
  labels?: boolean;
}

export interface DrawioPageStats {
  vertices: number;
  edges: number;
  containers: number;
  images: number;
  labels: number;
  maxDepth: number;
}

/** Datos que se guardan en `object.userData.cell` para el panel de propiedades. */
export interface CellInfo {
  id: string;
  kind: 'container' | 'image' | 'block' | 'text' | 'edge';
  label: string;
  depth: number;
  container?: string;
  source?: string;
  target?: string;
  style: Record<string, string>;
  attributes: Record<string, string>;
}

const SLAB = 0.03;
const DEFAULTS = { scale: 100, levelGap: 0.5, blockHeight: 0.12, labels: true };

/** Construye un THREE.Group a partir de una página draw.io (centrada en el origen, plano XZ). */
export function buildDrawioPage(page: DrawioPage, options: DrawioBuildOptions = {}): THREE.Group {
  const opt = { ...DEFAULTS, ...options };
  const iconTexture = options.iconTexture === undefined ? defaultIconTexture : options.iconTexture;
  const S = opt.scale;

  const group = new THREE.Group();
  group.name = page.name;
  const byId = new Map(page.cells.map((c) => [c.id, c]));
  const verts = page.cells.filter((c) => c.bounds && !isHiddenLayerChild(c, byId));
  const edges = page.cells.filter((c) => c.edge && !isHiddenLayerChild(c, byId));

  // Centro del diagrama → origen.
  const bb = unionRect(verts.map((c) => c.bounds!));
  const cx = bb ? bb.x + bb.width / 2 : 0;
  const cy = bb ? bb.y + bb.height / 2 : 0;
  const X = (x: number) => (x - cx) / S;
  const Z = (y: number) => (y - cy) / S;

  // "Tarjeta": contenedor que solo envuelve un icono/bloque (más textos). Sus hijos se apoyan
  // directamente sobre ella en vez de subir un nivel completo.
  const children = new Map<string, DrawioCell[]>();
  for (const c of verts) if (c.container) children.set(c.container, [...(children.get(c.container) ?? []), c]);
  const isCard = (id: string) => {
    const kids = children.get(id) ?? [];
    return kids.every((k) => !k.isContainer) && kids.filter((k) => !isTextCell(k)).length <= 2;
  };
  const yCache = new Map<string, number>();
  const baseY = (c: DrawioCell, guard = 0): number => {
    if (!c.container || guard > 64) return 0;
    const hit = yCache.get(c.id);
    if (hit !== undefined) return hit;
    const parent = byId.get(c.container);
    const y = parent ? baseY(parent, guard + 1) + SLAB + (isCard(parent.id) ? 0 : opt.levelGap) : 0;
    yCache.set(c.id, y);
    return y;
  };
  const stats: DrawioPageStats = { vertices: 0, edges: 0, containers: 0, images: 0, labels: 0, maxDepth: 0 };
  /** Altura a la que se conectan las aristas con cada vértice. */
  const anchorY = new Map<string, number>();

  // Orden de dibujo: primero contenedores (por profundidad), luego el resto.
  /** Líneas verticales tenues que unen un elemento elevado con la losa de su contenedor. */
  const addRisers = (node: THREE.Object3D, c: DrawioCell, corners: [number, number][], col: THREE.Color) => {
    const parent = c.container ? byId.get(c.container) : undefined;
    if (!parent) return;
    const drop = baseY(c) - (baseY(parent) + SLAB);
    if (drop < 0.05) return;
    const pts: THREE.Vector3[] = [];
    for (const [x, z] of corners) pts.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, -drop, z));
    const risers = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: col, dashSize: 0.06, gapSize: 0.06, transparent: true, opacity: 0.45 }),
    );
    risers.computeLineDistances();
    node.add(risers);
  };

  const ordered = [...verts].sort((a, b) => Number(b.isContainer) - Number(a.isContainer) || a.depth - b.depth);

  for (const c of ordered) {
    const r = c.bounds!;
    const y0 = baseY(c);
    const w = Math.max(r.width / S, 0.001);
    const d = Math.max(r.height / S, 0.001);
    const px = X(r.x + r.width / 2);
    const pz = Z(r.y + r.height / 2);
    stats.vertices++;
    stats.maxDepth = Math.max(stats.maxDepth, c.depth);

    const fill = color(c.style.fillColor, '#ffffff');
    const stroke = color(c.style.strokeColor, '#000000');
    const node = new THREE.Group();
    node.name = c.label || c.id;
    node.position.set(px, y0, pz);
    group.add(node);

    if (isImageCell(c)) {
      stats.images++;
      const src = c.style.image;
      const tex = src && iconTexture ? iconTexture(src) : null;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      if (tex && !tex.userData.loaded) {
        mat.visible = false;
        (tex.userData.ready as Promise<void> | undefined)?.then(() => (mat.visible = !tex.userData.failed));
      }
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(w, d, 1);
      sprite.position.y = d / 2 + 0.02;
      // Los translúcidos se ordenan por distancia; forzamos iconos después de las losas.
      sprite.renderOrder = 1000 + c.depth;
      sprite.userData.cell = info(c, 'image');
      node.add(sprite);
      // Huella en el piso para leer la posición desde arriba.
      const pad = new THREE.Mesh(
        new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x8a94a6, transparent: true, opacity: 0.18, depthWrite: false }),
      );
      pad.position.y = 0.002;
      pad.renderOrder = 500 + c.depth;
      node.add(pad);
      anchorY.set(c.id, y0 + d / 2 + 0.02);
      addRisers(node, c, [[0, 0]], stroke);
      if (opt.labels && c.label) stats.labels += addLabel(node, c, new THREE.Vector3(0, 0, d / 2), [0.5, 0]);
      continue;
    }

    if (isTextCell(c)) {
      anchorY.set(c.id, y0);
      if (opt.labels && c.label) {
        const [ax, az, cxn, cyn] = anchorFor(c, w, d);
        stats.labels += addLabel(node, c, new THREE.Vector3(ax, 0.01, az), [cxn, cyn], labelWidth(c));
      }
      continue;
    }

    const noFill = c.style.fillColor === 'none' || (c.style.fillColor === undefined && c.baseStyle === 'group');
    const dashed = c.style.dashed === '1';

    if (c.isContainer) {
      stats.containers++;
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(w, SLAB, d),
        new THREE.MeshStandardMaterial({
          color: noFill ? stroke : fill,
          transparent: true,
          opacity: noFill ? 0.07 : 0.55,
          depthWrite: false,
          roughness: 0.9,
        }),
      );
      slab.position.y = SLAB / 2;
      slab.renderOrder = c.depth;
      slab.userData.cell = info(c, 'container');
      node.add(slab);
      if (c.style.strokeColor !== 'none') node.add(outline(w, d, SLAB + 0.002, stroke, dashed));
      anchorY.set(c.id, y0 + SLAB);
      addRisers(node, c, [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]], stroke);
    } else {
      const h = opt.blockHeight;
      const isEllipse = c.baseStyle === 'ellipse' || c.style.shape === 'ellipse';
      const geo = isEllipse ? new THREE.CylinderGeometry(0.5, 0.5, h, 40).scale(w, 1, d) : new THREE.BoxGeometry(w, h, d);
      if (!noFill) {
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: fill, roughness: 0.7, metalness: 0.05 }));
        mesh.position.y = h / 2;
        mesh.userData.cell = info(c, 'block');
        node.add(mesh);
      } else {
        // Sin relleno: caja invisible para poder seleccionarla.
        const pick = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false }));
        pick.position.y = h / 2;
        pick.userData.cell = info(c, 'block');
        node.add(pick);
      }
      if (c.style.strokeColor !== 'none' && !isEllipse) node.add(outline(w, d, noFill ? 0.004 : h + 0.002, stroke, dashed));
      anchorY.set(c.id, y0 + h / 2);
      addRisers(node, c, [[0, 0]], stroke);
    }

    if (opt.labels && c.label) {
      const [ax, az, cxn, cyn] = anchorFor(c, w, d);
      const top = c.isContainer ? SLAB + 0.01 : opt.blockHeight + 0.01;
      stats.labels += addLabel(node, c, new THREE.Vector3(ax, top, az), [cxn, cyn], labelWidth(c));
    }
  }

  // --- Aristas ---
  for (const e of edges) {
    const path2d = edgePath(e, byId);
    if (!path2d || path2d.length < 2) continue;
    stats.edges++;
    const ys = byId.get(e.source ?? '') ? anchorY.get(e.source!) ?? 0 : anchorY.get(e.target ?? '') ?? 0;
    const yt = byId.get(e.target ?? '') ? anchorY.get(e.target!) ?? ys : ys;
    const pts = liftPath(path2d, ys, yt).map((p) => new THREE.Vector3(X(p.x), p.y, Z(p.z)));

    const stroke = color(e.style.strokeColor, '#000000');
    const width = Math.max(1.5, Number(e.style.strokeWidth ?? 1) * 1.2);
    const geo = new LineGeometry();
    geo.setPositions(pts.flatMap((p) => [p.x, p.y, p.z]));
    const mat = new LineMaterial({
      color: stroke,
      linewidth: width,
      dashed: e.style.dashed === '1',
      dashSize: 0.12,
      gapSize: 0.08,
      worldUnits: false,
    });
    const line = new Line2(geo, mat);
    line.computeLineDistances();
    line.userData.cell = info(e, 'edge');
    line.userData.isEdge = true;
    group.add(line);

    const arrowSize = 0.06 + width * 0.01;
    const endArrow = e.style.endArrow ?? 'classic';
    if (endArrow !== 'none') group.add(arrow(pts[pts.length - 2], pts[pts.length - 1], stroke, arrowSize, e));
    if (e.style.startArrow && e.style.startArrow !== 'none') group.add(arrow(pts[1], pts[0], stroke, arrowSize, e));

    if (opt.labels) {
      if (e.label) stats.labels += addEdgeLabel(group, e, pointAlong(pts, 0.5));
      // Etiquetas hijas de la arista (vértices con geometría relativa).
      for (const child of page.cells) {
        if (child.parent === e.id && child.vertex && child.label) {
          const t = THREE.MathUtils.clamp(((child.geometry?.x ?? 0) + 1) / 2, 0, 1);
          stats.labels += addEdgeLabel(group, child, pointAlong(pts, t));
        }
      }
    }
  }

  group.userData = { kind: 'drawio-page', pageName: page.name, stats };
  return group;
}

// ---------------------------------------------------------------------------------------------
// Geometría de aristas (en coordenadas de draw.io)

/** Recorrido 2D de una arista: puerto de salida → waypoints → puerto de entrada. */
export function edgePath(e: DrawioCell, byId: Map<string, DrawioCell>): Point[] | null {
  const src = e.source ? byId.get(e.source) : undefined;
  const tgt = e.target ? byId.get(e.target) : undefined;
  const g = e.geometry;
  const parent = e.parent ? byId.get(e.parent) : undefined;
  const off = parent?.bounds ? { x: parent.bounds.x, y: parent.bounds.y } : { x: 0, y: 0 };
  const waypoints = (g?.points ?? []).map((p) => ({ x: p.x + off.x, y: p.y + off.y }));

  const port = (c: DrawioCell | undefined, kx?: string, ky?: string, dx?: string, dy?: string): Point | null => {
    if (!c?.bounds || kx === undefined || ky === undefined) return null;
    const r = c.bounds;
    return { x: r.x + Number(kx) * r.width + Number(dx ?? 0), y: r.y + Number(ky) * r.height + Number(dy ?? 0) };
  };
  const s = e.style;
  const sPort = port(src, s.exitX, s.exitY, s.exitDx, s.exitDy);
  const tPort = port(tgt, s.entryX, s.entryY, s.entryDx, s.entryDy);

  const start = sPort ?? (src?.bounds ? center(src.bounds) : g?.sourcePoint ? add(g.sourcePoint, off) : null);
  const end = tPort ?? (tgt?.bounds ? center(tgt.bounds) : g?.targetPoint ? add(g.targetPoint, off) : null);
  if (!start || !end) return null;

  const orthogonal = /orthogonal|elbow|entityRelation/i.test(s.edgeStyle ?? '');
  let pts: Point[] = [start, ...waypoints, end];

  if (orthogonal) {
    if (waypoints.length === 0) {
      const firstH = sPort ? isHorizontalSide(s.exitX, s.exitY) : Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
      const lastH = tPort ? isHorizontalSide(s.entryX, s.entryY) : firstH;
      pts = elbowRoute(start, end, firstH, lastH);
    } else {
      pts = orthogonalize(pts, sPort ? isHorizontalSide(s.exitX, s.exitY) : undefined);
    }
  }

  // Si el extremo es el centro del nodo, recortarlo al borde del rectángulo.
  if (!sPort && src?.bounds) pts[0] = clipToRect(pts[0], pts[1], src.bounds);
  if (!tPort && tgt?.bounds) pts[pts.length - 1] = clipToRect(pts[pts.length - 1], pts[pts.length - 2], tgt.bounds);
  return dedupe(pts);
}

/** Un puerto en el lado izquierdo/derecho sale en horizontal; arriba/abajo, en vertical. */
function isHorizontalSide(kx?: string, ky?: string): boolean {
  const x = Number(kx);
  const y = Number(ky);
  const dx = Math.min(x, 1 - x);
  const dy = Math.min(y, 1 - y);
  return dx <= dy;
}

function elbowRoute(a: Point, b: Point, firstH: boolean, lastH: boolean): Point[] {
  if (firstH && lastH) {
    const mx = (a.x + b.x) / 2;
    return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
  }
  if (!firstH && !lastH) {
    const my = (a.y + b.y) / 2;
    return [a, { x: a.x, y: my }, { x: b.x, y: my }, b];
  }
  return firstH ? [a, { x: b.x, y: a.y }, b] : [a, { x: a.x, y: b.y }, b];
}

/** Inserta codos entre puntos consecutivos que no estén alineados en un eje. */
function orthogonalize(pts: Point[], firstH?: boolean): Point[] {
  const out: Point[] = [pts[0]];
  let horizontal = firstH ?? Math.abs(pts[1].x - pts[0].x) >= Math.abs(pts[1].y - pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const aligned = Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5;
    if (!aligned) {
      // codo: tramo en `horizontal` y luego el contrario; el siguiente vuelve a `horizontal`
      out.push(horizontal ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
    } else {
      // tramo recto: el siguiente codo va en la dirección perpendicular
      horizontal = !(Math.abs(a.y - b.y) < 0.5);
    }
    out.push(b);
  }
  return out;
}

function clipToRect(from: Point, toward: Point, r: Rect): Point {
  const c = center(r);
  if (Math.abs(from.x - c.x) > 0.5 || Math.abs(from.y - c.y) > 0.5) return from;
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return from;
  const tx = dx !== 0 ? r.width / 2 / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? r.height / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** Interpola la altura a lo largo del recorrido, de la altura del origen a la del destino. */
function liftPath(pts: Point[], y0: number, y1: number): { x: number; y: number; z: number }[] {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = lens[lens.length - 1] || 1;
  return pts.map((p, i) => ({ x: p.x, y: y0 + (y1 - y0) * (lens[i] / total), z: p.y }));
}

function pointAlong(pts: THREE.Vector3[], t: number): THREE.Vector3 {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const target = lens[lens.length - 1] * t;
  for (let i = 1; i < pts.length; i++) {
    if (lens[i] >= target) {
      const k = (target - lens[i - 1]) / (lens[i] - lens[i - 1] || 1);
      return pts[i - 1].clone().lerp(pts[i], k);
    }
  }
  return pts[pts.length - 1].clone();
}

// ---------------------------------------------------------------------------------------------
// Helpers de objetos 3D

function outline(w: number, d: number, y: number, col: THREE.Color, dashed: boolean): THREE.Line {
  const hw = w / 2;
  const hd = d / 2;
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-hw, y, -hd),
    new THREE.Vector3(hw, y, -hd),
    new THREE.Vector3(hw, y, hd),
    new THREE.Vector3(-hw, y, hd),
    new THREE.Vector3(-hw, y, -hd),
  ]);
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color: col, dashSize: 0.08, gapSize: 0.05 })
    : new THREE.LineBasicMaterial({ color: col });
  const line = new THREE.Line(geo, mat);
  if (dashed) line.computeLineDistances();
  return line;
}

function arrow(from: THREE.Vector3, to: THREE.Vector3, col: THREE.Color, size: number, e: DrawioCell): THREE.Mesh {
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(size * 0.55, size * 1.4, 16),
    new THREE.MeshBasicMaterial({ color: col }),
  );
  const dir = to.clone().sub(from).normalize();
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  cone.position.copy(to).addScaledVector(dir, -size * 0.7);
  cone.userData.cell = info(e, 'edge');
  return cone;
}

/** Punto de anclaje de la etiqueta según align/verticalAlign + `center` del CSS2DObject. */
function anchorFor(c: DrawioCell, w: number, d: number): [number, number, number, number] {
  const align = c.style.align ?? 'center';
  const valign = c.style.verticalAlign ?? 'middle';
  const sl = Number(c.style.spacingLeft ?? 0) / 100;
  const st = Number(c.style.spacingTop ?? 0) / 100;
  const ax = align === 'left' ? -w / 2 + 0.04 + sl : align === 'right' ? w / 2 - 0.04 : 0;
  const az = valign === 'top' ? -d / 2 + 0.03 + st : valign === 'bottom' ? d / 2 - 0.03 : 0;
  const cxn = align === 'left' ? 0 : align === 'right' ? 1 : 0.5;
  const cyn = valign === 'top' ? 0 : valign === 'bottom' ? 1 : 0.5;
  return [ax, az, cxn, cyn];
}

function addLabel(
  parent: THREE.Object3D,
  c: DrawioCell,
  pos: THREE.Vector3,
  center: [number, number],
  wrapWidthPx?: number,
): number {
  const el = labelElement(c);
  if (wrapWidthPx && c.style.whiteSpace === 'wrap') {
    // Igual que draw.io: el texto se ajusta al ancho de la celda (escala con --label-scale).
    el.classList.add('wrap');
    el.style.setProperty('--w', String(Math.max(wrapWidthPx, 10)));
  }
  const obj = new CSS2DObject(el);
  obj.position.copy(pos);
  obj.center.set(center[0], center[1]);
  obj.userData.isLabel = true;
  parent.add(obj);
  return 1;
}

function addEdgeLabel(parent: THREE.Object3D, c: DrawioCell, pos: THREE.Vector3): number {
  const el = labelElement(c);
  el.classList.add('edge');
  const bg = c.style.labelBackgroundColor;
  if (bg && bg !== 'none') el.style.background = bg;
  const obj = new CSS2DObject(el);
  obj.position.copy(pos);
  obj.userData.isLabel = true;
  parent.add(obj);
  return 1;
}

/** Ancho disponible para el texto (px de draw.io) descontando los márgenes del estilo. */
function labelWidth(c: DrawioCell): number {
  const sp = Number(c.style.spacing ?? 2);
  const sl = Number(c.style.spacingLeft ?? 0);
  const sr = Number(c.style.spacingRight ?? 0);
  return (c.bounds?.width ?? 0) - 2 * sp - sl - sr;
}

function labelElement(c: DrawioCell): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'drawio-label';
  el.textContent = c.label;
  const fs = Number(c.style.fontSize ?? 12);
  el.style.setProperty('--fs', String(fs));
  if (c.style.fontColor && c.style.fontColor !== 'none') el.style.color = c.style.fontColor;
  const fstyle = Number(c.style.fontStyle ?? 0);
  if (fstyle & 1) el.style.fontWeight = '600';
  if (fstyle & 2) el.style.fontStyle = 'italic';
  if (c.style.align) el.style.textAlign = c.style.align;
  return el;
}

function info(c: DrawioCell, kind: CellInfo['kind']): CellInfo {
  const style: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.style)) style[k] = v.length > 80 ? `${v.slice(0, 77)}…` : v;
  return {
    id: c.id,
    kind,
    label: c.label,
    depth: c.depth,
    container: c.container,
    source: c.source,
    target: c.target,
    style,
    attributes: c.attributes,
  };
}

// ---------------------------------------------------------------------------------------------
// Utilidades

function color(value: string | undefined, fallback: string): THREE.Color {
  if (!value || value === 'none' || value === 'default') return new THREE.Color(fallback);
  try {
    return new THREE.Color(value.length === 9 && value.startsWith('#') ? value.slice(0, 7) : value);
  } catch {
    return new THREE.Color(fallback);
  }
}

function isHiddenLayerChild(c: DrawioCell, byId: Map<string, DrawioCell>): boolean {
  if (!c.visible) return true;
  let p = c.parent ? byId.get(c.parent) : undefined;
  let guard = 0;
  while (p && guard++ < 64) {
    if (!p.visible) return true;
    p = p.parent ? byId.get(p.parent) : undefined;
  }
  return false;
}

function unionRect(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });

function dedupe(pts: Point[]): Point[] {
  return pts.filter((p, i) => i === 0 || Math.abs(p.x - pts[i - 1].x) > 0.01 || Math.abs(p.y - pts[i - 1].y) > 0.01);
}
