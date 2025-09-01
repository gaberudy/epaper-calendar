#!/usr/bin/env ts-node

/**
 * 12.48" Waveshare E-Paper uploader for ESP32 web server.
 * Replicates the browser page’s upload pipeline:
 *  - POST /EPD          (body = model name)
 *  - POST /LOADA ...    (black/white plane, chunked)
 *  - POST /LOADB ...    (red/yellow plane, chunked; only if color device)
 *  - POST /SHOW         (body = model name)
 *
 * Device geometry is fixed to 1304 x 984. Payload packing matches the page:
 *   - pixels -> 1bit planes (black plane: 0=black, 1=white; ry plane: 0=ry, 1=white)
 *   - 4 pixels -> nibble 0..15 -> 'a'(97)+nibble -> 'a'..'p'
 *   - special row/column reordering (162 / 164 split across halves).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { argv } from "node:process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import sharp from "sharp";

// Node 18+ has global fetch
export const CHUNK_SIZE = 30000;
export const WIDTH = 1304;
export const HEIGHT = 984;
export const XSTR = Math.ceil(WIDTH / 4); // 326
export const TOP_HALF_ROWS = HEIGHT / 2;  // 492
export const LEFT_NIBBLES = 162;
export const RIGHT_NIBBLES = XSTR - LEFT_NIBBLES; // 164

export type ModelName =
  | "12.48inch e-Paper"
  | "12.48inch e-Paper (B)"
  | "12.48inch e-Paper (C)";

export type FitMode = "contain" | "cover" | "fill";

const MODELS: Record<ModelName, { color: 0 | 1 | 2 }> = {
  "12.48inch e-Paper": { color: 0 },    // mono
  "12.48inch e-Paper (B)": { color: 1 },// black + red
  "12.48inch e-Paper (C)": { color: 2 },// black + yellow
};

/**
 * Quantization modes matching the web interface:
 * 
 * 0 = Level: mono (no dithering) - Simple threshold quantization to black/white
 * 1 = Level: color (no dithering) - Simple quantization to palette colors
 * 2 = Dither: mono (web kernel) - Floyd-Steinberg-like dithering with custom kernel
 * 3 = Dither: color (web kernel) - Custom error diffusion for color devices
 * 
 * The web page uses a non-standard error diffusion kernel (divided by 32) that pushes
 * more darkness than classic Floyd-Steinberg. It uses row-pair error buffers and
 * asymmetric edge handling, unlike the CLI's standard 7/16,3/16,5/16,1/16 kernel.
 */
export type Mode = 0 | 1 | 2 | 3;

// Palettes exactly as in your page's palArr
const PAL_ARR: [number, number, number][][] = [
  [[0,0,0],[255,255,255]],                // 0
  [[0,0,0],[255,255,255],[255,0,0]],      // 1
  [[0,0,0],[255,255,255],[127,127,127]],  // 2
  [[0,0,0],[255,255,255],[127,127,127],[127,0,0]], // 3 (unused here)
  [[0,0,0],[255,255,255]],                // 4
  [[0,0,0],[255,255,255],[220,180,0]],    // 5
];

// Map model -> base palInd like epdArr[...][4] in the page
function basePalIndFor(model: ModelName): number {
  if (model === "12.48inch e-Paper") return 0;       // mono
  if (model === "12.48inch e-Paper (B)") return 1;   // red
  return 5;                                          // yellow
}

function nearestIdx(r:number,g:number,b:number, pal:[number,number,number][]): number {
  let idx=0, best=Number.POSITIVE_INFINITY;
  for (let i=0;i<pal.length;i++){
    const dr=r-pal[i][0], dg=g-pal[i][1], db=b-pal[i][2];
    const d = dr*dr+dg*dg+db*db;
    if (d<best){ best=d; idx=i; }
  }
  return idx;
}

// Web "Level" path: nearest without error diffusion
function quantizeLevelWeb(rgba: Uint8ClampedArray, pal: [number,number,number][]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let y=0;y<HEIGHT;y++){
    for (let x=0;x<WIDTH;x++){
      const i=(y*WIDTH+x)*4;
      const k=nearestIdx(rgba[i], rgba[i+1], rgba[i+2], pal);
      const [r,g,b]=pal[k];
      out[i]=r; out[i+1]=g; out[i+2]=b; out[i+3]=255;
    }
  }
  return out;
}

