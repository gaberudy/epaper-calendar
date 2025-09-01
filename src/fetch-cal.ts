import ical from "node-ical";
import { DateTime, Interval } from "luxon";

export type EventOut = {
  title: string;
  start: string;        // ISO (UTC); renderer will localize using tz
  end: string;          // ISO (UTC)
  allDay: boolean;
  important: boolean;
  location?: string;
};

export type AllDayItem = {
  title: string;
  important: boolean;
  date: string;  // "YYYY-MM-DD" format
};

/**
 * Load one ICS URL and return events that INTERSECT the given local calendar day.
 * - Expands RRULE/RDATE recurrences
 * - Applies EXDATE and overridden instances (RECURRENCE-ID)
 * - Returns UTC ISO times; pass your tz to the renderer for display
 */
export async function loadIcsForDay(
  icsUrl: string,
  dateISO: string,          // "YYYY-MM-DD" (local day to render)
  tz: string,               // e.g., "America/Denver"
  days: number,             // number of days to load
  opts?: { slotMin?: string; slotMax?: string } // optional trimming like 06:00..22:00
): Promise<{ events: EventOut[]; allDay: AllDayItem[] }> {

  const dayStart = DateTime.fromISO(dateISO, { zone: tz }).startOf("day");
  const dayEnd   = dayStart.plus({ days: days });
  const dayIv    = Interval.fromDateTimes(dayStart, dayEnd);

  const data = await ical.async.fromURL(icsUrl);

  // Node-ical specifics:
  // - Each VEVENT may have: start, end, rrule (RRule), exdate (map), recurrences (map of overrides)
  // - A standalone override (RECURRENCE-ID) appears as a VEVENT with .recurrenceid set; node-ical
  //   also places it under the base's .recurrences map keyed by ISO string of the original occurrence.

  const out: EventOut[] = [];
  const allDay: AllDayItem[] = []
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (!v || v.type !== "VEVENT") continue;

    // If this is a detached override event, skip here; it will be picked via its master’s .recurrences
    if (v.recurrenceid) continue;

    const baseStart = toLuxon(v.start, tz);
    const baseEnd   = toLuxon(v.end ?? v.start, tz);
    const duration  = baseEnd.diff(baseStart);

    // Helper: push one concrete instance if it intersects the day
    const pushInstance = (startLx: DateTime, endLx: DateTime) => {
      // Intersection with the calendar day
      if (!Interval.fromDateTimes(startLx, endLx).overlaps(dayIv)) return;
      const isAllDay = looksAllDay(startLx, endLx);

      if (isAllDay) {
        allDay.push({
          title: v.summary ?? "(no title)",
          important: isImportant(v.summary, v.location),
          date: startLx.toFormat("yyyy-MM-dd"),
        });
      } else {
        const startISO = startLx.toUTC().toISO();
        const endISO = endLx.toUTC().toISO();
        
        if (startISO && endISO) {
          out.push({
            title: v.summary ?? "(no title)",
            start: startISO,
            end: endISO,
            allDay: isAllDay,
            important: isImportant(v.summary, v.location),
            location: v.location || undefined,
          });
        }
      }
    };

    if (v.rrule) {
      // Expand recurrences that fall on this day (inclusive); use UTC boundaries to be safe
      const between = v.rrule.between(
        dayStart.toUTC().toJSDate(),
        dayEnd.minus({ seconds: 1 }).toUTC().toJSDate(),
        true
      );

      for (const dt of between) {
        // Recreate start in local tz with the same wall-clock as the recurrence date + master’s time
        const recStartLocal = DateTime.fromJSDate(dt).setZone(tz);
        let instStart = recStartLocal.set({
          hour: baseStart.hour, minute: baseStart.minute, second: baseStart.second, millisecond: 0
        });
        let instEnd = instStart.plus(duration);

        // Override or EXDATE?
        const key = toIcalDateKey(instStart);
        // Overrides are delivered in v.recurrences keyed by original start key
        const override = v.recurrences && v.recurrences[key];
        if (override) {
          const oStart = toLuxon(override.start, tz);
          const oEnd   = toLuxon(override.end ?? override.start, tz);
          instStart = oStart;
          instEnd   = oEnd;
        } else if (v.exdate && v.exdate[key]) {
          // Skipped occurrence
          continue;
        }
        pushInstance(instStart, instEnd);
      }
    } else {
      // Single (non-recurring) event
      pushInstance(baseStart, baseEnd);
    }
  }

  // Sort by allDay first, then start time
  out.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return new Date(a.start).getTime() - new Date(b.start).getTime();
  });

  return { events: out, allDay };
}

/* ----------------- helpers ----------------- */

function toLuxon(d: Date | string, tz: string): DateTime {
  // node-ical may hand us JS Date or string; normalize to tz-aware DateTime
  const dt = (d instanceof Date) ? DateTime.fromJSDate(d) : DateTime.fromISO(d);
  return dt.setZone(tz);
}

// Node-ical uses ISO strings as keys for exdate/recurrences, but they are the ORIGINAL DTSTART of the instance.
// Normalize to the same shape (UTC ISO without milliseconds).
function toIcalDateKey(dt: DateTime): string {
  const iso = dt.toUTC().toISO({ suppressMilliseconds: true });
  if (!iso) throw new Error("Failed to convert DateTime to ISO string");
  return iso;
}

function looksAllDay(start: DateTime, end: DateTime): boolean {
  // True all-day events are midnight-to-midnight in ICS (DATE values), but we also handle 24h spans
  const dur = end.diff(start, ["hours", "minutes"]).as("hours");
  return (start.hour === 0 && start.minute === 0) &&
         (end.hour   === 0 && end.minute   === 0) &&
         dur >= 23.5;
}

function isImportant(title?: string, location?: string): boolean {
  const titleKeywords = process.env.IMPORTANT_TITLE_KEYWORDS || "flight,doctor,dentist,surgery,pickup,drop off,deadline,meeting,night,practice,game,concert,tournament,presentation,parent teacher,school";
  const locationKeywords = process.env.IMPORTANT_LOCATION_KEYWORDS || "hospital,clinic,airport,court";
  
  const titleRe = new RegExp(`(${titleKeywords.split(',').map(k => k.trim().replace(/\s+/g, '\\s*')).join('|')})`, 'i');
  const locationRe = new RegExp(`(${locationKeywords.split(',').map(k => k.trim()).join('|')})`, 'i');
  
  return !!(title && titleRe.test(title)) || !!(location && locationRe.test(location));
}
