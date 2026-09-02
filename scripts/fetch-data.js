// Pulls live roster/stats data from MLB's public Stats API and writes it to
// data/snapshot.json. Run manually with `node scripts/fetch-data.js`, or on a
// schedule via the GitHub Actions workflow in .github/workflows/update-data.yml.
//
// Requires Node 18+ (built-in fetch). No npm install needed.

const fs = require("fs");
const path = require("path");

const ROYALS_ID = 118;
const SEASON = new Date().getFullYear();

// ---------------------------------------------------------------------------
// "Hot/cold" trend detection — compares each player's last-15-days rate stats
// against their season rate stats. Thresholds are a judgment call (MLB doesn't
// publish an official hot/cold definition), tune freely:
//   - Hitters: OPS swing of 150+ points, on at least 15 recent plate appearances
//   - Pitchers: ERA swing of 1.50+, on at least 5 recent innings pitched
// Below the minimum sample size, a player just shows no trend badge at all
// rather than a noisy one from a handful of games.
// ---------------------------------------------------------------------------
const TREND_WINDOW_DAYS = 15;
const MIN_RECENT_PA = 15;
const MIN_RECENT_IP = 5;
const HOT_OPS_DELTA = 0.15;
const HOT_ERA_DELTA = 1.5;

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
const TREND_START_DATE = isoDateDaysAgo(TREND_WINDOW_DAYS);
const TREND_END_DATE = isoDateDaysAgo(0);

function classifyHitterTrend(seasonStat, recentStat) {
  if (!seasonStat || !recentStat) return null;
  const recentPA = Number(recentStat.plateAppearances ?? 0);
  if (!recentPA || recentPA < MIN_RECENT_PA) return null;
  const seasonOps = parseFloat(seasonStat.ops);
  const recentOps = parseFloat(recentStat.ops);
  if (isNaN(seasonOps) || isNaN(recentOps)) return null;
  const diff = recentOps - seasonOps;
  if (diff >= HOT_OPS_DELTA) return "hot";
  if (diff <= -HOT_OPS_DELTA) return "cold";
  return null;
}

function classifyPitcherTrend(seasonStat, recentStat) {
  if (!seasonStat || !recentStat) return null;
  const recentIp = parseFloat(recentStat.inningsPitched ?? "0");
  if (isNaN(recentIp) || recentIp < MIN_RECENT_IP) return null;
  const seasonEra = parseFloat(seasonStat.era);
  const recentEra = parseFloat(recentStat.era);
  if (isNaN(seasonEra) || isNaN(recentEra)) return null;
  const diff = seasonEra - recentEra; // positive = ERA improved recently
  if (diff >= HOT_ERA_DELTA) return "hot";
  if (diff <= -HOT_ERA_DELTA) return "cold";
  return null;
}

// ---------------------------------------------------------------------------
// Prospect rankings — same manually-maintained snapshot the app uses.
// Update this whenever MLB Pipeline republishes rankings:
//   https://www.mlb.com/milb/prospects/royals
//   https://www.mlb.com/milb/prospects/top100
// Keyed by normalized ("lowercase, no punctuation, accents stripped") full name.
// ---------------------------------------------------------------------------
const PROSPECT_RANKS = {
  "kendry chourio": { orgRank: 1, top100Rank: 54 },
  "josh hammond": { orgRank: 2, top100Rank: 70 },
  "angeibel gomez": { orgRank: 3, top100Rank: 84 },
  "david shields": { orgRank: 4, top100Rank: null },
  "blake mitchell": { orgRank: 5, top100Rank: null },
  "zion rose": { orgRank: 6, top100Rank: null },
  "ramon ramirez": { orgRank: 7, top100Rank: null },
  "justin lamkin": { orgRank: 8, top100Rank: null },
  "taylor rabe": { orgRank: 9, top100Rank: null },
  "sean gamble": { orgRank: 10, top100Rank: null },
  "yandel ricardo": { orgRank: 11, top100Rank: null },
  "jack slightom": { orgRank: 12, top100Rank: null },
  "michael lombardi": { orgRank: 13, top100Rank: null },
  "steven zobac": { orgRank: 14, top100Rank: null },
  "asbel gonzalez": { orgRank: 15, top100Rank: null },
  "lucas braun": { orgRank: 16, top100Rank: null },
  "carson roccaforte": { orgRank: 17, top100Rank: null },
  "jaider suarez": { orgRank: 18, top100Rank: null },
  "ben kudrna": { orgRank: 19, top100Rank: null },
  "drew beam": { orgRank: 20, top100Rank: null },
  "felix arronde": { orgRank: 21, top100Rank: null },
  "maxx yehl": { orgRank: 22, top100Rank: null },
  "camden johnson": { orgRank: 23, top100Rank: null },
  "warren calcano": { orgRank: 24, top100Rank: null },
  "freddy contreras": { orgRank: 25, top100Rank: null },
  "ramcell medina": { orgRank: 26, top100Rank: null },
  "dominic battista": { orgRank: 27, top100Rank: null },
  "luke pelzer": { orgRank: 28, top100Rank: null },
  "blake wolters": { orgRank: 29, top100Rank: null },
  "lp langevin": { orgRank: 30, top100Rank: null },
};

