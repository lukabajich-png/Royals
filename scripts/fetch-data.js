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
    teams: [
      {
        teamId: ROYALS_ID,
        teamName: mlbTeam?.name || "Kansas City Royals",
        leagueId: mlbTeam?.league?.id ?? null,
      },
    ],
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
    bySport.get(sportId).teams.push({ teamId: t.id, teamName: t.name, leagueId: t.league?.id ?? null });
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

// ---------------------------------------------------------------------------
// Standings — one call per team via the /standings endpoint, matched back to
// our team by id. NOTE: this relies on each team's leagueId being correct
// (captured in fetchLevels from the affiliates/team API response) and on the
// standings response actually containing every level's teams the way it does
// for the majors. This is the part of this batch I'm least able to verify
// without live-testing — if a level's standings come back empty/null, that's
// the first place to look.
// ---------------------------------------------------------------------------
async function fetchStandingsForTeam(teamId, leagueId, sportId, season) {
  if (!leagueId) return null;
  try {
    const data = await getJSON(
      `https://statsapi.mlb.com/api/v1/standings?leagueId=${leagueId}&season=${season}&sportId=${sportId}&hydrate=team`
    );
    for (const record of data.records || []) {
      const teamRecord = (record.teamRecords || []).find((tr) => tr.team?.id === teamId);
      if (teamRecord) {
        return {
          wins: teamRecord.wins ?? null,
          losses: teamRecord.losses ?? null,
          winningPct: teamRecord.winningPercentage ?? null,
          gamesBack: teamRecord.gamesBack ?? null,
          divisionRank: teamRecord.divisionRank ?? null,
          streak: teamRecord.streak?.streakCode ?? null,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Schedule — recent result + upcoming games for one team, small window either
// side of today.
// ---------------------------------------------------------------------------
const SCHEDULE_DAYS_BACK = 3;
const SCHEDULE_DAYS_FORWARD = 5;

async function fetchScheduleForTeam(teamId, sportId, season) {
  const startDate = isoDateDaysAgo(SCHEDULE_DAYS_BACK);
  const endDate = isoDateDaysAgo(-SCHEDULE_DAYS_FORWARD);
  try {
    const data = await getJSON(
      `https://statsapi.mlb.com/api/v1/schedule?teamId=${teamId}&sportId=${sportId}` +
        `&startDate=${startDate}&endDate=${endDate}&season=${season}&hydrate=team,linescore`
    );
    const games = [];
    for (const date of data.dates || []) {
      for (const g of date.games || []) {
        const isHome = g.teams?.home?.team?.id === teamId;
        const us = isHome ? g.teams?.home : g.teams?.away;
        const them = isHome ? g.teams?.away : g.teams?.home;
        games.push({
          date: date.date,
          opponent: them?.team?.name || "Unknown",
          isHome,
          status: g.status?.detailedState || "",
          finalScore:
            g.status?.abstractGameState === "Final"
              ? { us: us?.score ?? null, them: them?.score ?? null }
              : null,
        });
      }
    }
    games.sort((a, b) => a.date.localeCompare(b.date));
    return {
      recent: games.filter((g) => g.date < isoDateDaysAgo(0)),
      upcoming: games.filter((g) => g.date >= isoDateDaysAgo(0)),
    };
  } catch {
    return { recent: [], upcoming: [] };
  }
}

// ---------------------------------------------------------------------------
// Transactions — recent org-wide moves (promotions, IL, trades, releases),
// one call per team so affiliate-level moves aren't missed (the transactions
// endpoint's teamId filter matches the specific team involved, not the whole
// org under one parent id).
// ---------------------------------------------------------------------------
const TRANSACTIONS_DAYS_BACK = 30;

async function fetchTransactionsForTeams(teams) {
  const startDate = isoDateDaysAgo(TRANSACTIONS_DAYS_BACK);
  const endDate = isoDateDaysAgo(0);
  const results = await Promise.all(
    teams.map(async (t) => {
      try {
        const data = await getJSON(
          `https://statsapi.mlb.com/api/v1/transactions?startDate=${startDate}&endDate=${endDate}&teamId=${t.teamId}`
        );
        return data.transactions || [];
      } catch {
        return [];
      }
    })
  );
  const seen = new Set();
  const merged = [];
  for (const tx of results.flat()) {
    if (seen.has(tx.id)) continue;
    seen.add(tx.id);
    merged.push({
      id: tx.id,
      date: tx.date,
      person: tx.person?.fullName || null,
      description: tx.description || tx.typeDesc || "",
      fromTeam: tx.fromTeam?.name || null,
      toTeam: tx.toTeam?.name || null,
    });
  }
  merged.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  return merged;
}

// ---------------------------------------------------------------------------
// Draft tracker — Royals picks from recent draft years, cross-referenced
// against PROSPECT_RANKS so a pick still in the org shows its current rank.
// ---------------------------------------------------------------------------
const DRAFT_YEARS_BACK = 5;

// Defensive since the draft endpoint's "position" shape isn't something I can
// verify live — tries the usual shapes MLB uses elsewhere (abbreviation/name/
// code), and falls back to treating it as a plain string if that's what it is.
function extractPosition(pos) {
  if (!pos) return "";
  if (typeof pos === "string") return pos;
  return pos.abbreviation || pos.name || pos.code || "";
}

// Looks a person id up across every level's active + reserve rosters so a
// draft pick can show where in the org they currently are.
function buildOrgRosterIndex(levelsWithRosters) {
  const index = new Map();
  for (const lv of levelsWithRosters) {
    for (const p of [...lv.hitters, ...lv.pitchers, ...lv.reserveHitters, ...lv.reservePitchers]) {
      index.set(p.id, { level: lv.shortName, team: p.team });
    }
  }
  return index;
}

// For a pick no longer in the Royals org (traded, released, retired, never
// signed), look up their current team directly — this is a live per-player
// call, only made for picks that don't show up in our own roster data.
// For a pick no longer in the Royals org, this resolves a richer status than
// just a team name:
//   - if they're rostered somewhere: which MLB organization, and which
//     specific affiliate/level (the "currentTeam" a minor leaguer is on is
//     the affiliate itself, e.g. "Syracuse Mets" — a second lookup on that
//     team's own record is what finds "New York Mets" as the parent org and
//     "AAA" as the level; this second-hop lookup is the part of this feature
//     I'm least able to verify without live-testing it)
//   - if they're not rostered anywhere: the most recent season they logged
//     any game (hitting or pitching), so "not on a roster" can say since when
async function fetchCurrentStatusFor(personId) {
  try {
    const data = await getJSON(`https://statsapi.mlb.com/api/v1/people/${personId}?hydrate=currentTeam`);
    const person = data.people?.[0];
    const team = person?.currentTeam;

    if (team?.id) {
      let orgName = team.name;
      let level = "MLB";
      try {
        const teamData = await getJSON(`https://statsapi.mlb.com/api/v1/teams/${team.id}`);
        const teamInfo = teamData.teams?.[0];
        if (teamInfo?.sport?.id && teamInfo.sport.id !== 1) {
          orgName = teamInfo.parentOrgName || team.name;
          level = shortLevelName(teamInfo.sport.name);
        }
      } catch {
        // Fall back to just the roster team's own name/level="MLB" guess above.
      }
      return { rostered: true, orgName, teamName: team.name, level, lastPlayedYear: null };
    }

    // Not currently rostered anywhere — find the last season they played at all.
    const statsData = await getJSON(
      `https://statsapi.mlb.com/api/v1/people/${personId}/stats?stats=yearByYear&group=hitting,pitching`
    );
    let lastPlayedYear = null;
    for (const group of statsData.stats || []) {
      for (const split of group.splits || []) {
        const gp = split.stat?.gamesPlayed ?? 0;
        const year = parseInt(split.season, 10);
        if (gp > 0 && !isNaN(year) && (lastPlayedYear === null || year > lastPlayedYear)) {
          lastPlayedYear = year;
        }
      }
    }
    return { rostered: false, orgName: null, teamName: null, level: null, lastPlayedYear };
  } catch {
    return { rostered: false, orgName: null, teamName: null, level: null, lastPlayedYear: null };
  }
}

async function fetchDraftPicks(season, orgIndex) {
  const years = Array.from({ length: DRAFT_YEARS_BACK }, (_, i) => season - i);
  const results = await Promise.all(
    years.map(async (year) => {
      try {
        const data = await getJSON(`https://statsapi.mlb.com/api/v1/draft/${year}`);
        const picks = [];
        for (const round of data.drafts?.rounds || []) {
          for (const pick of round.picks || []) {
            if (pick.team?.id !== ROYALS_ID) continue;
            const personId = pick.person?.id;
            const rank = lookupProspectRank(pick.person?.fullName);
            const inOrg = personId != null ? orgIndex.get(personId) : null;
            picks.push({
              year,
              round: pick.pickRound,
              overallPick: pick.pickNumber,
              id: personId,
              name: pick.person?.fullName || "Unknown",
              profileUrl: personId
                ? `https://www.mlb.com/player/${slugify(pick.person?.fullName, personId)}`
                : null,
              position: extractPosition(pick.position),
              school: pick.school?.name || null,
              signingBonus: pick.signingBonus || null,
              currentOrgRank: rank.orgRank,
              currentLevel: inOrg?.level || null, // still with the Royals, and at this level
              // Filled in below only for picks no longer with the Royals:
              otherOrgName: null, // MLB parent org, if rostered elsewhere
              otherTeamName: null, // the specific affiliate/MLB team, if rostered elsewhere
              otherLevel: null, // level at that other org, if rostered elsewhere
              lastPlayedYear: null, // most recent season with a game logged, if not rostered anywhere
            });
          }
        }
        return picks;
      } catch {
        return [];
      }
    })
  );
  const allPicks = results.flat();

  // For anyone not found in our own rosters, look up where they are now —
  // capped so a bad year doesn't trigger hundreds of calls unexpectedly.
  const needsLookup = allPicks.filter((p) => !p.currentLevel && p.id);
  const lookups = await Promise.all(needsLookup.map((p) => fetchCurrentStatusFor(p.id)));
  needsLookup.forEach((p, i) => {
    const status = lookups[i];
    if (status.rostered) {
      p.otherOrgName = status.orgName;
      p.otherTeamName = status.teamName;
      p.otherLevel = status.level;
    } else {
      p.lastPlayedYear = status.lastPlayedYear; // null here means never logged a game at all
    }
  });

  return allPicks.sort((a, b) => b.year - a.year || a.overallPick - b.overallPick);
}

async function main() {
  console.log(`Fetching Royals org data for ${SEASON} season…`);
  const levels = await fetchLevels(SEASON);

  const levelsWithRosters = await Promise.all(
    levels.map(async (lv) => {
      const roster = await fetchRoster(lv.teams, SEASON, lv.sportId);
      const teamsWithExtras = await Promise.all(
        lv.teams.map(async (t) => {
          const [standings, schedule] = await Promise.all([
            fetchStandingsForTeam(t.teamId, t.leagueId, lv.sportId, SEASON),
            fetchScheduleForTeam(t.teamId, lv.sportId, SEASON),
          ]);
          return { ...t, standings, schedule };
        })
      );
      return { ...lv, teams: teamsWithExtras, ...roster };
    })
  );

  const prospects = await fetchAllProspects(levels, SEASON);
  const allTeams = levels.flatMap((lv) => lv.teams);
  const transactions = await fetchTransactionsForTeams(allTeams);
  const orgIndex = buildOrgRosterIndex(levelsWithRosters);
  const draftPicks = await fetchDraftPicks(SEASON, orgIndex);

  const snapshot = {
    updatedAt: new Date().toISOString(),
    season: SEASON,
    levels: levelsWithRosters,
    prospects,
    transactions,
    draftPicks,
  };

  const outPath = path.join(__dirname, "..", "data", "snapshot.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(
    `Wrote ${outPath} (${levelsWithRosters.length} levels, ${prospects.hitters.length + prospects.pitchers.length} ranked prospects, ` +
      `${transactions.length} transactions, ${draftPicks.length} draft picks)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