/**
 * Web "Dither" path: matches page code:
 * - Two-line rolling error buffers errArr[2][WIDTH] of RGB triplets
 * - Weights k/32 with k in {7,2,7} for left edge, {7,9} for right edge,
 *   and {3,5,1,7} for interior (left-below, below, right-below, right)
 */
function quantizeDitherWeb(srcRGBA: Uint8ClampedArray, pal: [number,number,number][]): Uint8ClampedArray {
  // Work buffer in floats for error accumulation
  const buf = new Float32Array(srcRGBA.length);
  for (let i=0;i<srcRGBA.length;i++) buf[i]=srcRGBA[i];
  const out = new Uint8ClampedArray(srcRGBA.length);

  const errA = Array.from({length: WIDTH}, () => [0,0,0] as [number,number,number]);
  const errB = Array.from({length: WIDTH}, () => [0,0,0] as [number,number,number]);

  const add = (acc:[number,number,number], er:number, eg:number, eb:number, k:number) => {
    const f = k/32; // IMPORTANT: divisor 32 like the page
    acc[0]+=er*f; acc[1]+=eg*f; acc[2]+=eb*f;
  };

  for (let y=0;y<HEIGHT;y++){
    // swap rows: a<-b, clear b
    for (let x=0;x<WIDTH;x++) { errA[x]=errB[x]; errB[x]=[0,0,0]; }

    for (let x=0;x<WIDTH;x++){
      const i=(y*WIDTH+x)*4;
      // current + carried error
      const r = buf[i]   + errA[x][0];
      const g = buf[i+1] + errA[x][1];
      const b = buf[i+2] + errA[x][2];

      const kIdx = nearestIdx(r,g,b,pal);
      const [rr,gg,bb] = pal[kIdx];

      out[i]=rr; out[i+1]=gg; out[i+2]=bb; out[i+3]=255;

      const er = r - rr, eg = g - gg, eb = b - bb;

      if (x === 0) {
        // left edge
        add(errB[x],     er,eg,eb, 7);
        if (x+1<WIDTH) add(errB[x+1], er,eg,eb, 2);
        if (x+1<WIDTH) add(errA[x+1], er,eg,eb, 7);
      } else if (x === WIDTH-1) {
        // right edge
        add(errB[x-1], er,eg,eb, 7);
        add(errB[x],   er,eg,eb, 9);
      } else {
        // interior
        add(errB[x-1], er,eg,eb, 3);
        add(errB[x],   er,eg,eb, 5);
        add(errB[x+1], er,eg,eb, 1);
        add(errA[x+1], er,eg,eb, 7);
      }
    }
  }
  return out;
}

/**
 * Reproduce esp32 embedded server web page logic:
 *   palInd = basePalIndFor(model)
 *   isLvl = (mode & 0x02) == 0
 *   isRed =  mode & 0x01
 *   if (!isRed) palInd &= 0xFE   // strip to mono palette for mono modes
 */
function paletteForMode(model: ModelName, mode: Mode): [number,number,number][] {
  let palInd = basePalIndFor(model);
  const isRed = (mode & 0x01) === 1;
  if (!isRed) palInd &= 0xFE; // -> 0 or 4 (both are BW), or 2 for greyscale set (unused)
  return PAL_ARR[palInd];
}

async function loadAndRasterize(
  file: string,
  fit: FitMode,
  model: ModelName,
  mode: Mode,
): Promise<Uint8ClampedArray> {
  // Resize + white letterbox/crop/stretch to panel size
  const { data } = await sharp(file)
    .flatten({ background: "#ffffff" })
    .modulate({ brightness: 1.0, saturation: 1.0 })
    .linear(1.10, -12)   // slight contrast bump
    .resize(WIDTH, HEIGHT, { fit, background: { r:255,g:255,b:255,alpha:1 } })
    .removeAlpha()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true }) as { data: Buffer, info: any };

  const src = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const pal = paletteForMode(model, mode);

  const isLvl = ((mode & 0x02) === 0); // modes 0/1
  return isLvl ? quantizeLevelWeb(src, pal) : quantizeDitherWeb(src, pal);
}

/**
 * Build mutually exclusive planes like the web uploader:
 * - BLACK plane bit = 0 only for pure black (#000000)
 * - RY    plane bit = 0 only for the accent color (exact #FF0000 or #DCB400)
 * - Everything else (white) -> both bits stay 1
 */
