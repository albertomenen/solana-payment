// Pixel art de los luchadores. Dos estilos:
// - "logo": el logo real de la memecoin pixelado, con los accesorios de su tipo.
// - "monstruo": criatura procedural generada a partir de la dirección del token.
// Si no se pueden leer los píxeles del logo (CORS), se usa el monstruo.
import { MonType, hashSeed, rng } from "./engine";

type Grid = (string | null)[][];

const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h)} ${s}% ${l}%)`;
const emptyGrid = (n: number): Grid => Array.from({ length: n }, () => Array(n).fill(null));

// ---------------- lectura del logo ----------------

const LOGO_PX = 26; // tamaño del logo dentro del sprite de 32×32

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function readPixels(img: HTMLImageElement): ImageData {
  const c = document.createElement("canvas");
  c.width = c.height = LOGO_PX;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, LOGO_PX, LOGO_PX);
  return ctx.getImageData(0, 0, LOGO_PX, LOGO_PX); // lanza si la imagen no permite CORS
}

const pixelCache = new Map<string, Promise<ImageData | null>>();

/**
 * Píxeles del logo a 26×26. Primero directo; si el servidor no permite leerlo,
 * a través de wsrv.nl (proxy de imágenes público con CORS que además la reduce).
 */
export function logoPixels(url?: string): Promise<ImageData | null> {
  if (!url) return Promise.resolve(null);
  if (!pixelCache.has(url)) {
    const proxied = `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=64&h=64&fit=cover&output=png`;
    pixelCache.set(
      url,
      loadImage(url)
        .then(readPixels)
        .catch(() => loadImage(proxied).then(readPixels))
        .catch(() => null),
    );
  }
  return pixelCache.get(url)!;
}

/** Tono dominante (media circular ponderada por saturación). */
export function dominantHue(d: ImageData): number | null {
  let x = 0, y = 0;
  for (let i = 0; i < d.data.length; i += 4) {
    const [r, g, b] = [d.data[i] / 255, d.data[i + 1] / 255, d.data[i + 2] / 255];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max - min;
    if (sat < 0.15 || d.data[i + 3] < 128) continue;
    let h = max === r ? ((g - b) / sat) % 6 : max === g ? (b - r) / sat + 2 : (r - g) / sat + 4;
    h = (h * 60 * Math.PI) / 180;
    x += Math.cos(h) * sat;
    y += Math.sin(h) * sat;
  }
  return x === 0 && y === 0 ? null : ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// ---------------- piezas comunes ----------------

/** Accesorios del tipo encima de la cabeza (fila `top`), centrados en `cx`. */
function addAccessory(g: Grid, type: MonType, cx: number, top: number) {
  const put = (y: number, x: number, c: string) => {
    if (y >= 0 && y < g.length && x >= 0 && x < g.length) g[y][x] = c;
  };
  const c0 = Math.floor(cx), c1 = Math.ceil(cx);
  if (type === "pump") {
    // Llama.
    for (const [i, half, col] of [[0, 1, "#ff5d3a"], [1, 1, "#ff9f1c"], [2, 0, "#ffd166"]] as const)
      for (let x = c0 - half; x <= c1 + half; x++) put(top - 1 - i, x, col);
  } else if (type === "diamante") {
    // Corona de cristales.
    for (const [dx, h] of [[-3, 2], [0, 3], [3, 2]] as const)
      for (let k = 0; k < h; k++) {
        put(top - k, c0 + dx, k === h - 1 ? "#e0fbff" : "#5ad1ff");
        if (dx === 0) put(top - k, c1, k === h - 1 ? "#e0fbff" : "#5ad1ff");
      }
  } else if (type === "ballena") {
    // Chorro de agua.
    for (let k = 1; k <= 3; k++) put(top - k, c0, k === 3 ? "#bfe9ff" : "#6cc4ff");
    put(top - 3, c0 - 1, "#bfe9ff");
    put(top - 3, c0 + 1, "#bfe9ff");
  } else {
    // Fantasma: aura.
    for (let x = c0 - 2; x <= c1 + 2; x++) put(top - 1, x, "rgba(200,220,255,0.6)");
  }
}

/** Contorno de 1 px alrededor de todo lo dibujado (salvo el aura translúcida). */
function addOutline(g: Grid, color: string) {
  const n = g.length;
  const solid = g.map((row) => row.map((c) => c !== null && !c.startsWith("rgba")));
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (g[y][x] === null && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => solid[y + dy]?.[x + dx]))
        g[y][x] = color;
}

function render(g: Grid, ghost: boolean) {
  const c = document.createElement("canvas");
  c.width = c.height = g.length;
  const ctx = c.getContext("2d")!;
  if (ghost) ctx.globalAlpha = 0.85;
  g.forEach((row, y) =>
    row.forEach((col, x) => {
      if (!col) return;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }),
  );
  return c.toDataURL();
}

// ---------------- estilo "logo" ----------------

/** Reduce cada canal a pocos niveles para el aspecto de paleta limitada. */
const posterize = (v: number) => Math.round(Math.round((v / 255) * 5) * (255 / 5));

export function logoGrid(px: ImageData, type: MonType): Grid {
  const N = 32;
  const g = emptyGrid(N);
  const off = { x: (N - LOGO_PX) / 2, y: N - LOGO_PX - 2 }; // deja hueco arriba para el accesorio
  const r = LOGO_PX / 2;
  for (let y = 0; y < LOGO_PX; y++) {
    for (let x = 0; x < LOGO_PX; x++) {
      // Recorte circular (casi todos los logos son redondos).
      if ((x + 0.5 - r) ** 2 + (y + 0.5 - r) ** 2 > r * r) continue;
      const i = (y * LOGO_PX + x) * 4;
      if (px.data[i + 3] < 100) continue;
      const [R, G, B] = [posterize(px.data[i]), posterize(px.data[i + 1]), posterize(px.data[i + 2])];
      g[y + off.y][x + off.x] = `rgb(${R},${G},${B})`;
    }
  }
  const cx = (N - 1) / 2;
  // Patitas (las fantasma flotan).
  if (type !== "fantasma") {
    for (const x of [Math.round(cx - 5), Math.round(cx - 4), Math.round(cx + 4), Math.round(cx + 5)]) {
      g[N - 2][x] = "#2a2a30";
      g[N - 1][x] = "#2a2a30";
    }
  }
  addAccessory(g, type, cx, off.y);
  const hue = dominantHue(px) ?? 260;
  addOutline(g, hsl(hue, 40, 12));
  return g;
}

// ---------------- estilo "monstruo" ----------------

export function monsterGrid(mint: string, type: MonType, hueOverride: number | null): Grid {
  const N = 24;
  const r = rng(hashSeed("sprite", mint));
  const hue = hueOverride ?? r() * 360;
  const body = hsl(hue, 65, 55);
  const light = hsl(hue, 70, 70);
  const dark = hsl(hue, 55, 32);
  const outline = hsl(hue, 45, 14);
  const g = emptyGrid(N);

  // Cuerpo: elipse con bultos aleatorios, simétrica.
  const wide = type === "ballena" ? 1.25 : type === "pump" ? 0.85 : 1;
  const cx = (N - 1) / 2;
  const cy = 13 + Math.floor(r() * 2);
  const rx = (5.5 + r() * 2) * wide;
  const ry = 6 + r() * 2;
  const bumps = Array.from({ length: 6 }, () => r() * 1.6 - 0.4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x <= cx; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const ang = Math.atan2(dy, Math.abs(dx));
      const bump = bumps[Math.floor(((ang + Math.PI) / (2 * Math.PI)) * 6) % 6] * 0.12;
      if (dx * dx + dy * dy <= 1 + bump) {
        const shade = dy < -0.35 ? light : dy > 0.45 ? dark : body;
        g[y][x] = g[y][N - 1 - x] = shade;
      }
    }
  }
  // Patas.
  if (r() < 0.7) {
    const lx = Math.round(cx - rx * 0.5);
    for (let y = cy + Math.round(ry) - 1; y < Math.min(N, cy + Math.round(ry) + 2); y++) g[y][lx] = g[y][N - 1 - lx] = dark;
  }
  // Fantasma: borde inferior ondulado.
  if (type === "fantasma") {
    const bottom = cy + Math.round(ry);
    for (let x = 0; x < N; x++) for (let y = bottom - 1; y < N; y++) if ((x + y) % 3 === 0) g[y][x] = null;
  }
  // Ojos.
  const ey = cy - Math.round(ry * 0.25) - Math.floor(r() * 2);
  const ex = Math.round(cx - 1.5 - r() * 1.5);
  const big = r() < 0.5;
  for (const x of [ex, N - 1 - ex]) {
    g[ey][x] = "#fff";
    if (big) g[ey - 1][x] = "#fff";
    g[ey][x + (x < cx ? 1 : -1)] = "#111";
  }
  // Boca.
  if (r() < 0.75) {
    const w = 1 + Math.floor(r() * 2);
    for (let x = Math.ceil(cx) - w; x <= Math.floor(cx) + w; x++) g[ey + 3][x] = outline;
  }
  addAccessory(g, type, cx, cy - Math.round(ry));
  addOutline(g, outline);
  return g;
}

// ---------------- API ----------------

export type SpriteStyle = "logo" | "monster";

/** Sprite inmediato (monstruo) para mostrar mientras carga el logo. */
export const monsterSprite = (mint: string, type: MonType, hue: number | null = null) =>
  render(monsterGrid(mint, type, hue), type === "fantasma");

/**
 * Sprite final: el logo pixelado si se puede leer; si no (o si se pide el
 * estilo monstruo), el monstruo teñido con el color del logo cuando se conoce.
 */
export async function buildSprite(mint: string, type: MonType, image: string | undefined, style: SpriteStyle) {
  const px = await logoPixels(image);
  if (px && style === "logo") return { url: render(logoGrid(px, type), type === "fantasma"), fromLogo: true };
  return { url: monsterSprite(mint, type, px ? dominantHue(px) : null), fromLogo: false };
}
