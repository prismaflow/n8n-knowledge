// scripts/updateKnowledge.js — Node ≥ 18

import { mkdir, writeFile } from 'fs/promises';

/* ───────────── Config ───────────── */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const GH_CORE_DIR_URL =
  'https://api.github.com/repos/n8n-io/n8n/contents/packages/nodes-base/nodes';
const GH_NODES_BASE_PKG_URL =
  'https://api.github.com/repos/n8n-io/n8n/contents/packages/nodes-base/package.json';

const AWESOME_README_RAW =
  'https://raw.githubusercontent.com/restyler/awesome-n8n/main/README.md';

// GitHub topic-zoek (gefixte query)
const GH_TOPIC = 'n8n-community-node';
const GH_TOPIC_PAGES = 10; // max 1000 repos (10×100)

const NPMS_PAGE_SIZE = 250;
const NPMS_MAX_RESULTS = 1200; // per query
const REGISTRY_PAGE_SIZE = 50;
const REGISTRY_BACKOFF_MS = 12_000;

const NPM_TEXT_QUERIES = ['n8n-nodes-', 'n8n-node-'];
const NPM_KEYWORD_QUERY = 'keywords:n8n-community-node';

/* ─────────── Helpers (headers per domein) ─────────── */
let httpCalls = 0;

function buildHeaders(url, extra = {}) {
  const isGitHub = url.includes('api.github.com');
  return {
    'User-Agent': 'n8n-knowledge-bot',
    ...(isGitHub && GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    ...(isGitHub ? { Accept: 'application/vnd.github+json' } : {}),
    ...extra,
  };
}

async function fetchJson(url) {
  httpCalls += 1;
  const res = await fetch(url, { headers: buildHeaders(url) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url}`);
  return res.json();
}

async function fetchText(url) {
  httpCalls += 1;
  const res = await fetch(url, { headers: buildHeaders(url) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url}`);
  return res.text();
}

async function postJson(url, bodyObj) {
  httpCalls += 1;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(url, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(bodyObj),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dedupe = (arr) => [...new Set(arr.filter(Boolean))];

/* Concurrency helper */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array(Math.min(limit, items.length))
    .fill(0)
    .map(async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          results[idx] = await fn(items[idx], idx);
        } catch (e) {
          results[idx] = undefined;
        }
      }
    });
  await Promise.all(workers);
  return results;
}

/* ─────────── Core nodes: lijst + typeVersion ─────────── */
async function getCoreDirectoryEntries() {
  // Returns array of objects from Contents API for /nodes (each dir = node)
  return fetchJson(GH_CORE_DIR_URL);
}

function downloadUrlFromContentJson(json) {
  return json.download_url; // raw content URL
}

function extractSlugAndVersionFromNodeFile(tsOrJsSource) {
  // slug: description.name: 'slack'  (binnen description-blok)
  const slugMatch = tsOrJsSource.match(
    /description\s*:\s*{[\s\S]*?\bname\s*:\s*['"]([^'"]+)['"]/,
  );
  const slug = slugMatch ? slugMatch[1].trim() : undefined;

  // version: 1  of  [1,2,3]
  let latest;
  const arrMatch = tsOrJsSource.match(/version\s*:\s*\[([^\]]+)\]/);
  if (arrMatch) {
    const nums = (arrMatch[1].match(/\d+/g) || []).map((n) => parseInt(n, 10));
    if (nums.length) latest = Math.max(...nums);
  }
  if (!latest) {
    const single = tsOrJsSource.match(/version\s*:\s*(\d+)/);
    if (single) latest = parseInt(single[1], 10);
  }
  return { slug, latest };
}

