#!/usr/bin/env node
/**
 * Renders assets/generated/{stats,langs,achievements}.svg from live GitHub data.
 *
 * Replaces the third-party card services (github-readme-stats, profile-trophy),
 * which are unreliable free-tier deployments — they served 503/402 on 2026-08-06.
 * Everything here runs in Actions against the GitHub GraphQL API and commits
 * static SVGs, so the profile never depends on someone else's uptime.
 *
 *   GITHUB_TOKEN=... USERNAME=Ayuuu-tech node scripts/build-stats.mjs
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";

const USER = process.env.USERNAME || "Ayuuu-tech";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = "assets/generated";

// With a token we use GraphQL (one round trip, includes private contribution
// counts). Without one — running locally — we fall back to the public REST API
// plus the public contributions calendar, so the cards can always be rebuilt.
const MODE = TOKEN ? "graphql" : "public";

const C = {
  bg0: "#070d1a",
  bg1: "#02040a",
  line: "#38bdf8",
  accent: "#22d3ee",
  accent2: "#38bdf8",
  text: "#e2e8f0",
  muted: "#94a3b8",
  dim: "#64748b",
};

// Language colours: GitHub's own hues are kept for recognisability, but every
// one of them is desaturated toward the blue base so the card stays on-palette.
const LANG_FALLBACK = "#38bdf8";

/**
 * Reveal helpers. Rule for every animation in this file: the element's *base*
 * attribute holds the FINAL state, and the animation only replays the way it
 * got there. A renderer that ignores SMIL (rsvg, thumbnailers, some feed
 * readers) then still shows a complete card instead of a blank one.
 */
const REVEAL = 2; // seconds; the whole card finishes revealing within this
const at = (i) => Math.min(0.05 * i, 0.9); // keyTime where item i starts
const fadeIn = (i) =>
  `<animate attributeName="opacity" values="0;0;1" keyTimes="0;${at(i).toFixed(3)};${Math.min(at(i) + 0.15, 1).toFixed(3)}" dur="${REVEAL}s" begin="0s" fill="freeze"/>`;
const growTo = (attr, i, final) =>
  `<animate attributeName="${attr}" values="0;0;${final};${final}" keyTimes="0;${at(i).toFixed(3)};${Math.min(at(i) + 0.35, 0.999).toFixed(3)};1" dur="${REVEAL}s" begin="0s" fill="freeze"/>`;

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const compact = (n) =>
  n >= 1_000_000 ? (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M"
  : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k"
  : String(n);

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": `${USER}-profile-stats`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

const PROFILE_QUERY = `
query ($login: String!, $after: String) {
  user(login: $login) {
    createdAt
    followers { totalCount }
    following { totalCount }
    contributionsCollection {
      totalCommitContributions
      restrictedContributionsCount
      totalPullRequestContributions
      totalIssueContributions
      totalRepositoryContributions
    }
    pullRequests(states: MERGED) { totalCount }
    issues { totalCount }
    repositories(
      first: 100
      after: $after
      ownerAffiliations: OWNER
      isFork: false
      orderBy: { field: STARGAZERS, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
      totalCount
      nodes {
        name
        stargazerCount
        forkCount
        languages(first: 12, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

async function collect() {
  let after = null;
  let base = null;
  const repos = [];

  do {
    const data = await gql(PROFILE_QUERY, { login: USER, after });
    base ??= data.user;
    repos.push(...data.user.repositories.nodes);
    const page = data.user.repositories.pageInfo;
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);

  const contrib = base.contributionsCollection;

  const colors = new Map();
  const perRepo = repos.map((repo) => {
    const langs = {};
    for (const edge of repo.languages.edges) {
      langs[edge.node.name] = edge.size;
      if (edge.node.color) colors.set(edge.node.name, edge.node.color);
    }
    return langs;
  });

  const languages = [...weighLanguages(perRepo).entries()]
    .map(([name, size]) => ({ name, size, color: colors.get(name) || GH_COLORS[name] || LANG_FALLBACK }))
    .sort((a, b) => b.size - a.size);

  return {
    createdAt: new Date(base.createdAt),
    followers: base.followers.totalCount,
    following: base.following.totalCount,
    commits: contrib.totalCommitContributions + contrib.restrictedContributionsCount,
    prs: contrib.totalPullRequestContributions,
    mergedPrs: base.pullRequests.totalCount,
    issues: base.issues.totalCount,
    repoCount: base.repositories.totalCount,
    stars: repos.reduce((n, r) => n + r.stargazerCount, 0),
    forks: repos.reduce((n, r) => n + r.forkCount, 0),
    languages,
  };
}

/* ---------- token-free fallback ---------- */

const UA = { "User-Agent": `${USER}-profile-stats`, Accept: "application/vnd.github+json" };

async function rest(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers: UA });
  if (!res.ok) throw new Error(`REST ${path} -> ${res.status}`);
  return res.json();
}

/** Total contributions, summed from the public contribution calendar per year. */
async function scrapeContributions(from) {
  let total = 0;
  for (let y = from; y <= new Date().getFullYear(); y++) {
    const res = await fetch(`https://github.com/users/${USER}/contributions?from=${y}-01-01&to=${y}-12-31`, {
      headers: { "User-Agent": UA["User-Agent"], "X-Requested-With": "XMLHttpRequest" },
    });
    if (!res.ok) continue;
    const html = await res.text();
    for (const m of html.matchAll(/data-level="[1-4]"[^>]*>/g)) void m; // levels only mark intensity
    for (const m of html.matchAll(/(?:data-count|id="contribution-graph-legend")[^>]*/g)) void m;
    // The calendar exposes the exact per-day number in the tooltip text.
    for (const m of html.matchAll(/>(\d+)\s+contributions?\s+on/g)) total += Number(m[1]);
  }
  return total;
}

