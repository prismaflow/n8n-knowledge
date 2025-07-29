// scripts/updateKnowledge.js   –   Node ≥18
import { mkdir, writeFile } from 'fs/promises';

const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const HEADERS = {
  'User-Agent': 'n8n-knowledge-bot',
  ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
};

const GH_CONTENTS =
  'https://api.github.com/repos/n8n-io/n8n/contents/packages/nodes-base/nodes';
const GH_TOPIC_SEARCH =
  'https://api.github.com/search/repositories?q=topic:n8n-community-node&per_page=100';
const AWESOME_README =
  'https://raw.githubusercontent.com/restyler/awesome-n8n/main/README.md';

const NPM_TEXT_QUERIES = ['n8n-nodes-', 'n8n-node-'];          // brute‑text
const NPM_KEYWORD_QUERY = 'keywords:n8n-community-node';       // officiële tag
const NPM_PAGE_SIZE = 250;

/* ---------- helpers ---------- */
async function fetchJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} @ ${url}`);
  return r.json();
}
async function fetchText(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} @ ${url}`);
  return r.text();
}

/* ---------- core nodes ---------- */
async function getCoreNodes() {
  const list = await fetchJson(GH_CONTENTS);
  return list.filter((i) => i.type === 'dir').map((i) => i.name);
}

/* ---------- community helpers ---------- */
function dedupe(arr) {
  return [...new Set(arr.filter(Boolean))];
}

/* --- 1) README scrape --- */
async function communityFromReadme() {
  try {
    const md = await fetchText(AWESOME_README);
    const re =
      /(?:@[\w-]+\/)?n8n[-_](?:node|nodes|community)[-\w]+/gi; // ruimer patroon
    return dedupe(md.match(re) || []);
  } catch (e) {
    console.warn('README scrape faalt:', e.message);
    return [];
  }
}

/* --- 2) npm text search (paginated) --- */
async function npmSearchText(q) {
  let from = 0;
  let results = [];
  while (true) {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(
      q,
    )}&size=${NPM_PAGE_SIZE}&from=${from}`;
    const data = await fetchJson(url);
    const names =
      data.objects?.map((o) => o.package?.name.trim()).filter(Boolean) || [];
    results.push(...names);
    if (names.length < NPM_PAGE_SIZE) break; // laatste page
    from += NPM_PAGE_SIZE;
  }
  return results;
}

/* --- 3) GitHub topic search (single call) --- */
async function communityFromGithubTopic() {
  try {
    const data = await fetchJson(GH_TOPIC_SEARCH);
    return data.items?.map((repo) => repo.name.trim()).filter(Boolean) || [];
  } catch (e) {
    console.warn('GitHub topic search faalt:', e.message);
    return [];
  }
}

/* ---------- main ---------- */
(async () => {
  try {
    /* Core */
    console.log('⏳  Core nodes…');
    const core = await getCoreNodes();
    console.log(`   → ${core.length}`);

    /* Community: README */
    console.log('⏳  README…');
    const readmePkgs = await communityFromReadme();
    console.log(`   → ${readmePkgs.length}`);

    /* Community: npm text & keyword search */
    console.log('⏳  npm‑search…');
    let npmPkgs = [];
    for (const q of [...NPM_TEXT_QUERIES, NPM_KEYWORD_QUERY]) {
      const batch = await npmSearchText(q);
      npmPkgs.push(...batch);
    }
    npmPkgs = dedupe(npmPkgs);
    console.log(`   → ${npmPkgs.length}`);

    /* Community: GitHub topic */
    console.log('⏳  GitHub topic…');
    const ghPkgs = await communityFromGithubTopic();
    console.log(`   → ${ghPkgs.length}`);

    /* Combine & dedupe */
    const community = dedupe([...readmePkgs, ...npmPkgs, ...ghPkgs]);
    const allNodes = dedupe([...core, ...community]).sort();

    /* Write file */
    const payload = {
      _generated: new Date().toISOString(),
      coreCount: core.length,
      communityCount: community.length,
      total: allNodes.length,
      nodes: allNodes,
      meta: {
        readme: readmePkgs.length,
        npm: npmPkgs.length,
        githubTopic: ghPkgs.length,
      },
    };

    await mkdir('data', { recursive: true });
    await writeFile('data/nodes.json', JSON.stringify(payload, null, 2));
    console.log(
      `✅  nodes.json (${payload.total} totaal – ${payload.communityCount} community)`,
    );
  } catch (e) {
    console.error('❌  Scraper‑error:', e);
    process.exit(1);
  }
})();
