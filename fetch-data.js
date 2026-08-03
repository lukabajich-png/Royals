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
// Prospect rankings — same manually-maintained snapshot the app uses.
// Update this whenever MLB Pipeline republishes rankings:
//   https://www.mlb.com/milb/prospects/royals
//   https://www.mlb.com/milb/prospects/top100
// Keyed by normalized ("lowercase, no punctuation, accents stripped") full name.
// ---------------------------------------------------------------------------
const PROSPECT_RANKS = {
  "kendry chourio": { orgRank: 1, top100Rank: 65 },
  "josh hammond": { orgRank: 2, top100Rank: 79 },
  "david shields": { orgRank: 3, top100Rank: 97 },
  "angeibel gomez": { orgRank: 4, top100Rank: 99 },
  "blake mitchell": { orgRank: 5, top100Rank: null },
  "ramon ramirez": { orgRank: 6, top100Rank: null },
  "justin lamkin": { orgRank: 7, top100Rank: null },
  "sean gamble": { orgRank: 8, top100Rank: null },
  "yandel ricardo": { orgRank: 9, top100Rank: null },
  "michael lombardi": { orgRank: 10, top100Rank: null },
  "lucas braun": { orgRank: 11, top100Rank: null },
  "drew beam": { orgRank: 12, top100Rank: null },
  "steven zobac": { orgRank: 13, top100Rank: null },
  "felix arronde": { orgRank: 14, top100Rank: null },
  "asbel gonzalez": { orgRank: 15, top100Rank: null },
  "carson roccaforte": { orgRank: 16, top100Rank: null },
  "jaider suarez": { orgRank: 17, top100Rank: null },
  "ramcell medina": { orgRank: 18, top100Rank: null },
  "warren calcano": { orgRank: 19, top100Rank: null },
  "ben kudrna": { orgRank: 20, top100Rank: null },
  "freddy contreras": { orgRank: 21, top100Rank: null },
  "cameron millar": { orgRank: 22, top100Rank: null },
  "blake wolters": { orgRank: 23, top100Rank: null },
  "dennis colleran": { orgRank: 24, top100Rank: null },
  "dennis colleran jr": { orgRank: 24, top100Rank: null },
  "daniel vazquez": { orgRank: 25, top100Rank: null },
  "gavin cross": { orgRank: 26, top100Rank: null },
  "josh hansell": { orgRank: 27, top100Rank: null },
  "frank mozzicato": { orgRank: 28, top100Rank: null },
  "hunter patteson": { orgRank: 29, top100Rank: null },
  "grayson boles": { orgRank: 30, top100Rank: null },
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
  const hittingStat = statsArr.find((s) => s.group?.displayName === "hitting")?.splits?.[0]?.stat;
  const pitchingStat = statsArr.find((s) => s.group?.displayName === "pitching")?.splits?.[0]?.stat;
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
    });
  }
}

async function fetchOneTeamRoster(teamId, teamName, season, sportId) {
  const hydrate = `hydrate=person(stats(type=season,season=${season},sportId=${sportId},group=[hitting,pitching]))`;
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