async function collectPublic() {
  const user = await rest(`/users/${USER}`);
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await rest(`/users/${USER}/repos?per_page=100&page=${page}&type=owner&sort=pushed`);
    repos.push(...batch.filter((r) => !r.fork));
    if (batch.length < 100) break;
  }

  const perRepo = [];
  for (const repo of repos) {
    try {
      perRepo.push(await rest(`/repos/${USER}/${repo.name}/languages`));
    } catch {
      /* a repo that vanished mid-run should not fail the whole render */
    }
  }
  const langBytes = weighLanguages(perRepo);

  const createdAt = new Date(user.created_at);
  const commits = await scrapeContributions(createdAt.getFullYear());
  const prs = await rest(`/search/issues?q=author:${USER}+type:pr&per_page=1`).catch(() => ({ total_count: 0 }));
  const merged = await rest(`/search/issues?q=author:${USER}+type:pr+is:merged&per_page=1`).catch(() => ({ total_count: 0 }));
  const issues = await rest(`/search/issues?q=author:${USER}+type:issue&per_page=1`).catch(() => ({ total_count: 0 }));

  return {
    createdAt,
    followers: user.followers,
    following: user.following,
    commits,
    prs: prs.total_count,
    mergedPrs: merged.total_count,
    issues: issues.total_count,
    repoCount: repos.length,
    stars: repos.reduce((n, r) => n + r.stargazers_count, 0),
    forks: repos.reduce((n, r) => n + r.forks_count, 0),
    languages: [...langBytes.entries()]
      .map(([name, size]) => ({ name, size, color: GH_COLORS[name] || LANG_FALLBACK }))
      .sort((a, b) => b.size - a.size),
  };
}

/**
 * Languages whose byte counts measure generated output, not authored code:
 * notebook blobs and vendored/exported markup routinely run to tens of MB and
 * would otherwise bury every language actually written by hand.
 */
const EXCLUDED_LANGS = new Set(["Jupyter Notebook", "Roff", "TeX"]);

/**
 * Each repository gets one equal vote, split across its own languages, rather
 * than every repo contributing raw bytes. Without this a single data-heavy
 * repo decides the whole chart — here one repo held 41 MB of notebook output
 * and 28 MB of generated HTML, which alone read as 96% of the profile.
 */
