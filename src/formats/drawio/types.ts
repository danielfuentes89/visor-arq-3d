/** Modelo intermedio de un archivo draw.io (mxGraph), independiente de three.js. */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawioGeometry extends Rect {
  /** En aristas y etiquetas de arista, x/y son relativos al trazo. */
  relative: boolean;
  /** Waypoints de una arista (coordenadas relativas al padre). */
  points: Point[];
  sourcePoint?: Point;
  targetPoint?: Point;
}

export type DrawioStyle = Record<string, string>;

export interface DrawioCell {
  id: string;
  parent?: string;
  /** Valor original (puede ser HTML cuando style.html=1). */
  value: string;
  /** Texto plano legible derivado de `value`. */
  label: string;
  styleRaw: string;
  style: DrawioStyle;
  /** Primer token sin "=" del estilo (p.ej. "text", "ellipse", "swimlane"). */
  baseStyle?: string;
  vertex: boolean;
  edge: boolean;
  /** false si la celda (o su capa) tiene visible="0". */
  visible: boolean;
  source?: string;
  target?: string;
  geometry?: DrawioGeometry;
  /** Atributos extra de <object>/<UserObject> (metadatos del usuario). */
  attributes: Record<string, string>;

  // --- Campos calculados por resolveHierarchy() ---
  /** Bounds absolutos en el lienzo (solo vértices no relativos). */
  bounds?: Rect;
  /** Contenedor (real por `parent` o inferido por contención geométrica). */
  container?: string;
  /** Nivel de anidación: 0 = raíz. */
  depth: number;
  /** true si al menos otro vértice queda dentro de este. */
  isContainer: boolean;
}

export interface DrawioPage {
  id: string;
  name: string;
  cells: DrawioCell[];
  pageWidth?: number;
  pageHeight?: number;
}

export interface DrawioDocument {
  pages: DrawioPage[];
}
