// scripts/updateKnowledge.js — Node ≥ 18

import { mkdir, writeFile } from 'fs/promises';

/* ───── Config ───── */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const HEADERS = {
  'User-Agent': 'n8n-knowledge-bot',
  ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
  Accept: 'application/vnd.github+json',
};

const GH_CORE_DIR =
  'https://api.github.com/repos/n8n-io/n8n/contents/packages/nodes-base/nodes';

const GH_TOPIC = 'n8n-community-node';
const GH_TOPIC_PAGES = 10; // 10 × 100 = 1 000 repos max

const AWESOME_README =
  'https://raw.githubusercontent.com/restyler/awesome-n8n/main/README.md';

const NPMS_QUERIES = [
  'n8n-nodes-',
  'n8n-node-',
  'keywords:n8n-community-node',
  'keywords:n8n',
  '"n8n integration"',
];
const NPMS_SIZE = 250;
const NPMS_PAGES = 6; // 6 * 250 = 1 500 resultaten per query (safe)

const REG_QUERIES = NPMS_QUERIES; // zelfde lijst
const REG_SIZE = 150;
const REG_PAGES = 10; // 1 500 max per query
const REG_BACKOFF_MS = 12_000;

/* ───── Helpers ───── */
let httpCalls = 0;
async function fetchJson(url) {
  httpCalls += 1;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} @ ${url}`);
  return r.json();
}
async function fetchText(url) {
  httpCalls += 1;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} @ ${url}`);
  return r.text();
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const dedupe = (arr) => [...new Set(arr.filter(Boolean))];

/* Pak alleen geloofwaardige n8n‑node‐pakketten */
function filterPackage(name) {
  return /(?:^|\/)n8n[-_]node[s]?[-_/]/i.test(name) // n8n-node-foo
      || /(?:^|\/)n8n[-_]community[-_]/i.test(name) // n8n_community-bar
      || /keywords:n8n/i.test(name);                // keywords match (bij Registry)
}

/* ───── Core nodes ───── */
async function getCoreNodes() {
  const list = await fetchJson(GH_CORE_DIR);
  return list.filter((d) => d.type === 'dir').map((d) => d.name);
}

/* ───── Community – README ───── */
async function communityFromReadme() {
  try {
    const md = await fetchText(AWESOME_README);
    const re =
      /(?:@[\w-]+\/)?n8n[-_](?:node|nodes|community)[\w/-]*/gi;
    return dedupe(md.match(re) || []);
  } catch (e) {
    console.warn('README‑scrape mislukt:', e.message);
    return [];
  }
}

/* ───── Community – npms.io ───── */
async function npmsSearch(query) {
  let results = [];
  for (let page = 0; page < NPMS_PAGES; page += 1) {
    const from = page * NPMS_SIZE;
    const url = `https://api.npms.io/v2/search?size=${NPMS_SIZE}&from=${from}&q=${encodeURIComponent(
      query,
    )}`;
    const data = await fetchJson(url);
    const names =
      data.results?.map((o) => o.package?.name.trim()).filter(Boolean) || [];
    results.push(...names);
    if (names.length < NPMS_SIZE) break;
  }
  return dedupe(results).filter(filterPackage);
}

/* ───── Community – Registry (fallback) ───── */
async function registrySearch(query) {
  let results = [];
  for (let page = 0; page < REG_PAGES; page += 1) {
    const from = page * REG_SIZE;
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(
      query,
    )}&size=${REG_SIZE}&from=${from}`;
    try {
      const data = await fetchJson(url);
      const names =
        data.objects?.map((o) => o.package?.name.trim()).filter(Boolean) || [];
      results.push(...names);
      if (names.length < REG_SIZE) break;
    } catch (err) {
      if (err.message.startsWith('429')) {
        console.log('⏳  429 Registry – back‑off...');
        await sleep(REG_BACKOFF_MS);
        page -= 1; // retry same page
        continue;
      }
      throw err;
    }
  }
  return dedupe(results).filter(filterPackage);
}

/* ───── Community – GitHub topic (paged) ───── */
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

/* ───── Main ───── */
(async () => {
  try {
    /* Core */
    console.log('⏳  Core nodes…');
    const core = await getCoreNodes();
    console.log(`   → ${core.length}`);

    /* Community – README */
    console.log('⏳  README…');
    const readmePkgs = await communityFromReadme();
    console.log(`   → ${readmePkgs.length}`);

    /* Community – npms.io */
    console.log('⏳  npms.io…');
    const npmsPkgs = (
      await Promise.all(NPMS_QUERIES.map(npmsSearch))
    ).flat();
    console.log(`   → ${npmsPkgs.length}`);

    /* Community – GitHub topic */
    console.log('⏳  GitHub topic…');
    const ghPkgs = await communityFromGithubTopic();
    console.log(`   → ${ghPkgs.length}`);

    /* Community – Registry fallback (alleen als npms weinig oplevert) */
    let regPkgs = [];
    if (npmsPkgs.length < 200) {
      console.log('ℹ️  Registry fallback…');
      regPkgs = (await Promise.all(REG_QUERIES.map(registrySearch))).flat();
      console.log(`   → ${regPkgs.length}`);
    }

    /* Merge & dedupe */
    const community = dedupe([
      ...readmePkgs,
      ...npmsPkgs,
      ...ghPkgs,
      ...regPkgs,
    ]);
    const allNodes = dedupe([...core, ...community]).sort();

    /* Output */
    const payload = {
      _generated: new Date().toISOString(),
      coreCount: core.length,
      communityCount: community.length,
      total: allNodes.length,
      httpCalls,
      nodes: allNodes,
      meta: {
        readme: readmePkgs.length,
        npms: npmsPkgs.length,
        githubTopic: ghPkgs.length,
        registry: regPkgs.length,
      },
    };

    await mkdir('data', { recursive: true });
    await writeFile('data/nodes.json', JSON.stringify(payload, null, 2));
    console.log(
      `✅  nodes.json geschreven (${payload.total} totaal – ${payload.communityCount} community, ${httpCalls} HTTP‑calls)`,
    );
  } catch (err) {
    console.error('❌  Scraper‑fout:', err);
    process.exit(1);
  }
})();
