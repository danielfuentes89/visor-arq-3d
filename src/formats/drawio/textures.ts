import * as THREE from 'three';

/**
 * draw.io guarda las imágenes embebidas como `data:image/svg+xml,<base64>` sin el marcador
 * `;base64` (porque `;` separa claves en el estilo). Los navegadores no lo decodifican así,
 * de modo que lo normalizamos.
 */
export function normalizeDataUri(src: string): string {
  const m = /^data:([^;,]+)(;[^,]*)?,(.*)$/s.exec(src);
  if (!m) return src;
  const [, mime, params = '', payload] = m;
  if (params.includes('base64')) return src;
  const looksBase64 = /^[A-Za-z0-9+/=\s]+$/.test(payload) && !payload.startsWith('%3C');
  return looksBase64 ? `data:${mime};base64,${payload.replace(/\s+/g, '')}` : src;
}

export type IconTextureProvider = (src: string) => THREE.Texture | null;

const cache = new Map<string, THREE.Texture>();
const MAX_SIDE = 256;

/**
 * Rasteriza la imagen (SVG o bitmap) a un canvas para que siempre tenga tamaño intrínseco,
 * incluso SVGs que solo declaran viewBox. Cachea por URI: un mismo icono se sube una sola vez a la GPU.
 * `texture.userData.ready` es una promesa que resuelve cuando la imagen está lista.
 */
export const defaultIconTexture: IconTextureProvider = (src) => {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const key = normalizeDataUri(src);
  const hit = cache.get(key);
  if (hit) return hit;

  const texture = new THREE.Texture();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.userData.ready = new Promise<void>((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const w = img.naturalWidth || 64;
      const h = img.naturalHeight || 64;
      const k = MAX_SIDE / Math.max(w, h);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * k));
      canvas.height = Math.max(1, Math.round(h * k));
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      texture.image = canvas;
      texture.needsUpdate = true;
      texture.userData.aspect = canvas.width / canvas.height;
      texture.userData.loaded = true;
      resolve();
    };
    img.onerror = () => {
      texture.userData.failed = true;
      resolve();
    };
    img.src = key;
  });
  cache.set(key, texture);
  return texture;
};
