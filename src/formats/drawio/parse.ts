import type { DrawioCell, DrawioDocument, DrawioGeometry, DrawioPage, DrawioStyle, Point } from './types';
import { resolveHierarchy } from './hierarchy';

/**
 * Parsea el XML de un archivo .drawio (<mxfile> con una o varias páginas) o un <mxGraphModel> suelto.
 * Soporta páginas comprimidas (base64 + deflate-raw + encodeURIComponent).
 * No soporta (aún) PNG/SVG exportados con el diagrama embebido.
 */
export async function parseDrawio(xml: string): Promise<DrawioDocument> {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`XML drawio inválido: ${err.textContent?.slice(0, 200)}`);

  const rootEl = doc.documentElement;
  const pages: DrawioPage[] = [];

  if (rootEl.nodeName === 'mxGraphModel') {
    pages.push(parseModel(rootEl, 'page-1', 'Página 1'));
  } else if (rootEl.nodeName === 'mxfile') {
    const diagrams = Array.from(rootEl.getElementsByTagName('diagram'));
    for (let i = 0; i < diagrams.length; i++) {
      const d = diagrams[i];
      const id = d.getAttribute('id') ?? `page-${i + 1}`;
      const name = d.getAttribute('name') ?? `Página ${i + 1}`;
      let model = firstChildElement(d, 'mxGraphModel');
      if (!model) {
        const text = (d.textContent ?? '').trim();
        if (!text) continue;
        const inner = await decompressDiagram(text);
        const innerDoc = new DOMParser().parseFromString(inner, 'application/xml');
        model = innerDoc.documentElement;
        if (model.nodeName !== 'mxGraphModel') throw new Error(`Página "${name}": contenido comprimido inesperado`);
      }
      pages.push(parseModel(model, id, name));
    }
  } else {
    throw new Error(`Raíz XML no reconocida: <${rootEl.nodeName}> (se esperaba <mxfile> o <mxGraphModel>)`);
  }

  for (const p of pages) resolveHierarchy(p.cells);
  return { pages };
}

/** draw.io comprime cada página como base64( deflateRaw( encodeURIComponent(xml) ) ). */
export async function decompressDiagram(base64: string): Promise<string> {
  const bin = atob(base64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('deflate-raw'));
  const text = await new Response(stream).text();
  try {
    return decodeURIComponent(text);
  } catch {
    return text; // algunas versiones no aplican encodeURIComponent
  }
}

function parseModel(model: Element, id: string, name: string): DrawioPage {
  const root = firstChildElement(model, 'root');
  const cells: DrawioCell[] = [];
  if (root) {
    for (const el of Array.from(root.children)) {
      const cell = parseCellElement(el);
      if (cell) cells.push(cell);
    }
  }
  const num = (a: string) => {
    const v = model.getAttribute(a);
    return v == null ? undefined : Number(v);
  };
  return { id, name, cells, pageWidth: num('pageWidth'), pageHeight: num('pageHeight') };
}

/** Acepta <mxCell> o los envoltorios <object>/<UserObject> que guardan metadatos. */
function parseCellElement(el: Element): DrawioCell | null {
  let cellEl: Element | null = el;
  const attributes: Record<string, string> = {};
  let id = el.getAttribute('id') ?? '';
  let value: string;

  if (el.nodeName === 'object' || el.nodeName === 'UserObject') {
    cellEl = firstChildElement(el, 'mxCell');
    for (const a of Array.from(el.attributes)) {
      if (a.name !== 'id' && a.name !== 'label') attributes[a.name] = a.value;
    }
    value = el.getAttribute('label') ?? '';
    if (!cellEl) return null;
  } else if (el.nodeName === 'mxCell') {
    value = el.getAttribute('value') ?? '';
  } else {
    return null;
  }
  if (!id) id = cellEl.getAttribute('id') ?? '';

  const styleRaw = cellEl.getAttribute('style') ?? '';
  const { style, baseStyle } = parseStyle(styleRaw);
  const geoEl = firstChildElement(cellEl, 'mxGeometry');

  return {
    id,
    parent: cellEl.getAttribute('parent') ?? undefined,
    value,
    label: htmlToText(value, style.html === '1'),
    styleRaw,
    style,
    baseStyle,
    vertex: cellEl.getAttribute('vertex') === '1',
    edge: cellEl.getAttribute('edge') === '1',
    visible: cellEl.getAttribute('visible') !== '0',
    source: cellEl.getAttribute('source') ?? undefined,
    target: cellEl.getAttribute('target') ?? undefined,
    geometry: geoEl ? parseGeometry(geoEl) : undefined,
    attributes,
    depth: 0,
    isContainer: false,
  };
}

function parseGeometry(el: Element): DrawioGeometry {
  const n = (a: string) => Number(el.getAttribute(a) ?? 0) || 0;
  const geo: DrawioGeometry = {
    x: n('x'),
    y: n('y'),
    width: n('width'),
    height: n('height'),
    relative: el.getAttribute('relative') === '1',
    points: [],
  };
  for (const child of Array.from(el.children)) {
    const as = child.getAttribute('as');
    if (child.nodeName === 'Array' && as === 'points') {
      geo.points = Array.from(child.children).filter((c) => c.nodeName === 'mxPoint').map(readPoint);
    } else if (child.nodeName === 'mxPoint' && as === 'sourcePoint') {
      geo.sourcePoint = readPoint(child);
    } else if (child.nodeName === 'mxPoint' && as === 'targetPoint') {
      geo.targetPoint = readPoint(child);
    }
  }
  return geo;
}

function readPoint(el: Element): Point {
  return { x: Number(el.getAttribute('x') ?? 0) || 0, y: Number(el.getAttribute('y') ?? 0) || 0 };
}

/** "rounded=0;fillColor=#fff;text;" → { rounded: '0', fillColor: '#fff' } + baseStyle 'text'. */
export function parseStyle(raw: string): { style: DrawioStyle; baseStyle?: string } {
  const style: DrawioStyle = {};
  let baseStyle: string | undefined;
  for (const part of raw.split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) {
      if (baseStyle === undefined) baseStyle = part.trim();
      continue;
    }
    style[part.slice(0, eq).trim()] = part.slice(eq + 1);
  }
  return { style, baseStyle };
}

/** Convierte el label HTML de draw.io a texto plano conservando saltos de línea. */
export function htmlToText(value: string, isHtml: boolean): string {
  if (!value) return '';
  if (!isHtml) return value.trim();
  const withBreaks = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|h\d)>/gi, '\n');
  const text = new DOMParser().parseFromString(`<body>${withBreaks}</body>`, 'text/html').body.textContent ?? '';
  return text
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]))
    .join('\n')
    .trim();
}

function firstChildElement(el: Element, name: string): Element | null {
  for (const c of Array.from(el.children)) if (c.nodeName === name) return c;
  return null;
}
