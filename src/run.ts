// dailyBoard.ts
import { renderDailyBoardPNG } from "./render-board";
import { paletteLevelColorQuantizePNG } from "./pallete-quant"; // map to #000/#fff/#ff0000 exactly
import { uploadImageBuffer, uploadImageFile, type ModelName, type Mode } from './upload-epd.js';
import { loadIcsForDay } from "./fetch-cal";
import { fetchKBZKLocalHeadlines } from "./local-headlines";
import { fetchWeather } from "./fetch-weather";

// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  // Get configuration from environment variables
  const tz = process.env.TZ || "America/Denver";
  const icsUrl = process.env.ICS_URL;
  
  if (!icsUrl) {
    throw new Error("ICS_URL environment variable is required");
  }

  // Get current date in Mountain Time, not UTC
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // "YYYY-MM-DD"

  const { events, allDay } = await loadIcsForDay(icsUrl, today, tz, 2);
  console.log("[CALENDAR] Events:", events);
  console.log("[CALENDAR] AllDay:", allDay);
  console.log("[DATE] Today:", today);

  const lat = parseFloat(process.env.WEATHER_LAT || "");
  const lon = parseFloat(process.env.WEATHER_LON || "");
  const weatherTimeout = parseInt(process.env.WEATHER_TIMEOUT_MS || "5000");
  
  if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
    throw new Error("WEATHER_LAT and WEATHER_LON environment variables are required and must be valid numbers");
  }

  const weather = await fetchWeather(lat, lon, tz, weatherTimeout);
  console.log("[WEATHER] Data:", weather);

  const headlinesMaxItems = parseInt(process.env.HEADLINES_MAX_ITEMS || "5");
  const headlinesTimeout = parseInt(process.env.HEADLINES_TIMEOUT_MS || "4000");

  const headlines = await fetchKBZKLocalHeadlines({
    maxItems: headlinesMaxItems,
    timeoutMs: headlinesTimeout,
  });
  console.log("[HEADLINES] Data:", headlines);

  const triColor = process.env.RENDER_TRI_COLOR === "true";
  const debug = process.env.RENDER_DEBUG === "true";
  const calendarTitle = process.env.CALENDAR_TITLE || "Family Calendar";

  const png = await renderDailyBoardPNG({ 
    dateISO: today, 
    tz, 
    events, 
    allDay, 
    weather, 
    headlines, 
    triColor, 
    debug,
    title: calendarTitle
  });

  // Force palette purity (maps anti-alias grays to BW/red precisely)
  const quantized = await paletteLevelColorQuantizePNG(png, "red");

  // Get E-Paper display configuration
  const epdIp = process.env.EPD_IP;
  const epdModel = (process.env.EPD_MODEL || "12.48inch e-Paper (B)") as ModelName;
  const epdMode = parseInt(process.env.EPD_MODE || "1") as Mode;
  
  if (!epdIp) {
    throw new Error("EPD_IP environment variable is required");
  }

  console.log("[EPD] Uploading to:", epdIp);
  console.log("[EPD] Model:", epdModel);
  console.log("[EPD] Mode:", epdMode);

  // Then feed to your existing packer/uploader with mode=1 (Level: color)
  await uploadImageBuffer({
    ip: epdIp,
    model: epdModel,
    rgba: quantized.data,
    mode: epdMode
  });
}

run().catch(e => { console.error("[ERROR]", e); process.exit(1); });
