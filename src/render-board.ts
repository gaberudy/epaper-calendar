// renderBoard.ts
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
import { AllDayItem } from "./fetch-cal";

export type EventIn = {
  id?: string;
  title: string;
  start: string;     // ISO
  end?: string;      // ISO
  allDay?: boolean;
  location?: string;
  important?: boolean; // pre-tagged, or compute later
};

export type WeatherBlock = {
  tempNow: string; hi: string; lo: string; precip: string;
  sunrise: string; sunset: string; alert?: string;
};



export async function renderDailyBoardPNG(
  opts: {
    dateISO: string;                // YYYY-MM-DD (local "today" to render)
    tz: string;                     // e.g., 'America/Denver'
    events: EventIn[];
    allDay: AllDayItem[];
    weather: WeatherBlock;
    headlines: string[];
    triColor: boolean;              // true for red accents
    debug: boolean;                 // true to save HTML to file
    title?: string;                 // calendar title
  }
): Promise<Buffer> {

  // Inline HTML with FullCalendar + right column (weather/news)
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=1304, initial-scale=1"/>
  <link rel="preconnect" href="https://cdn.jsdelivr.net"/>
  <link href="https://cdn.jsdelivr.net/npm/fullcalendar@6.1.11/index.global.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/fullcalendar@6.1.11/index.global.min.js"></script>
  <style>
    :root{
      --red: ${opts.triColor ? "#ff0000" : "#000000"};
      --fc-border-color: #000;
      --fc-page-bg-color: #fff;
      --fc-neutral-bg-color: #fff;
      --fc-today-bg-color: #fff; /* static snapshot */
      --fc-event-bg-color: #fff;
      --fc-event-border-color: #000;
      --fc-event-text-color: #000;
      --fc-now-indicator-color: var(--red);
    }
    html,body{ margin:0; padding:0; background:#fff; }
    #board{ width:1304px; height:984px; display:flex; font-family: Arial, sans-serif; color:#000; }
    .col-left{ flex: 0 0 864px; height:100%; border-right:2px solid #000; padding:16px; box-sizing:border-box;}
    .col-right{ flex: 1; height:100%; padding:16px; box-sizing:border-box; display:flex; flex-direction:column; gap:16px;}

    h1{ margin:0 0 8px 0; font-size:48px; font-weight:800; }
    .date-sub{ font-size:20px; margin-bottom:8px; }
    .section{ border:2px solid #000; padding:10px; }
    .section h2{ margin:0 0 8px 0; font-size:24px; font-weight:800; }
    .accent{ color: var(--red); }
    .pill{ display:inline-block; padding:2px 8px; border:2px solid var(--red); color:var(--red); font-weight:600; }

    /* FullCalendar sizing for dense, legible e-paper */
    #cal{ height: 860px; } /* 984 - header etc */
    .fc .fc-timegrid-slot{ height: 26px; }         /* slot density */
    .fc .fc-col-header-cell-cushion{ padding: 4px 0; font-weight:800; }
    .fc .fc-timegrid-axis-cushion{ padding: 0 4px; font-size: 12px; }
    .fc .fc-event{ border-width:2px; }
    .fc .fc-event .fc-event-main{ padding: 2px 4px; font-size:16px; line-height:1.2; }
    .fc .fc-timegrid-event-harness-inset .fc-timegrid-event{ box-shadow:none; }
    .fc .fc-event.important{ border-color: var(--red); }
    .fc .fc-event.important .fc-event-title{ color: var(--red); font-weight:800; }
    .fc .fc-daygrid-event{ border-width:2px; }
    .fc .fc-daygrid-event-dot{ border-color: var(--red); background: var(--red); }

    /* Force crisp palette on text and lines */
    *{ -webkit-font-smoothing:none; text-rendering:geometricPrecision; }
  </style>
</head>
<body>
  <div id="board">
    <div class="col-left">
      <div id="header">
        <h1 id="title"></h1>
        <div class="date-sub" id="subtitle"></div>
      </div>
      <div id="cal"></div>
    </div>
    <div class="col-right">
      <div class="section" id="weather">
        <h2>Weather ${opts.triColor ? '<span class="pill">Today</span>' : ''}</h2>
        <div style="font-size:56px; font-weight:800">${opts.weather.tempNow}</div>
        <div style="font-size:20px">Hi ${opts.weather.hi} / Lo ${opts.weather.lo} • Precip ${opts.weather.precip}</div>
        <div style="font-size:18px">Sunrise ${opts.weather.sunrise} • Sunset ${opts.weather.sunset}</div>
        ${opts.weather.alert ? `<div class="accent" style="margin-top:6px; font-weight:800">ALERT: ${escapeHtml(opts.weather.alert)}</div>` : ""}
      </div>
      ${opts.allDay && opts.allDay.filter(h => h.date === opts.dateISO).length > 0 ? `
      <div class="section" id="news">
        <h2>All Day Today</h2>
        <ul style="margin:0; padding-left:18px; font-size:22px; line-height:1.25">
          ${opts.allDay.filter(h => h.date === opts.dateISO).slice(0,5).map(h=>`<li${h.important ? ' class="accent"' : ''}>${escapeHtml(h.title)}</li>`).join("")}
        </ul>
      </div>
      ` : ''}
      ${opts.allDay && opts.allDay.filter(h => h.date !== opts.dateISO).length > 0 ? `
      <div class="section" id="news">
        <h2>All Day Tomorrow</h2>
        <ul style="margin:0; padding-left:18px; font-size:22px; line-height:1.25">
          ${opts.allDay.filter(h => h.date !== opts.dateISO).slice(0,5).map(h=>`<li${h.important ? ' class="accent"' : ''}>${escapeHtml(h.title)}</li>`).join("")}
        </ul>
      </div>
      ` : ''}
      <div class="section" id="news">
        <h2>Headlines</h2>
        <ol style="margin:0; padding-left:18px; font-size:22px; line-height:1.25">
          ${opts.headlines.slice(0,5).map(h=>`<li>${escapeHtml(h)}</li>`).join("")}
        </ol>
      </div>
    </div>
  </div>
  <script>
    // Inputs from Node:
    const INPUT = ${JSON.stringify(opts)};

    // Header: "Today & Tomorrow" and date range
    const day0 = new Date(INPUT.dateISO + "T00:00:00");
    const day1 = new Date(day0); day1.setDate(day0.getDate() + 1);

    const fmtLong = new Intl.DateTimeFormat('en-US', { weekday:'long', timeZone: INPUT.tz });
    const fmtShort = new Intl.DateTimeFormat('en-US', { month:'short', day:'numeric', timeZone: INPUT.tz });

    document.getElementById("title").textContent = "${opts.title || "Family Calendar"}";

    // Prepare events for FullCalendar: EXCLUDE all-day (we'll render those in the right bar)
    const fcEvents = INPUT.events
      .filter(ev => !ev.allDay)
      .map(ev => ({
        id: ev.id || undefined,
        title: ev.title,
        start: ev.start,
        end: ev.end || undefined,
        allDay: false,
        classNames: (ev.important ? ["important"] : [])
      }));

    const calendarEl = document.getElementById('cal');
    const cal = new FullCalendar.Calendar(calendarEl, {
      // Two-day timeGrid view (today + tomorrow)
      views: {
        twoDay: { type: 'timeGrid', duration: { days: 2 } }
      },
      initialView: 'twoDay',
      initialDate: INPUT.dateISO,

      headerToolbar: false,
      height: '100%',
      slotMinTime: '06:00:00',
      slotMaxTime: '22:30:00',
      expandRows: true,
      nowIndicator: false,
      allDaySlot: false,                 // HIDE all-day section
      eventOverlap: true,
      dayMaxEventRows: false,
      eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },

      // Label columns "Today" / "Tomorrow"
      dayHeaderContent: function(arg) {
        const d = arg.date;
        // Use the same timezone-aware formatting as the header
        const label = fmtLong.format(d) + " " + fmtShort.format(d);
        const sub = ""; //fmtShort.format(d);
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.flexDirection = 'column';
        wrap.style.alignItems = 'center';
        const main = document.createElement('div');
        main.textContent = label;
        main.style.fontSize = '18px';
        main.style.fontWeight = '800';
        const subEl = document.createElement('div');
        subEl.textContent = sub;
        subEl.style.fontSize = '12px';
        wrap.appendChild(main); wrap.appendChild(subEl);
        return { domNodes: [wrap] };
      },

      events: fcEvents,

      eventContent: function(arg){
        // Title-only (time is in the slot labels); keep bold if important
        const title = document.createElement('div');
        title.className = 'fc-event-title';
        title.textContent = arg.event.title;
        return { domNodes: [title] };
      }
    });
    cal.render();

    // Signal ready
    window.renderReady = true;
  </script>
</body>
</html>`;

  // Write HTML file if debug is enabled
  let htmlPath: string | undefined;
  if (opts.debug) {
    htmlPath = `debug-board.html`;
    await fs.writeFile(htmlPath, html, 'utf8');
    console.log(`> Debug HTML written to: ${htmlPath}`);
  }

  // Launch headless and screenshot the board node
  const browser = await puppeteer.launch({
    browser: "firefox",
    headless: true,
    // Hard prefs injected into the profile on launch:
    extraPrefsFirefox: {
      // Disables text antialiasing
      "gfx.text.disable-aa": true,
      // Keep geometry deterministic
      "layout.css.devPixelsPerPx": "1.0",
      // Optional: reduce rendering variance in CI
      "gfx.webrender.software": true
    }
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width:1304, height:984, deviceScaleFactor:1 });
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForFunction('window.renderReady === true', { timeout: 5000 });

    const board = await page.$("#board");
    if (!board) throw new Error("board element not found");
    const png = await board.screenshot({ type: "png" }) as Buffer;

    if (opts.debug) {
      const pngPath = `debug-board.png`;
      await fs.writeFile(pngPath, png);
      console.log(`> Debug PNG written to: ${pngPath}`);
    }

    return png;
  } finally {
    await browser.close();
  }

  function escapeHtml(s: string){
    return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]!));
  }
}
