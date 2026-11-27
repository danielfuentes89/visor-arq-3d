import * as THREE from 'three';
import { FormatRegistry, blobText, type FormatAdapter, type LoadedModel } from './registry';
import { parseDrawio } from './drawio/parse';
import { buildDrawioPage, type DrawioBuildOptions } from './drawio/build3d';

/** Adaptador drawio: parsea una vez y reconstruye las páginas cuando cambian las opciones. */
export const drawioAdapter: FormatAdapter = {
  id: 'drawio',
  name: 'draw.io / diagrams.net',
  extensions: ['drawio', 'dio', 'xml'],
  sniff: (head) => /<mxfile|<mxGraphModel/.test(head),
  async load(file, options) {
    const doc = await parseDrawio(await blobText(file));
    const build = (o: Record<string, unknown> = {}) =>
      doc.pages.map((p) => ({ name: p.name, object: buildDrawioPage(p, o as DrawioBuildOptions) }));
    return { kind: 'diagram', views: build(options), rebuild: build };
  },
};

/** Envuelve un objeto 3D cualquiera como modelo de una sola vista. */
const single = (name: string, object: THREE.Object3D): LoadedModel => ({ kind: 'model', views: [{ name, object }] });
const meshFrom = (geo: THREE.BufferGeometry) => {
  geo.computeVertexNormals();
  const mat = geo.hasAttribute('color')
    ? new THREE.MeshStandardMaterial({ vertexColors: true })
    : new THREE.MeshStandardMaterial({ color: 0xb8c2d1, roughness: 0.6 });
  return new THREE.Mesh(geo, mat);
};

/**
 * Adaptadores que reutilizan los loaders oficiales de three.js (examples/jsm/loaders).
 * Se importan bajo demanda para no inflar la carga inicial.
 */
export const threeAdapters: FormatAdapter[] = [
  {
    id: 'gltf',
    name: 'glTF / GLB',
    extensions: ['glb', 'gltf'],
    async load(file) {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), '');
      return single(file.name, gltf.scene);
    },
  },
  {
    id: 'obj',
    name: 'Wavefront OBJ',
    extensions: ['obj'],
    async load(file) {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
      return single(file.name, new OBJLoader().parse(await file.text()));
    },
  },
  {
    id: 'fbx',
    name: 'Autodesk FBX',
    extensions: ['fbx'],
    async load(file) {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      return single(file.name, new FBXLoader().parse(await file.arrayBuffer(), ''));
    },
  },
  {
    id: 'stl',
    name: 'STL',
    extensions: ['stl'],
    async load(file) {
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
      return single(file.name, meshFrom(new STLLoader().parse(await file.arrayBuffer())));
    },
  },
  {
    id: 'ply',
    name: 'PLY',
    extensions: ['ply'],
    async load(file) {
      const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
      return single(file.name, meshFrom(new PLYLoader().parse(await file.arrayBuffer())));
    },
  },
  {
    id: 'dae',
    name: 'Collada',
    extensions: ['dae'],
    async load(file) {
      const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
      const res = new ColladaLoader().parse(await file.text(), '');
      if (!res) throw new Error('Collada inválido');
      return single(file.name, res.scene);
    },
  },
  {
    id: '3mf',
    name: '3MF',
    extensions: ['3mf'],
    async load(file) {
      const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
      return single(file.name, new ThreeMFLoader().parse(await file.arrayBuffer()));
    },
  },
  {
    id: 'svg',
    name: 'SVG (extruido)',
    extensions: ['svg'],
    async load(file) {
      const { SVGLoader } = await import('three/addons/loaders/SVGLoader.js');
      const data = new SVGLoader().parse(await file.text());
      const group = new THREE.Group();
      for (const path of data.paths) {
        const fill = (path.userData?.style as { fill?: string } | undefined)?.fill;
        if (!fill || fill === 'none') continue;
        const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setStyle(fill), side: THREE.DoubleSide });
        for (const shape of SVGLoader.createShapes(path)) {
          group.add(new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 4, bevelEnabled: false }), mat));
        }
      }
      // SVG tiene Y hacia abajo: lo acostamos sobre el plano XZ.
      group.rotation.x = Math.PI / 2;
      return single(file.name, group);
    },
  },
];

export function createDefaultRegistry(): FormatRegistry {
  const registry = new FormatRegistry();
  registry.register(drawioAdapter);
  for (const a of threeAdapters) registry.register(a);
  return registry;
}
