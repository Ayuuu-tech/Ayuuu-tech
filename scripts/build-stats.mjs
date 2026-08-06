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

import { writeFile, mkdir } from "node:fs/promises";

const USER = process.env.USERNAME || "Ayuuu-tech";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = "assets/generated";

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

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
  const langBytes = new Map();

  for (const repo of repos) {
    for (const edge of repo.languages.edges) {
      const prev = langBytes.get(edge.node.name) ?? { size: 0, color: edge.node.color };
      prev.size += edge.size;
      prev.color ||= edge.node.color;
      langBytes.set(edge.node.name, prev);
    }
  }

  const languages = [...langBytes.entries()]
    .map(([name, v]) => ({ name, size: v.size, color: v.color || LANG_FALLBACK }))
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

function statsCard(d) {
  const cells = [
    ["TOTAL COMMITS", compact(d.commits)],
    ["PULL REQUESTS", compact(d.prs)],
    ["PRS MERGED", compact(d.mergedPrs)],
    ["ISSUES", compact(d.issues)],
    ["REPOSITORIES", compact(d.repoCount)],
    ["STARS EARNED", compact(d.stars)],
    ["FORKS", compact(d.forks)],
    ["FOLLOWERS", compact(d.followers)],
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

  return frame("lg", 860, h, "LANGUAGE DISTRIBUTION", "BY BYTES · OWNED REPOS", body);
}

/* ---------- achievements (trophy replacement) ---------- */

function achievements(d) {
  const years = Math.max(1, Math.floor((Date.now() - d.createdAt) / 31557600000));
  const tier = (n, steps) => steps.filter((s) => n >= s).length;
  const RANKS = ["—", "C", "B", "A", "S", "S+"];

  const items = [
    { label: "COMMITS", value: compact(d.commits), rank: RANKS[tier(d.commits, [1, 100, 500, 2000, 5000])] },
    { label: "REPOSITORIES", value: compact(d.repoCount), rank: RANKS[tier(d.repoCount, [1, 5, 15, 40, 80])] },
    { label: "PULL REQUESTS", value: compact(d.prs), rank: RANKS[tier(d.prs, [1, 10, 50, 150, 400])] },
    { label: "ISSUES", value: compact(d.issues), rank: RANKS[tier(d.issues, [1, 5, 25, 80, 200])] },
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

const data = await collect();
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
