// paletteQuant.ts
import sharp from "sharp";

type TriColor = "red" | "yellow" | false;

export type QuantizedRGBA = {
  data: Uint8ClampedArray; // RGBA, same size as input
  width: number;
  height: number;
};

/**
 * PNG Buffer -> RGBA snapped to {black, white, [red|yellow]}.
 * Use triColor: false for mono panels, "red" for B-panels, "yellow" for C-panels.
 */
export async function paletteLevelColorQuantizePNG(
  png: Buffer,
  triColor: TriColor
): Promise<QuantizedRGBA> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true }) as any;

  const rgba = new Uint8ClampedArray(
    data.buffer,
    data.byteOffset,
    data.byteLength
  );
  const snapped = snapToPaletteRGBA(rgba, info.width, info.height, triColor);
  return { data: snapped, width: info.width, height: info.height };
}

/**
 * Raw RGBA -> RGBA snapped to palette. (No decoding step.)
 */
export function snapToPaletteRGBA(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  triColor: TriColor
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);

  // Palettes exactly like the Waveshare page
  const pal =
    triColor === "red"
      ? ([ [0,0,0], [255,255,255], [255,0,0] ] as [number,number,number][])
      : triColor === "yellow"
      ? ([ [0,0,0], [255,255,255], [220,180,0] ] as [number,number,number][])
      : ([ [0,0,0], [255,255,255] ] as [number,number,number][]);

  // Small fast-path thresholds to avoid distance math for obvious pixels
  const NEAR_BLACK = 24;   // <= 24 considered black
  const NEAR_WHITE = 232;  // >= 232 considered white

  // Precompute palette distances if you like; here we just inline for clarity.
  const npx = width * height;
  for (let p = 0, i = 0; p < npx; p++, i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];

    if (a < 128) { // treat transparent as white
      out[i] = 255; out[i+1] = 255; out[i+2] = 255; out[i+3] = 255;
      continue;
    }

    // Fast snaps for grayscale extremes to keep text razor-sharp
    if (r === g && g === b) {
      if (r <= NEAR_BLACK) { out[i]=0; out[i+1]=0; out[i+2]=0; out[i+3]=255; continue; }
      if (r >= NEAR_WHITE){ out[i]=255; out[i+1]=255; out[i+2]=255; out[i+3]=255; continue; }
    }

    // Nearest-color snap in sRGB
    let bestIdx = 0;
    let bestD = 1e12;
    for (let k = 0; k < pal.length; k++) {
      const pr = pal[k][0], pg = pal[k][1], pb = pal[k][2];
      const dr = r - pr, dg = g - pg, db = b - pb;
      const d = dr*dr + dg*dg + db*db;
      if (d < bestD) { bestD = d; bestIdx = k; }
    }
    const [rr, gg, bb] = pal[bestIdx];
    out[i] = rr; out[i+1] = gg; out[i+2] = bb; out[i+3] = 255;
  }
  return out;
}