function makePlanes(
  rgba: Uint8ClampedArray,
  model: ModelName,
  mode?: Mode // optional: can force mono behavior
): { blackBits: Uint8Array; ryBits: Uint8Array } {
  const total = WIDTH * HEIGHT;
  const blackBits = new Uint8Array(total);
  const ryBits = new Uint8Array(total);
  blackBits.fill(1);
  ryBits.fill(1);

  const colorFlag = MODELS[model].color; // 0 mono, 1 red, 2 yellow
  const triColor = colorFlag !== 0 && ((mode ?? 1) & 0x01) === 1; // modes 1/3 are "color" paths

  const accent =
    colorFlag === 1 ? [255, 0, 0] :
    colorFlag === 2 ? [220, 180, 0] :
    null as [number, number, number] | null;

  for (let i = 0; i < total; i++) {
    const k = i * 4;
    const r = rgba[k], g = rgba[k + 1], b = rgba[k + 2], a = rgba[k + 3];
    if (a === 0) continue;

    const isWhite = (r === 255 && g === 255 && b === 255);
    const isBlack = (r === 0 && g === 0 && b === 0);

    if (isBlack) {
      blackBits[i] = 0;          // ink on black plane
      // ryBits[i] stays 1 (critical!)
    } else if (!isWhite && triColor && accent && r === accent[0] && g === accent[1] && b === accent[2]) {
      ryBits[i] = 0;             // ink on color plane
      // blackBits[i] stays 1
    }
    // else leave both bits = 1 (white)
  }

  return { blackBits, ryBits };
}

/**
 * Pack 4 pixels (bits) -> nibble 0..15 -> 'a'+nibble
 * Scans row-major across full image, identical to the page logic.
 */
function packToChars(bits: Uint8Array): string {
  const total = bits.length;
  let out = "";
  let acc = 0, j = 0;
  for (let i=0;i<total;i++){
    acc += (bits[i] & 1) << (3 - j);
    j++;
    if (j === 4) {
      out += String.fromCharCode(97 + acc); // 'a' + nibble
      acc = 0; j = 0;
    }
  }
  // If WIDTH*HEIGHT not multiple of 4 (it is), pad last nibble if needed
  if (j !== 0) {
    out += String.fromCharCode(97 + acc);
  }
  return out;
}

/**
 * Reorder to m1 s1 m2 s2 (left 162, right 164) across top half, then bottom half (492 rows each).
 * Mirrors the four loops in the esp32 embedded server web page exactly.
 */
function reorderFor1248(msg: string): string {
  // msg length must be XSTR * HEIGHT = 326 * 984 = 320,  approx 320k
  if (msg.length !== XSTR*HEIGHT) {
    throw new Error(`Unexpected message length ${msg.length}, expected ${XSTR*HEIGHT}`);
  }
  let out = "";

  // top half rows [0, 492)
  for (let i=0; i<TOP_HALF_ROWS; i++) {
    const base = i*XSTR;
    out += msg.slice(base, base + LEFT_NIBBLES);
  }
  for (let i=0; i<TOP_HALF_ROWS; i++) {
    const base = i*XSTR;
    out += msg.slice(base + LEFT_NIBBLES, base + XSTR);
  }

  // bottom half rows [492, 984)
  for (let i=TOP_HALF_ROWS; i<HEIGHT; i++) {
    const base = i*XSTR;
    out += msg.slice(base, base + LEFT_NIBBLES);
  }
  for (let i=TOP_HALF_ROWS; i<HEIGHT; i++) {
    const base = i*XSTR;
    out += msg.slice(base + LEFT_NIBBLES, base + XSTR);
  }

  return out;
}

function chunk(s: string, n = CHUNK_SIZE): string[] {
  const out: string[] = [];
  for (let i=0; i<s.length; i+=n) out.push(s.slice(i, i+n));
  return out;
}

