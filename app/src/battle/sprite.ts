// Pixel art procedural: cada token genera siempre el mismo monstruo a partir
// de su dirección (forma, ojos, colores) y su tipo (accesorios).
import { MonType, hashSeed, rng } from "./engine";

const N = 24; // rejilla 24×24

type Grid = (string | null)[][];

const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h)} ${s}% ${l}%)`;

/** Color dominante (tono) del logo, si el servidor permite leer sus píxeles. */
export async function logoHue(url?: string): Promise<number | null> {
  if (!url) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 16;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        // Media circular de tonos, ponderada por saturación.
        let x = 0, y = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, b] = [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max - min;
          if (sat < 0.15 || d[i + 3] < 128) continue;
          let h = 0;
          if (max === r) h = ((g - b) / sat) % 6;
          else if (max === g) h = (b - r) / sat + 2;
          else h = (r - g) / sat + 4;
          const rad = (h * 60 * Math.PI) / 180;
          x += Math.cos(rad) * sat;
          y += Math.sin(rad) * sat;
        }
        resolve(x === 0 && y === 0 ? null : ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
      } catch {
        resolve(null); // imagen sin CORS
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export function spriteGrid(mint: string, type: MonType, hueOverride: number | null): Grid {
  const r = rng(hashSeed("sprite", mint));
  const hue = hueOverride ?? r() * 360;
  const body = hsl(hue, 65, 55);
  const light = hsl(hue, 70, 70);
  const dark = hsl(hue, 55, 32);
  const outline = hsl(hue, 45, 14);
  const g: Grid = Array.from({ length: N }, () => Array(N).fill(null));

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
  const legs = r() < 0.7;
  if (legs) {
    const lx = Math.round(cx - rx * 0.5);
    for (let y = cy + Math.round(ry) - 1; y < Math.min(N, cy + Math.round(ry) + 2); y++) {
      g[y][lx] = g[y][N - 1 - lx] = dark;
    }
  }
  // Fantasma: borde inferior ondulado y sin patas.
  if (type === "fantasma") {
    const bottom = cy + Math.round(ry);
    for (let x = 0; x < N; x++) {
      for (let y = bottom - 1; y < N; y++) g[y][x] = (x + y) % 3 === 0 ? null : g[y][x];
    }
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
    const my = ey + 3;
    const w = 1 + Math.floor(r() * 2);
    for (let x = Math.ceil(cx) - w; x <= Math.floor(cx) + w; x++) g[my][x] = outline;
  }

  // Accesorios por tipo.
  const top = cy - Math.round(ry);
  if (type === "pump") {
    // Llama encima de la cabeza.
    const flame = [[0, 1, "#ff5d3a"], [1, 1, "#ff9f1c"], [2, 0, "#ffd166"]] as const;
    for (const [i, half, c] of flame) {
      const y = top - 1 - i;
      if (y < 0) continue;
      for (let x = Math.floor(cx) - half; x <= Math.ceil(cx) + half; x++) g[y][x] = c;
    }
  } else if (type === "diamante") {
    // Corona de cristales.
    for (const [dx, h] of [[-3, 2], [0, 3], [3, 2]] as const) {
      for (let k = 0; k < h; k++) {
        const y = top - k;
        const x = Math.round(cx) + dx;
        if (y >= 0) g[y][x] = k === h - 1 ? "#e0fbff" : "#5ad1ff";
      }
    }
  } else if (type === "ballena") {
    // Chorro de agua.
    for (let k = 1; k <= 3; k++) {
      const y = top - k;
      if (y >= 0) g[y][Math.round(cx)] = k === 3 ? "#bfe9ff" : "#6cc4ff";
    }
    if (top - 3 >= 0) {
      g[top - 3][Math.round(cx) - 1] = "#bfe9ff";
      g[top - 3][Math.round(cx) + 1] = "#bfe9ff";
    }
  } else {
    // Fantasma: aura.
    if (top - 1 >= 0) for (let x = Math.round(cx) - 2; x <= Math.round(cx) + 2; x++) g[top - 1][x] = "rgba(200,220,255,0.6)";
  }

  // Contorno: cualquier vacío junto a un píxel del cuerpo.
  const filled = g.map((row) => row.map((c) => c !== null));
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (filled[y][x]) continue;
      const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(
        ([dx, dy]) => filled[y + dy]?.[x + dx] && !String(g[y + dy][x + dx]).startsWith("rgba"),
      );
      if (near) g[y][x] = outline;
    }
  }
  return g;
}

/** Dibuja el sprite y devuelve una imagen PNG (data URL). */
export function spriteDataUrl(mint: string, type: MonType, hue: number | null, scale = 1) {
  const g = spriteGrid(mint, type, hue);
  const c = document.createElement("canvas");
  c.width = c.height = N * scale;
  const ctx = c.getContext("2d")!;
  if (type === "fantasma") ctx.globalAlpha = 0.85;
  g.forEach((row, y) =>
    row.forEach((col, x) => {
      if (!col) return;
      ctx.fillStyle = col;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }),
  );
  return c.toDataURL();
}