function weighLanguages(perRepo) {
  const score = new Map();
  for (const langs of perRepo) {
    const entries = Object.entries(langs).filter(([name]) => !EXCLUDED_LANGS.has(name));
    const total = entries.reduce((n, [, size]) => n + size, 0);
    if (!total) continue;
    for (const [name, size] of entries) {
      score.set(name, (score.get(name) ?? 0) + size / total);
    }
  }
  return score;
}

/** Language colours for the REST path, which does not return them. */
const GH_COLORS = {
  Java: "#b07219", Python: "#3572A5", JavaScript: "#f1e05a", TypeScript: "#3178c6",
  Dart: "#00B4AB", HTML: "#e34c26", CSS: "#563d7c", SCSS: "#c6538c", Shell: "#89e051",
  C: "#555555", "C++": "#f34b7d", "C#": "#178600", Go: "#00ADD8", Rust: "#dea584",
  Kotlin: "#A97BFF", Swift: "#F05138", Ruby: "#701516", PHP: "#4F5D95", Vue: "#41b883",
  Dockerfile: "#384d54", Makefile: "#427819", Jupyter: "#DA5B0B", "Jupyter Notebook": "#DA5B0B",
  Blade: "#f7523f", Handlebars: "#f7931e", EJS: "#a91e50", Procfile: "#a91e50",
};

/* ---------- shared SVG chrome ---------- */

const defs = (id) => `
  <defs>
    <linearGradient id="bg-${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${C.bg0}"/><stop offset="100%" stop-color="${C.bg1}"/>
    </linearGradient>
    <linearGradient id="ttl-${id}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#7dd3fc"/><stop offset="100%" stop-color="${C.accent}"/>
    </linearGradient>
    <linearGradient id="scan-${id}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${C.accent}" stop-opacity="0"/>
      <stop offset="50%" stop-color="${C.accent}" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${C.accent}" stop-opacity="0"/>
    </linearGradient>
    <pattern id="grid-${id}" width="24" height="24" patternUnits="userSpaceOnUse">
      <path d="M24 0H0V24" fill="none" stroke="${C.line}" stroke-opacity="0.06"/>
    </pattern>
    <filter id="glow-${id}" x="-30%" y="-40%" width="160%" height="200%">
      <feGaussianBlur stdDeviation="2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`;

