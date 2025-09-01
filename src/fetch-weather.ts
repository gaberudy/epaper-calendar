export type WeatherOut = {
  tempNow: string;    // "57°"
  hi: string;         // "74°"
  lo: string;         // "49°"
  precip: string;     // "20%"
  sunrise: string;    // "6:42a"
  sunset: string;     // "8:03p"
  alert?: string;     // "Winter Weather Advisory • …"
};

const UA = "epaper-board/1.0 (+local)";
const DEFAULT_TIMEOUT = 5000;

// Input: lat/lon as numbers and tz as string
export async function fetchWeather(
  lat: number,
  lon: number,
  tz = "America/Denver",
  timeoutMs = DEFAULT_TIMEOUT
): Promise<WeatherOut> {
  // ----- Open-Meteo: current + today daily -----
  const omUrl = new URL("https://api.open-meteo.com/v1/forecast");
  omUrl.searchParams.set("latitude", String(lat));
  omUrl.searchParams.set("longitude", String(lon));
  omUrl.searchParams.set("current", "temperature_2m");
  omUrl.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset"
  );
  omUrl.searchParams.set("timezone", tz);
  omUrl.searchParams.set("forecast_days", "1"); // today only

  const om = await fetchJson(omUrl.toString(), {
    headers: { "User-Agent": UA },
    timeoutMs,
  });

  const tempNowNum = celsiusToFahrenheit(num(om?.current?.temperature_2m));
  const tmax = celsiusToFahrenheit(num(om?.daily?.temperature_2m_max?.[0]));
  const tmin = celsiusToFahrenheit(num(om?.daily?.temperature_2m_min?.[0]));
  const precipProb = num(om?.daily?.precipitation_probability_max?.[0]);
  const sunriseISO = String(om?.daily?.sunrise?.[0] ?? "");
  const sunsetISO  = String(om?.daily?.sunset?.[0] ?? "");

  // ----- NWS Alerts for the point -----
  let alertText: string | undefined;
  try {
    const nwsUrl = new URL("https://api.weather.gov/alerts/active");
    nwsUrl.searchParams.set("point", `${lat},${lon}`);
    const gj = await fetchJson(nwsUrl.toString(), {
      headers: {
        "User-Agent": UA,
        "Accept": "application/geo+json",
      },
      timeoutMs,
    });
    const titles: string[] = [];
    const feats: any[] = Array.isArray(gj?.features) ? gj.features : [];
    const seen = new Set<string>();
    for (const f of feats) {
      const id = String(f?.id ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const p = f?.properties ?? {};
      const headline = String(p.headline ?? p.event ?? "").trim();
      if (headline) titles.push(headline);
    }
    if (titles.length) alertText = titles.join(" • ");
  } catch {
    // Ignore alert failures; weather still renders.
  }

  return {
    tempNow: fmtDeg(tempNowNum),
    hi: fmtDeg(tmax),
    lo: fmtDeg(tmin),
    precip: fmtPct(precipProb),
    sunrise: fmtClock(sunriseISO, tz),
    sunset: fmtClock(sunsetISO, tz),
    ...(alertText ? { alert: alertText } : {}),
  };
}

/* ------------- helpers ------------- */

async function fetchJson(url: string, opts: { headers?: Record<string,string>; timeoutMs?: number }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, { headers: opts.headers, signal: controller.signal });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function celsiusToFahrenheit(celsius: number | null): number | null {
  if (celsius == null) return null;
  return (celsius * 9/5) + 32;
}

function fmtDeg(n: number | null): string {
  if (n == null) return "—";
  return `${Math.round(n)}°`;
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${Math.round(n)}%`;
}

function fmtClock(iso: string, tz: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const s = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  }).format(d); // e.g., "6:42 AM"
  return s.replace(/\s*AM/i, "a").replace(/\s*PM/i, "p");
}
