// TRMNL serverless transform (Node.js 20 runtime).
// Enriches each active incident/maintenance from summary.json with the text of
// its most recent update, which Instatus only publishes via the history feed,
// and with the account's UTC offset at its start for the Vestaboard layout.

const ENTITIES = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#039;": "'", "&amp;": "&" };

// "Aug 31, 21:04:41 GMT+0 - Monitoring - " delimits each update in the feed.
const UPDATE_RE = /(?:^|\s)([A-Z][a-z]{2}\s+\d{1,2},\s+\d{2}:\d{2}:\d{2}\s+GMT[+-]\d+)\s+-\s+([A-Za-z][A-Za-z ]*?)\s+-\s+/g;

function unescape(text) {
  for (const [entity, char] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(char); // &amp; last, so it decodes once
  }
  return text;
}

// Seconds east of UTC in `timeZone` at `date`, or null for an unknown zone.
function utcOffset(date, timeZone) {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName").value; // "GMT-04:00", or "GMT" at zero
    const m = name.match(/([+-])(\d{2}):(\d{2})/);
    return m ? (m[1] === "-" ? -1 : 1) * (m[2] * 3600 + m[3] * 60) : 0;
  } catch (e) {
    return null;
  }
}

// Returns the final update in a run-together RSS description, or null.
function latestUpdate(description) {
  const body = description.replace(/^[\s\S]*?Affected Components:[^\n]*\n/, "");
  const marks = [...body.matchAll(UPDATE_RE)];
  if (!marks.length) return null;
  const last = marks[marks.length - 1];
  return {
    status: last[2].trim(),
    body: body.slice(last.index + last[0].length).split(/\s+/).join(" ").trim().replace(/\.+$/, ""),
  };
}

async function run(input) {
  // Polling supplies /v3/summary.json as IDX_0 (and components.json as IDX_1).
  const summary = input && input.IDX_0;
  if (!summary || !summary.page) return input; // never leave the template without data

  // The feed is enrichment only -- if it fails, entries just lack lastUpdate.
  const updates = {};
  try {
    const rss = await fetch(`${summary.page.url}/history.rss`).then((r) => r.text());
    // Instatus keys history entries by the same id summary.json uses.
    for (const [, item] of rss.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const guid = item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
      const desc = item.match(/<description>([\s\S]*?)<\/description>/);
      if (!guid || !desc) continue;
      const found = latestUpdate(unescape(desc[1]));
      if (found) updates[guid[1].trim().replace(/\/$/, "").split("/").pop()] = found;
    }
  } catch (e) {
    /* leave updates empty */
  }

  // A component can carry an active incident while its own status still reads
  // OPERATIONAL, so neither signal alone is sufficient.
  const components = (input.IDX_1 && input.IDX_1.components) || [];
  const affected = components.filter(
    (c) => c.status !== "OPERATIONAL" || (c.activeIncidents || []).length > 0
  ).length;
  summary.affectedComponents = affected;
  summary.affectedLabel = affected
    ? `${affected} component${affected === 1 ? "" : "s"} affected`
    : null;

  // The Vestaboard layout has no Intl, so it shifts times by these offsets.
  // Each entry carries its own, since a later start can fall after a DST change.
  const timeZone = input.trmnl && input.trmnl.user && input.trmnl.user.time_zone_iana;
  summary.utcOffset = timeZone ? utcOffset(new Date(), timeZone) : null;

  for (const key of ["activeIncidents", "activeMaintenances"]) {
    for (const entry of summary[key] || []) {
      const found = updates[entry.id];
      entry.lastUpdate = found ? found.body : null;
      entry.lastUpdateStatus = found ? found.status : null;
      const start = new Date(entry.started || entry.start);
      entry.utcOffset = timeZone && !isNaN(start) ? utcOffset(start, timeZone) : null;
    }
  }

  return summary;
}