async function postText(ip: string, path: string, body: string): Promise<void> {
  const url = `http://${ip}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=> "");
    throw new Error(`POST ${path} -> ${res.status} ${res.statusText} ${txt ? `\n${txt}` : ""}`);
  }
}

/**
 * Upload an image buffer to the ESP32 e-paper display
 */
export async function uploadImageBuffer({
  ip,
  model,
  rgba,
  mode = 2
}: {
  ip: string;
  model: ModelName;
  rgba: Uint8ClampedArray;
  mode?: Mode;
}): Promise<void> {
  if (!MODELS[model]) {
    throw new Error(`Unsupported model: ${model}. Use one of: ${Object.keys(MODELS).join(", ")}`);
  }
  const colorFlag = MODELS[model].color; // 0 mono, 1 red, 2 yellow

  console.log(`[EPD] Building BW and RY planes`);
  const { blackBits, ryBits } = makePlanes(rgba, model, mode);

  console.log(`[EPD] Packing to 'a'..'p' nibbles`);
  const bMsg = packToChars(blackBits);
  const rMsg = (colorFlag ? packToChars(ryBits) : "");

  console.log(`[EPD] Reordering stream (m1 s1 m2 s2)`);
  const bOrdered = reorderFor1248(bMsg);
  const rOrdered = (colorFlag ? reorderFor1248(rMsg) : "");

  const bChunks = chunk(bOrdered, CHUNK_SIZE);
  const rChunks = (colorFlag ? chunk(rOrdered, CHUNK_SIZE) : []);

  console.log(`[EPD] HTTP to ESP32 @ ${ip}`);
  console.log(`[EPD] POST /EPD  "${model}"`);
  await postText(ip, "EPD", model);
  // await postText(ip, "EPD", model);

  console.log(`[EPD] POST /LOADA  x${bChunks.length} chunks`);
  for (let i=0;i<bChunks.length;i++){
    await postText(ip, "LOADA", bChunks[i]);
    if ((i+1)%10===0 || i===bChunks.length-1) console.log(`[EPD]     ${i+1}/${bChunks.length}`);
  }

  if (colorFlag) {
    console.log(`[EPD] POST /LOADB  x${rChunks.length} chunks`);
    for (let i=0;i<rChunks.length;i++){
      await postText(ip, "LOADB", rChunks[i]);
      if ((i+1)%10===0 || i===rChunks.length-1) console.log(`[EPD]     ${i+1}/${rChunks.length}`);
    }
  }

  console.log(`[EPD] POST /SHOW  "${model}"`);
  await postText(ip, "SHOW", model);

  console.log("[EPD] Done.");
}

/**
 * Process an image file and upload it to the ESP32 e-paper display
 */
export async function uploadImageFile({
  ip,
  input,
  model = "12.48inch e-Paper (B)" as ModelName,
  fit = "contain" as FitMode,
  mode = 2 as Mode
}: {
  ip: string;
  input: string;
  model?: ModelName;
  fit?: FitMode;
  mode?: Mode;
}): Promise<void> {
  if (!MODELS[model]) {
    throw new Error(`Unsupported model: ${model}. Use one of: ${Object.keys(MODELS).join(", ")}`);
  }
  const colorFlag = MODELS[model].color; // 0 mono, 1 red, 2 yellow
  console.log(`[EPD] Model: ${model}, colorFlag: ${colorFlag}`);

  const imgPath = path.resolve(input);
  await fs.access(imgPath);

  console.log(`[EPD] Rasterizing ${imgPath} -> ${WIDTH}x${HEIGHT} (${model}), fit=${fit}, mode=${mode}`);
  const rgba = await loadAndRasterize(imgPath, fit, model, mode);

  await uploadImageBuffer({ ip, model, rgba, mode });
}

async function main() {
  const args = await yargs(hideBin(argv))
    .scriptName("upload-epd")
    .usage("$0 --ip <addr> --input <image> [--model \"12.48inch e-Paper (B)\"] [--fit contain|cover|fill] [--mode 0|1|2|3]")
    .option("ip",     { type: "string", demandOption: true, describe: "ESP32 IP (e.g., 192.168.7.149)" })
    .option("input",  { type: "string", demandOption: true, describe: "Path to image file (png/jpg/etc.)" })
    .option("model",  { type: "string", default: "12.48inch e-Paper (B)", describe: "Device model string sent to /EPD and /SHOW" })
    .option("fit",    { type: "string", default: "contain", choices: ["contain","cover","fill"], describe: "Resize strategy to 1304x984" })
    .option("mode",   { type: "number", default: 2, choices: [0,1,2,3], describe: "0: Level mono, 1: Level color, 2: Dither mono, 3: Dither color (matches web)" })
    .strict()
    .parse();

  await uploadImageFile({
    ip: args.ip,
    input: String(args.input),
    model: args.model as ModelName,
    fit: args.fit as FitMode,
    mode: args.mode as Mode
  });
}

// Only run CLI if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}
