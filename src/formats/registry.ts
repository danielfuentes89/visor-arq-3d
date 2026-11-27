import type * as THREE from 'three';

/** Una "vista" seleccionable de lo cargado: una página de un diagrama, o el modelo completo. */
export interface LoadedView {
  name: string;
  object: THREE.Object3D;
}

export interface LoadedModel {
  /** 'diagram' = se reconstruye con opciones del visor (niveles, etiquetas); 'model' = malla 3D. */
  kind: 'diagram' | 'model';
  views: LoadedView[];
  /** Reconstruir las vistas con otras opciones (solo diagramas). */
  rebuild?: (options: Record<string, unknown>) => LoadedView[];
}

/**
 * Adaptador de formato. Para soportar un formato nuevo basta con implementar esto y
 * registrarlo: `registry.register(miAdapter)`.
 */
export interface FormatAdapter {
  id: string;
  /** Nombre legible para la UI. */
  name: string;
  /** Extensiones en minúscula, sin punto. */
  extensions: string[];
  /** Detección opcional por contenido cuando la extensión es ambigua (p.ej. .xml). */
  sniff?: (head: string) => boolean;
  load(file: File, options?: Record<string, unknown>): Promise<LoadedModel>;
}

export class FormatRegistry {
  private adapters: FormatAdapter[] = [];

  register(adapter: FormatAdapter): this {
    this.adapters = this.adapters.filter((a) => a.id !== adapter.id);
    this.adapters.push(adapter);
    return this;
  }

  list(): readonly FormatAdapter[] {
    return this.adapters;
  }

  /** Atributo `accept` para <input type=file>. */
  accept(): string {
    return this.adapters.flatMap((a) => a.extensions.map((e) => `.${e}`)).join(',');
  }

  async resolve(file: File): Promise<FormatAdapter | undefined> {
    const ext = extensionOf(file.name);
    const byExt = this.adapters.filter((a) => a.extensions.includes(ext));
    if (byExt.length === 1) return byExt[0];
    const head = await blobText(file.slice(0, 2048));
    return (byExt.length ? byExt : this.adapters).find((a) => a.sniff?.(head)) ?? byExt[0];
  }

  async load(file: File, options?: Record<string, unknown>): Promise<LoadedModel> {
    const adapter = await this.resolve(file);
    if (!adapter) {
      throw new Error(`Formato no soportado: "${file.name}". Soportados: ${this.accept()}`);
    }
    return adapter.load(file, options);
  }
}

export function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.drawio.xml')) return 'drawio';
  const i = lower.lastIndexOf('.');
  return i >= 0 ? lower.slice(i + 1) : '';
}

/** Blob.text() con respaldo en FileReader (entornos sin Blob.text, como jsdom). */
export function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(blob);
  });
}