function normalizeName(name = "") {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, "")
    .trim();
}

function lookupProspectRank(fullName) {
  return PROSPECT_RANKS[normalizeName(fullName)] || { orgRank: null, top100Rank: null };
}

function slugify(name, id) {
  const base = (name || "unknown")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return `${base}-${id}`;
}

function shortLevelName(sportName = "") {
  const map = {
    "Triple-A": "AAA",
    "Double-A": "AA",
    "High-A": "High-A",
    "Single-A": "Single-A",
    Rookie: "Rookie",
    "Rookie Advanced": "Rookie",
  };
  return map[sportName] || sportName;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB API returned ${res.status} for ${url}`);
  return res.json();
}

async function fetchLevels(season) {
  const [teamRes, affRes] = await Promise.all([
    getJSON(`https://statsapi.mlb.com/api/v1/teams/${ROYALS_ID}?season=${season}`),
    getJSON(`https://statsapi.mlb.com/api/v1/teams/affiliates?teamIds=${ROYALS_ID}&season=${season}`),
  ]);
  const mlbTeam = teamRes.teams?.[0];
  const minorSportIds = new Set([11, 12, 13, 14, 16]);
  const affiliates = (affRes.teams || []).filter((t) => minorSportIds.has(t.sport?.id));

  const bySport = new Map();
  bySport.set(1, {
    sportId: 1,
    sportName: "Major League Baseball",
    shortName: "MLB",
    teams: [{ teamId: ROYALS_ID, teamName: mlbTeam?.name || "Kansas City Royals" }],
  });
  for (const t of affiliates) {
    const sportId = t.sport?.id ?? 999;
    if (!bySport.has(sportId)) {
      bySport.set(sportId, {
        sportId,
        sportName: t.sport?.name || "Affiliate",
        shortName: shortLevelName(t.sport?.name),
        teams: [],
      });
    }
    bySport.get(sportId).teams.push({ teamId: t.id, teamName: t.name });
  }
  const levels = [...bySport.values()];
  levels.sort((a, b) => a.sportId - b.sportId);
  return levels;
}

function pushPlayerRow(entry, teamName, hittersOut, pitchersOut) {
  const person = entry.person || {};
  const posAbbr = entry.position?.abbreviation || "";
  const statsArr = person.stats || [];

  // Each group (hitting/pitching) can carry two split entries now — "season"
  // and "byDateRange" (the trailing-15-days window) — so match on type too,
  // not just group. Matched loosely (via includes) since exact type-name
  // casing/wording isn't something we can verify without live-testing against
  // MLB's API from here.
  function pickStat(groupName, matcher) {
    const entry = statsArr.find(
      (s) =>
        s.group?.displayName === groupName &&
        matcher((s.type?.displayName || s.type?.type || "").toLowerCase())
    );
    return entry?.splits?.[0]?.stat || null;
  }

  const hittingStat = pickStat("hitting", (t) => t.includes("season"));
  const hittingRecent = pickStat("hitting", (t) => t.includes("date") || t.includes("range"));
  const pitchingStat = pickStat("pitching", (t) => t.includes("season"));
  const pitchingRecent = pickStat("pitching", (t) => t.includes("date") || t.includes("range"));

  const { orgRank, top100Rank } = lookupProspectRank(person.fullName);

  const base = {
    id: person.id,
    name: person.fullName || "Unknown",
    profileUrl: `https://www.mlb.com/player/${person.nameSlug || slugify(person.fullName, person.id)}`,
    pos: posAbbr,
    jersey: entry.jerseyNumber || "",
    status: entry.status?.description || "Active",
    team: teamName,
    bats: person.batSide?.code || "",
    throws: person.pitchHand?.code || "",
    orgRank,
    top100Rank,
  };

  if (posAbbr === "P") {
    pitchersOut.push({
      ...base,
      g: pitchingStat?.gamesPlayed ?? null,
      w: pitchingStat?.wins ?? null,
      l: pitchingStat?.losses ?? null,
      sv: pitchingStat?.saves ?? null,
      era: pitchingStat?.era ?? null,
      whip: pitchingStat?.whip ?? null,
      ip: pitchingStat?.inningsPitched ?? null,
      so: pitchingStat?.strikeOuts ?? null,
      hasStats: !!pitchingStat,
      trend: classifyPitcherTrend(pitchingStat, pitchingRecent),
    });
  } else {
    hittersOut.push({
      ...base,
      g: hittingStat?.gamesPlayed ?? null,
      avg: hittingStat?.avg ?? null,
      obp: hittingStat?.obp ?? null,
      slg: hittingStat?.slg ?? null,
      ops: hittingStat?.ops ?? null,
      hr: hittingStat?.homeRuns ?? null,
      rbi: hittingStat?.rbi ?? null,
      sb: hittingStat?.stolenBases ?? null,
      hasStats: !!hittingStat,
      trend: classifyHitterTrend(hittingStat, hittingRecent),
    });
  }
}

