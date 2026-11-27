# Visor Arq 3D

Visor 3D de diagramas de arquitectura construido sobre [three.js](https://github.com/mrdoob/three.js) (0.187).
Importa diagramas **draw.io** y los convierte en una escena 3D: los contenedores se apilan por nivel de
anidación, los iconos se muestran como sprites y los conectores respetan puertos y waypoints. También
abre modelos 3D comunes (glTF/GLB, OBJ, FBX, STL, PLY, Collada, 3MF y SVG extruido) con los loaders oficiales de three.js.

El análisis de cómo renderiza three.js y qué formatos soporta está en
[`docs/analisis-threejs.html`](docs/analisis-threejs.html).

## Uso

```bash
npm install
npm run dev      # http://localhost:5173 (carga public/samples/ejemplo-arquitectura.drawio)
npm test         # tests del parser, la jerarquía y el constructor 3D
npm run build    # typecheck + build de producción en dist/
```

En el visor: **Abrir archivo** o arrastrar un archivo a la ventana.

- **Niveles**: separación vertical entre niveles de anidación (0 = diagrama plano).
- **Planta**: vista cenital ortográfica, igual al lienzo de draw.io.
- Clic sobre un elemento: panel con su id, contenedor, origen/destino y estilo draw.io.
- Las etiquetas escalan con el zoom; se ocultan cuando quedarían ilegibles, así que hay que acercarse para leer.

## Despliegue (GitHub Pages, US$0)

El visor es 100 % estático y los diagramas se procesan en el navegador (no se suben a ningún servidor).
El workflow `.github/workflows/deploy-pages.yml` corre los tests, construye con `BASE_PATH=/visor-arq-3d/`
y publica en cada push a la rama por defecto:

- Visor: https://danielfuentes89.github.io/visor-arq-3d/
- Análisis: https://danielfuentes89.github.io/visor-arq-3d/docs/analisis-threejs.html

Activación (una sola vez): **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Después se puede relanzar desde **Actions → Deploy GitHub Pages → Run workflow**.

## Estructura

```
src/
  main.ts                     escena, cámaras, controles, UI, selección
  formats/
    registry.ts               FormatRegistry + interfaz FormatAdapter
    adapters.ts               adaptador drawio + adaptadores de loaders de three.js (carga diferida)
    drawio/
      parse.ts                XML mxfile → modelo (páginas, celdas, estilos, geometría; páginas comprimidas)
      hierarchy.ts            bounds absolutos + contenedores (reales o inferidos por contención)
      build3d.ts              modelo → THREE.Group (losas, sprites, bloques, Line2, CSS2D)
      textures.ts             iconos data URI → textura (normaliza el base64 de draw.io)
      DrawioLoader.ts         loader estilo three.js (extends THREE.Loader)
```

## Agregar un formato nuevo

1. Escribir un adaptador que implemente `FormatAdapter` (`src/formats/registry.ts`):

   ```ts
   export const miFormato: FormatAdapter = {
     id: 'mi-formato',
     name: 'Mi formato',
     extensions: ['mif'],
     sniff: (head) => head.includes('<mi-formato'), // opcional, para extensiones ambiguas
     async load(file, options) {
       const root = construirEscena(await file.text()); // → THREE.Object3D
       return { kind: 'model', views: [{ name: file.name, object: root }] };
     },
   };
   ```

   Para formatos 2D tipo diagrama, devolver `kind: 'diagram'` y una función `rebuild(options)` para que
   el slider de niveles y el selector de etiquetas reconstruyan la escena sin volver a parsear.

2. Registrarlo en `createDefaultRegistry()` (`src/formats/adapters.ts`).

Si el formato ya tiene loader en `three/addons/loaders`, basta con envolverlo (ver `threeAdapters`).

## Limitaciones conocidas (drawio)

- No lee PNG/SVG exportados con el diagrama embebido; solo el XML (`.drawio`, `.dio`, `.xml`).
- Formas especiales (cilindros, nubes, stencils `mxgraph.*` sin imagen) se dibujan como caja o cilindro.
- Las etiquetas HTML se muestran como texto plano (negrita/cursiva a nivel de celda, no por fragmento).
