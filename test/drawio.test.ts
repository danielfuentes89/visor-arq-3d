import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { parseDrawio, parseStyle, htmlToText } from '../src/formats/drawio/parse';
import { buildDrawioPage, edgePath, type DrawioPageStats } from '../src/formats/drawio/build3d';
import { normalizeDataUri } from '../src/formats/drawio/textures';
import { createDefaultRegistry } from '../src/formats/adapters';
import { extensionOf } from '../src/formats/registry';

const sample = readFileSync(resolve('public/samples/ejemplo-arquitectura.drawio'), 'utf8');
const compressed = readFileSync(resolve('test/fixtures/ejemplo-comprimido.drawio'), 'utf8');

describe('parseStyle / htmlToText', () => {
  it('separa estilo base y claves', () => {
    const { style, baseStyle } = parseStyle('text;html=1;fillColor=#fff;image=data:image/svg+xml,AAA=;');
    expect(baseStyle).toBe('text');
    expect(style.fillColor).toBe('#fff');
    expect(style.image).toBe('data:image/svg+xml,AAA=');
  });

  it('convierte labels HTML a texto con saltos de línea', () => {
    expect(htmlToText('<b>Glue</b><br>Data&nbsp;Catalog', true)).toBe('Glue\nData Catalog');
    expect(htmlToText('Agente<div><br/></div>', true)).toBe('Agente');
    expect(htmlToText('  plano  ', false)).toBe('plano');
  });
});

describe('parseDrawio', () => {
  it('lee páginas, vértices y aristas', async () => {
    const doc = await parseDrawio(sample);
    expect(doc.pages.map((p) => p.name)).toEqual(['Arquitectura', 'Grupos']);
    const p1 = doc.pages[0];
    expect(p1.cells.filter((c) => c.vertex)).toHaveLength(23);
    expect(p1.cells.filter((c) => c.edge)).toHaveLength(9);
    const e2 = p1.cells.find((c) => c.id === 'e2')!;
    expect(e2.geometry?.points).toEqual([{ x: 300, y: 324 }, { x: 300, y: 204 }]);
  });

  it('descomprime páginas comprimidas igual que las planas', async () => {
    const a = await parseDrawio(sample);
    const b = await parseDrawio(compressed);
    expect(b.pages.map((p) => p.cells.length)).toEqual(a.pages.map((p) => p.cells.length));
    expect(b.pages[0].cells.find((c) => c.id === 'orq')?.label).toBe('Orquestador');
  });

  it('infiere contenedores por contención geométrica en diagramas planos', async () => {
    const [p1] = (await parseDrawio(sample)).pages;
    const get = (id: string) => p1.cells.find((c) => c.id === id)!;
    expect(get('cloud').depth).toBe(0);
    expect(get('core').container).toBe('cloud');
    expect(get('agents').container).toBe('core');
    expect(get('ag1').container).toBe('agents');
    expect(get('ag1').depth).toBe(3);
    expect(get('u1').container).toBe('users');
    expect(get('cloud').isContainer).toBe(true);
    expect(get('ag1').isContainer).toBe(false);
  });

  it('respeta la anidación real con geometría relativa al padre', async () => {
    const p2 = (await parseDrawio(sample)).pages[1];
    const child = p2.cells.find((c) => c.id === 'gchild')!;
    expect(child.bounds).toEqual({ x: 200, y: 180, width: 100, height: 60 });
    expect(child.container).toBe('g');
    expect(p2.cells.find((c) => c.id === 'hv')!.visible).toBe(true);
    expect(p2.cells.find((c) => c.id === 'hidden')!.visible).toBe(false);
  });

  it('rechaza XML que no es drawio', async () => {
    await expect(parseDrawio('<svg/>')).rejects.toThrow(/no reconocida/);
  });
});

describe('edgePath', () => {
  it('usa puertos exit/entry, waypoints y codos ortogonales', async () => {
    const [p1] = (await parseDrawio(sample)).pages;
    const byId = new Map(p1.cells.map((c) => [c.id, c]));
    const path = edgePath(byId.get('e2')!, byId)!;
    // ch (126,300,48,48) exitX=1 → (174,324); waf (411,180) entryX=0 → (411,204)
    expect(path[0]).toEqual({ x: 174, y: 324 });
    expect(path[path.length - 1]).toEqual({ x: 411, y: 204 });
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it('recorta al borde del nodo cuando no hay puertos', async () => {
    const [p1] = (await parseDrawio(sample)).pages;
    const byId = new Map(p1.cells.map((c) => [c.id, c]));
    const path = edgePath(byId.get('e4')!, byId)!;
    // api (411,320,48,48) → orq (590,180,160,60): sale por la derecha del icono, entra por la izquierda del bloque
    expect(path[0]).toEqual({ x: 459, y: 344 });
    expect(path[path.length - 1]).toEqual({ x: 590, y: 210 });
  });
});

describe('buildDrawioPage', () => {
  it('genera objetos 3D con niveles y estadísticas', async () => {
    const [p1, p2] = (await parseDrawio(sample)).pages;
    const g = buildDrawioPage(p1, { iconTexture: null, levelGap: 1 });
    const s = g.userData.stats as DrawioPageStats;
    expect(s.edges).toBe(9);
    expect(s.images).toBe(7);
    expect(s.containers).toBe(5);
    expect(s.maxDepth).toBe(3);

    const nodeOf = (id: string) => {
      let found: THREE.Object3D | undefined;
      g.traverse((o) => {
        if (!found && o.userData.cell?.id === id) found = o.parent!;
      });
      return found!;
    };
    expect(nodeOf('cloud').position.y).toBe(0);
    expect(nodeOf('ag1').position.y).toBeGreaterThan(nodeOf('agents').position.y);

    const flat = buildDrawioPage(p1, { iconTexture: null, levelGap: 0 });
    let maxY = 0;
    flat.traverse((o) => {
      if (o.userData.cell?.kind === 'container') maxY = Math.max(maxY, o.parent!.position.y);
    });
    expect(maxY).toBeLessThan(0.2);

    const g2 = buildDrawioPage(p2, { iconTexture: null });
    expect((g2.userData.stats as DrawioPageStats).vertices).toBe(4); // la capa oculta no se dibuja
  });
});

describe('registro de formatos', () => {
  it('resuelve por extensión y por contenido', async () => {
    const reg = createDefaultRegistry();
    expect(extensionOf('a.drawio.xml')).toBe('drawio');
    expect((await reg.resolve(new File(['x'], 'm.glb')))?.id).toBe('gltf');
    expect((await reg.resolve(new File([sample], 'diagrama.xml')))?.id).toBe('drawio');
    await expect(reg.load(new File(['x'], 'a.xyz'))).rejects.toThrow(/no soportado/);
  });
});

describe('normalizeDataUri', () => {
  it('agrega ;base64 a los data URI de draw.io', () => {
    expect(normalizeDataUri('data:image/svg+xml,PHN2Zz4=')).toBe('data:image/svg+xml;base64,PHN2Zz4=');
    expect(normalizeDataUri('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(normalizeDataUri('data:image/svg+xml,%3Csvg%3E')).toBe('data:image/svg+xml,%3Csvg%3E');
  });
});