async function fetchOneTeamRoster(teamId, teamName, season, sportId) {
  const hydrate =
    `hydrate=person(stats(type=[season,byDateRange],season=${season},sportId=${sportId},` +
    `group=[hitting,pitching],startDate=${TREND_START_DATE},endDate=${TREND_END_DATE}))`;
  const activeData = await getJSON(
    `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active&season=${season}&${hydrate}`
  );
  const activeRoster = activeData.roster || [];
  const activeIds = new Set(activeRoster.map((e) => e.person?.id));

  const hitters = [];
  const pitchers = [];
  for (const entry of activeRoster) pushPlayerRow(entry, teamName, hitters, pitchers);

  const reserveHitters = [];
  const reservePitchers = [];
  try {
    const fullRosterType = sportId === 1 ? "40Man" : "fullRoster";
    const fullData = await getJSON(
      `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=${fullRosterType}&season=${season}&${hydrate}`
    );
    for (const entry of fullData.roster || []) {
      if (activeIds.has(entry.person?.id)) continue;
      const statusDesc = entry.status?.description || "";
      if (/minor/i.test(statusDesc)) continue; // optioned to an affiliate — shows up there instead
      pushPlayerRow(entry, teamName, reserveHitters, reservePitchers);
    }
  } catch {
    // Skip reserve list for this team rather than failing the whole run.
  }

  return { hitters, pitchers, reserveHitters, reservePitchers };
}

async function fetchRoster(teams, season, sportId) {
  const results = await Promise.all(
    teams.map((t) => fetchOneTeamRoster(t.teamId, t.teamName, season, sportId))
  );
  return {
    hitters: results.flatMap((r) => r.hitters),
    pitchers: results.flatMap((r) => r.pitchers),
    reserveHitters: results.flatMap((r) => r.reserveHitters),
    reservePitchers: results.flatMap((r) => r.reservePitchers),
  };
}

async function fetchAllProspects(levels, season) {
  const teamsFlat = levels.flatMap((lv) =>
    lv.teams.map((t) => ({ ...t, sportId: lv.sportId, level: lv.shortName }))
  );
  const results = await Promise.all(
    teamsFlat.map(async (t) => {
      const r = await fetchOneTeamRoster(t.teamId, t.teamName, season, t.sportId);
      const tagLevel = (p) => ({ ...p, level: t.level });
      return {
        hitters: [...r.hitters, ...r.reserveHitters].map(tagLevel),
        pitchers: [...r.pitchers, ...r.reservePitchers].map(tagLevel),
      };
    })
  );
  const hitters = results.flatMap((r) => r.hitters).filter((p) => p.orgRank).sort((a, b) => a.orgRank - b.orgRank);
  const pitchers = results.flatMap((r) => r.pitchers).filter((p) => p.orgRank).sort((a, b) => a.orgRank - b.orgRank);
  return { hitters, pitchers };
}

async function main() {
  console.log(`Fetching Royals org data for ${SEASON} season…`);
  const levels = await fetchLevels(SEASON);

  const levelsWithRosters = await Promise.all(
    levels.map(async (lv) => {
      const roster = await fetchRoster(lv.teams, SEASON, lv.sportId);
      return { ...lv, ...roster };
    })
  );

  const prospects = await fetchAllProspects(levels, SEASON);

  const snapshot = {
    updatedAt: new Date().toISOString(),
    season: SEASON,
    levels: levelsWithRosters,
    prospects,
  };

  const outPath = path.join(__dirname, "..", "data", "snapshot.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`Wrote ${outPath} (${levelsWithRosters.length} levels, ${prospects.hitters.length + prospects.pitchers.length} ranked prospects)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
