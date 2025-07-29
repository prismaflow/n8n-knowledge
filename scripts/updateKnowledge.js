// scripts/updateKnowledge.js  –  Node ≥18
import { mkdir, writeFile } from 'fs/promises';

/* ---------- Config ---------- */
const GH_TOKEN = process.env.GITHUB_TOKEN || '';          // token uit workflow‑runner
const HEADERS = {
  'User-Agent': 'n8n-knowledge-bot',
  ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
};

const GH_CONTENTS_URL =
  'https://api.github.com/repos/n8n-io/n8n/contents/packages/nodes-base/nodes';
const AWESOME_README =
  'https://raw.githubusercontent.com/restyler/awesome-n8n/main/README.md';
const NPM_SEARCH =
  'https://registry.npmjs.org/-/v1/search?text=keywords:n8n-community-node&page_size=250';

/* ---------- Helpers ---------- */
async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url}`);
  return res.json();
}
async function fetchText(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url}`);
  return res.text();
}

/* ---------- Core nodes ---------- */
async function getCoreNodes() {
  // Eén call – directory‑listing retourneert alles
  const list = await fetchJson(GH_CONTENTS_URL);
  return list.filter((i) => i.type === 'dir').map((i) => i.name);
}

/* ---------- Community nodes ---------- */
async function getCommunityFromReadme() {
  try {
    const md = await fetchText(AWESOME_README);
    const re = /(?:@[\w-]+\/)?n8n[-_]nodes[\w/-]*/g;
    return [...new Set(md.match(re) || [])];
  } catch (e) {
    console.warn('README‑scrape mislukt:', e.message);
    return [];
  }
}
async function getCommunityFromNpm() {
  try {
    const data = await fetchJson(NPM_SEARCH);
    return (data.objects || []).map((o) => o.package?.name).filter(Boolean);
  } catch (e) {
    console.warn('npm‑search mislukt:', e.message);
    return [];
  }
}

/* ---------- Main ---------- */
(async () => {
  try {
    console.log('⏳  Core nodes ophalen…');
    const core = await getCoreNodes();
    console.log(`   → ${core.length} core‑nodes`);

    console.log('⏳  Community nodes (README)…');
    let community = await getCommunityFromReadme();
    if (community.length < 50) {
      console.log('ℹ️  Fallback naar npm‑API…');
      community = await getCommunityFromNpm();
    }
    console.log(`   → ${community.length} community‑nodes`);

    const nodes = [...new Set([...core, ...community])].sort();

    const payload = {
      _generated: new Date().toISOString(),
      coreCount: core.length,
      communityCount: community.length,
      total: nodes.length,
      nodes,
    };

    await mkdir('data', { recursive: true });
    await writeFile('data/nodes.json', JSON.stringify(payload, null, 2));
    console.log(`✅  nodes.json geschreven (${nodes.length} nodes)`);
  } catch (err) {
    console.error('❌  Fout in scraper:', err);
    // Exit 1 zodat je het ziet, maar commentaar hieronder
    process.exit(1);
  }
})();