const frame = (id, w, h, title, subtitle, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
${defs(id)}
  <g font-family="'JetBrains Mono','SFMono-Regular',Consolas,monospace">
    <rect width="${w}" height="${h}" rx="18" fill="url(#bg-${id})"/>
    <rect width="${w}" height="${h}" rx="18" fill="url(#grid-${id})"/>

    <text x="26" y="36" font-family="'Segoe UI',Inter,Helvetica,Arial,sans-serif" font-size="17"
          font-weight="700" letter-spacing="3" fill="url(#ttl-${id})" filter="url(#glow-${id})">${esc(title)}</text>
    <text x="${w - 26}" y="36" text-anchor="end" font-size="10" letter-spacing="2" fill="${C.dim}">${esc(subtitle)}</text>
    <line x1="26" y1="50" x2="${w - 26}" y2="50" stroke="${C.line}" stroke-opacity="0.18"/>

${body}

    <rect x="0" y="0" width="160" height="2" fill="url(#scan-${id})">
      <animate attributeName="y" values="0;${h - 2};0" dur="7s" repeatCount="indefinite"/>
      <animate attributeName="x" values="0;${w - 160};0" dur="7s" repeatCount="indefinite"/>
    </rect>
    <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="18" fill="none" stroke="#0ea5e9" stroke-opacity="0.45"/>
  </g>
</svg>
`;

/* ---------- stats card ---------- */

/** Shared so every card agrees on the same denominator. */
const activeYears = (d) => Math.max(1, Math.round((Date.now() - d.createdAt) / 31557600000));

function statsCard(d) {
  const years = activeYears(d);

  // Only surface collaboration counters once there is something to show; a row
  // of zeroes reads worse than a tighter grid of numbers that are actually real.
  const cells = [
    ["TOTAL COMMITS", compact(d.commits)],
    ["REPOSITORIES", compact(d.repoCount)],
    ["STARS EARNED", compact(d.stars)],
    ["FOLLOWERS", compact(d.followers)],
    ["LANGUAGES", compact(d.languages.length)],
    ["YEARS ACTIVE", compact(years)],
    d.prs > 0 ? ["PULL REQUESTS", compact(d.prs)] : ["FORKS", compact(d.forks)],
    d.issues > 0 ? ["ISSUES", compact(d.issues)] : ["COMMITS / YEAR", compact(Math.round(d.commits / years))],
  ];

  const colW = 202;
  const body = cells
    .map((cell, i) => {
      const [label, value] = cell;
      const x = 30 + (i % 4) * colW;
      const y = 96 + Math.floor(i / 4) * 84;
      // Each figure fades in on its own beat so the card reads as booting up.
      return `    <g opacity="1">${fadeIn(i)}
      <text x="${x}" y="${y}" font-family="'Segoe UI',Inter,Helvetica,Arial,sans-serif" font-size="30" font-weight="700" fill="${C.text}">${value}</text>
      <text x="${x}" y="${y + 20}" font-size="10" letter-spacing="1.8" fill="${C.muted}">${label}</text>
      <rect x="${x}" y="${y + 30}" width="34" height="2" rx="1" fill="${C.accent}" opacity="0.75"/>
    </g>`;
    })
    .join("\n");

  return frame("st", 860, 250, "CONTRIBUTION TELEMETRY", `@${USER.toUpperCase()} · LIVE`, body);
}

/* ---------- language card ---------- */

function langCard(d) {
  const top = d.languages.slice(0, 8);
  const total = top.reduce((n, l) => n + l.size, 0) || 1;

  const barX = 26;
  const barW = 808;
  let cursor = barX;

  const stacked = top
    .map((l) => {
      const w = Math.max(2, (l.size / total) * barW);
      const seg = `    <rect x="${cursor.toFixed(1)}" y="70" width="${w.toFixed(1)}" height="14" fill="${l.color || LANG_FALLBACK}" opacity="0.9"/>`;
      cursor += w;
      return seg;
    })
    .join("\n");

  const legend = top
    .map((l, i) => {
      const pct = ((l.size / total) * 100).toFixed(1);
      const x = 26 + (i % 2) * 410;
      const y = 122 + Math.floor(i / 2) * 42;
      const w = Math.max(3, (l.size / total) * 340);
      return `    <g opacity="1">${fadeIn(i)}
      <circle cx="${x + 5}" cy="${y - 5}" r="5" fill="${l.color || LANG_FALLBACK}"/>
      <text x="${x + 18}" y="${y - 1}" font-size="12.5" fill="${C.text}">${esc(l.name)}</text>
      <text x="${x + 340}" y="${y - 1}" text-anchor="end" font-size="12.5" fill="${C.accent}">${pct}%</text>
      <rect x="${x + 18}" y="${y + 6}" width="322" height="4" rx="2" fill="#0ea5e9" fill-opacity="0.12"/>
      <rect x="${x + 18}" y="${y + 6}" width="${w.toFixed(1)}" height="4" rx="2" fill="${l.color || LANG_FALLBACK}" opacity="0.85">
        ${growTo("width", i, w.toFixed(1))}
      </rect>
    </g>`;
    })
    .join("\n");

  const rows = Math.ceil(top.length / 2);
  const h = 122 + rows * 42 + 12;
  const body = `    <rect x="${barX}" y="70" width="${barW}" height="14" rx="7" fill="#0b1220"/>
    <g clip-path="url(#langclip)">
${stacked}
    </g>
    <clipPath id="langclip"><rect x="${barX}" y="70" width="${barW}" height="14" rx="7"/></clipPath>
${legend}`;

  return frame("lg", 860, h, "LANGUAGE DISTRIBUTION", "REPO-WEIGHTED · GENERATED OUTPUT EXCLUDED", body);
}

/* ---------- achievements (trophy replacement) ---------- */

function achievements(d) {
  const years = activeYears(d);
  const tier = (n, steps) => steps.filter((s) => n >= s).length;
  const RANKS = ["—", "C", "B", "A", "S", "S+"];

  const items = [
    { label: "COMMITS", value: compact(d.commits), rank: RANKS[tier(d.commits, [1, 100, 500, 2000, 5000])] },
    { label: "REPOSITORIES", value: compact(d.repoCount), rank: RANKS[tier(d.repoCount, [1, 5, 15, 40, 80])] },
    { label: "LANGUAGES", value: compact(d.languages.length), rank: RANKS[tier(d.languages.length, [1, 3, 5, 8, 12])] },
    { label: "COMMITS / YR", value: compact(Math.round(d.commits / years)), rank: RANKS[tier(Math.round(d.commits / years), [1, 100, 400, 900, 1500])] },
    { label: "STARS", value: compact(d.stars), rank: RANKS[tier(d.stars, [1, 10, 50, 200, 1000])] },
    { label: "FOLLOWERS", value: compact(d.followers), rank: RANKS[tier(d.followers, [1, 10, 50, 200, 1000])] },
    { label: "YEARS ACTIVE", value: `${years}`, rank: RANKS[tier(years, [1, 2, 3, 5, 8])] },
  ];

  const w = 118;
  const body = items
    .map((it, i) => {
      const x = 26 + i * w;
      const filled = (138 - 138 * (RANKS.indexOf(it.rank) / 5)).toFixed(1);
      return `    <g opacity="1">${fadeIn(i)}
      <rect x="${x}" y="70" width="104" height="104" rx="14" fill="#0b1220" stroke="${C.line}" stroke-opacity="0.3"/>
      <circle cx="${x + 52}" cy="106" r="22" fill="none" stroke="#0ea5e9" stroke-opacity="0.25" stroke-width="3"/>
      <circle cx="${x + 52}" cy="106" r="22" fill="none" stroke="${C.accent}" stroke-width="3" stroke-linecap="round"
              stroke-dasharray="138" stroke-dashoffset="${filled}" transform="rotate(-90 ${x + 52} 106)">
        <animate attributeName="stroke-dashoffset" values="138;138;${filled};${filled}"
                 keyTimes="0;${at(i).toFixed(3)};${Math.min(at(i) + 0.35, 0.999).toFixed(3)};1"
                 dur="${REVEAL}s" begin="0s" fill="freeze"/>
      </circle>
      <text x="${x + 52}" y="112" text-anchor="middle" font-family="'Segoe UI',Inter,Helvetica,Arial,sans-serif"
            font-size="18" font-weight="700" fill="${C.text}">${it.rank}</text>
      <text x="${x + 52}" y="146" text-anchor="middle" font-size="13" fill="${C.accent}">${it.value}</text>
      <text x="${x + 52}" y="164" text-anchor="middle" font-size="8.5" letter-spacing="1" fill="${C.muted}">${it.label}</text>
    </g>`;
    })
    .join("\n");

  return frame("ac", 860, 200, "ACHIEVEMENT MATRIX", "RANKED C → S+", body);
}

/* ---------- main ---------- */

/**
 * The unauthenticated path costs one request per repository, so a rebuild can
 * hit the 60/hour limit. Cache the last good payload and fall back to it rather
 * than failing the run and leaving the profile with broken images.
 */
const CACHE = `${OUT}/data.json`;

async function load() {
  try {
    const fresh = MODE === "graphql" ? await collect() : await collectPublic();
    await mkdir(OUT, { recursive: true });
    await writeFile(CACHE, JSON.stringify({ ...fresh, cachedAt: new Date().toISOString() }, null, 2));
    return fresh;
  } catch (err) {
    const cached = JSON.parse(await readFile(CACHE, "utf8").catch(() => "null"));
    if (!cached) throw err;
    console.warn(`live fetch failed (${err.message}); rendering from cache of ${cached.cachedAt}`);
    return { ...cached, createdAt: new Date(cached.createdAt) };
  }
}

const data = await load();
await mkdir(OUT, { recursive: true });
await Promise.all([
  writeFile(`${OUT}/stats.svg`, statsCard(data)),
  writeFile(`${OUT}/langs.svg`, langCard(data)),
  writeFile(`${OUT}/achievements.svg`, achievements(data)),
]);

console.log(
  `rendered for @${USER}: ${data.commits} commits, ${data.repoCount} repos, ` +
    `${data.stars} stars, ${data.languages.length} languages`,
);