async function getCoreTypeVersions() {
  const dirs = await getCoreDirectoryEntries(); // [{name, type:'dir', url, ...}, ...]
  const dirOnly = dirs.filter((d) => d.type === 'dir');

  // Voor elk directory: 1) list files, 2) vind *.node.ts|js, 3) download en parse
  const perDir = await mapLimit(dirOnly, 10, async (d) => {
    const listing = await fetchJson(d.url);
    const nodeFile =
      listing.find((f) => /\.node\.(ts|js)$/i.test(f.name)) ||
      listing.find((f) => /\.node\.ts$/i.test(f.name)) ||
      listing.find((f) => /\.node\.js$/i.test(f.name));
    if (!nodeFile) return undefined;

    const rawUrl = downloadUrlFromContentJson(nodeFile);
    const source = await fetchText(rawUrl);
    const { slug, latest } = extractSlugAndVersionFromNodeFile(source);
    if (!slug || !latest) return undefined;

    const type = `n8n-nodes-base.${slug}`;
    return { type, version: latest };
  });

  const map = {};
  for (const row of perDir) {
    if (row && row.type && row.version) map[row.type] = row.version;
  }
  return map; // {"n8n-nodes-base.slack": 4, ...}
}

async function getNodesBasePackageVersion() {
  // Fetch contents JSON → download_url → fetch raw package.json
  const meta = await fetchJson(GH_NODES_BASE_PKG_URL);
  const raw = await fetchJson(meta.download_url);
  return raw.version || null;
}

/* ─────────── Community: bronnen ─────────── */
async function communityFromReadme() {
  try {
    const md = await fetchText(AWESOME_README_RAW);
    const re = /(?:@[\w-]+\/)?n8n[-_](?:node|nodes|community)[\w/-]*/gi;
    return dedupe(md.match(re) || []);
  } catch (e) {
    console.warn('README scrape mislukt:', e.message);
    return [];
  }
}

async function communityFromGithubTopic() {
  let repos = [];
  for (let page = 1; page <= GH_TOPIC_PAGES; page += 1) {
    const url = `https://api.github.com/search/repositories?q=topic:${GH_TOPIC}&per_page=100&page=${page}`;
    const data = await fetchJson(url);
    repos.push(...(data.items || []).map((r) => r.name.trim()));
    if ((data.items || []).length < 100) break;
  }
  return dedupe(repos);
}

async function npmSearchNpms(query, max = NPMS_MAX_RESULTS) {
  let from = 0;
  let out = [];
  while (from < max) {
    const url = `https://api.npms.io/v2/search?size=${NPMS_PAGE_SIZE}&from=${from}&q=${encodeURIComponent(
      query,
    )}`;
    const data = await fetchJson(url);
    const names =
      data.results?.map((o) => o.package?.name?.trim()).filter(Boolean) || [];
    out.push(...names);
    if (names.length < NPMS_PAGE_SIZE) break;
    from += NPMS_PAGE_SIZE;
  }
  return dedupe(out);
}

