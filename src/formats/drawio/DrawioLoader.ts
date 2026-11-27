import * as THREE from 'three';
import { parseDrawio } from './parse';
import { buildDrawioPage, type DrawioBuildOptions } from './build3d';
import type { DrawioDocument } from './types';

export interface DrawioLoadResult {
  /** Modelo intermedio (para reconstruir con otras opciones sin volver a parsear). */
  document: DrawioDocument;
  /** Un THREE.Group por página, en el mismo orden que `document.pages`. */
  pages: THREE.Group[];
}

/**
 * Loader de draw.io siguiendo el patrón de los loaders de three.js
 * (examples/jsm/loaders/*): `load()` descarga con FileLoader y delega en `parse()`.
 *
 *   const loader = new DrawioLoader();
 *   const { pages } = await loader.loadAsync('arquitectura.drawio');
 *   scene.add(pages[0]);
 */
export class DrawioLoader extends THREE.Loader<DrawioLoadResult> {
  buildOptions: DrawioBuildOptions;

  constructor(manager?: THREE.LoadingManager, buildOptions: DrawioBuildOptions = {}) {
    super(manager);
    this.buildOptions = buildOptions;
  }

  override load(
    url: string,
    onLoad: (data: DrawioLoadResult) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (err: unknown) => void,
  ): void {
    const loader = new THREE.FileLoader(this.manager);
    loader.setPath(this.path);
    loader.setResponseType('text');
    loader.setRequestHeader(this.requestHeader);
    loader.setWithCredentials(this.withCredentials);
    loader.load(
      url,
      (text) => {
        this.parse(text as string).then(onLoad, (e) => {
          if (onError) onError(e);
          else console.error(e);
          this.manager.itemError(url);
        });
      },
      onProgress,
      onError,
    );
  }

  /** A diferencia de la mayoría de loaders, parse es asíncrono (páginas comprimidas usan DecompressionStream). */
  async parse(text: string): Promise<DrawioLoadResult> {
    const document = await parseDrawio(text);
    const pages = document.pages.map((p) => buildDrawioPage(p, this.buildOptions));
    return { document, pages };
  }
}