async function npmSearchRegistry(query, max = 900) {
  let from = 0;
  let results = [];
  while (from < max) {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(
      query,
    )}&size=${REGISTRY_PAGE_SIZE}&from=${from}`;
    try {
      const data = await fetchJson(url);
      const names =
        data.objects?.map((o) => o.package?.name?.trim()).filter(Boolean) || [];
      results.push(...names);
      if (names.length < REGISTRY_PAGE_SIZE) break;
      from += REGISTRY_PAGE_SIZE;
    } catch (err) {
      if (String(err.message).startsWith('429')) {
        console.log('⏳  429 Registry – wacht 12s…');
        await sleep(REGISTRY_BACKOFF_MS);
        continue;
      }
      throw err;
    }
  }
  return dedupe(results);
}

/* Batch: laatste npm-versies via npms.io mget (200 per POST) */
async function getNpmLatestVersions(packages) {
  const chunks = [];
  const size = 200;
  for (let i = 0; i < packages.length; i += size) {
    chunks.push(packages.slice(i, i + size));
  }
  const map = {};
  for (const chunk of chunks) {
    // mget accepteert body als array ["pkg1","pkg2",...]
    const data = await postJson('https://api.npms.io/v2/package/mget', chunk);
    for (const [name, info] of Object.entries(data)) {
      const v =
        info?.collected?.metadata?.version ||
        info?.analysis?.versions?.slice(-1)?.[0] ||
        null;
      if (name && v) map[name] = v;
    }
  }
  return map; // {"@scope/n8n-nodes-foo":"2.3.1", ...}
}

/* ─────────── Main ─────────── */
(async () => {
  try {
    /* 1) Core lijst + typeVersion map + package version */
    console.log('⏳  Core nodes…');
    const coreListing = await fetchJson(GH_CORE_DIR_URL);
    const coreDirs = coreListing.filter((d) => d.type === 'dir');
    const coreNames = coreDirs.map((d) => d.name); // bv. ["Slack","Airtable",...]
    console.log(`   → ${coreNames.length}`);

    console.log('⏳  Core typeVersions parsen…');
    const coreTypeVersion = await getCoreTypeVersions();
    const coreTypes = Object.keys(coreTypeVersion); // ["n8n-nodes-base.slack", ...]
    console.log(`   → ${coreTypes.length} typeVersion entries`);

    console.log('⏳  nodes-base package versie…');
    const nodesBasePackage = await getNodesBasePackageVersion();
    console.log(`   → nodes-base@${nodesBasePackage}`);

    /* 2) Community bronnen samenvoegen */
    console.log('⏳  README…');
    const readmePkgs = await communityFromReadme();
    console.log(`   → ${readmePkgs.length}`);

    console.log('⏳  npms.io search…');
    let npmsPkgs = [];
    for (const q of [...NPM_TEXT_QUERIES, NPM_KEYWORD_QUERY]) {
      const batch = await npmSearchNpms(q);
      npmsPkgs.push(...batch);
    }
    npmsPkgs = dedupe(npmsPkgs);
    console.log(`   → ${npmsPkgs.length}`);

    console.log('⏳  GitHub topic…');
    const ghPkgs = await communityFromGithubTopic();
    console.log(`   → ${ghPkgs.length}`);

    let registryPkgs = [];
    if (npmsPkgs.length < 150) {
      console.log('ℹ️  Registry fallback…');
      for (const q of [...NPM_TEXT_QUERIES, NPM_KEYWORD_QUERY]) {
        const batch = await npmSearchRegistry(q);
        registryPkgs.push(...batch);
      }
      registryPkgs = dedupe(registryPkgs);
      console.log(`   → ${registryPkgs.length}`);
    }

    const communityPackages = dedupe([...readmePkgs, ...npmsPkgs, ...ghPkgs, ...registryPkgs]);

    /* 3) Laatste npm-versies voor community (batch mget) */
    console.log('⏳  npm latest versions ophalen (batch)…');
    const communityNpmLatest = await getNpmLatestVersions(communityPackages);

    /* 4) Payload opbouwen (backwards compat + nieuwe velden) */
    const nodes = dedupe([...coreNames, ...communityPackages]).sort();
    const payload = {
      _generated: new Date().toISOString(),
      coreCount: coreNames.length,
      communityCount: communityPackages.length,
      total: nodes.length,
      nodes,                               // legacy: gemengde lijst
      coreTypes,                           // nieuw: array met n8n-nodes-base.<slug>
      communityPackages,                   // nieuw: array met npm package namen
      versions: {
        coreTypeVersion,                   // nieuw: {"n8n-nodes-base.slack":4,...}
        nodesBasePackage,                  // nieuw: "1.47.0"
        communityNpmLatest,                // nieuw: {"@scope/n8n-nodes-foo":"2.3.1",...}
      },
      meta: {
        readme: readmePkgs.length,
        npms: npmsPkgs.length,
        githubTopic: ghPkgs.length,
        registryFallback: registryPkgs.length,
        httpCalls,
      },
    };

    await mkdir('data', { recursive: true });
    await writeFile('data/nodes.json', JSON.stringify(payload, null, 2));
    console.log(
      `✅  nodes.json geschreven — core ${payload.coreCount}, community ${payload.communityCount}, totaal ${payload.total} (HTTP-calls: ${httpCalls})`,
    );
  } catch (err) {
    console.error('❌  Scraper-error:', err);
    process.exit(1);
  }
})();
