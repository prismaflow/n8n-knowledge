// scripts/updateKnowledge.js   –   Node ≥18

import { mkdir, writeFile } from 'fs/promises';

/* ─────────────────── Config ─────────────────── */
const GH_TOKEN = process.env.GITHUB_TOKEN || '';          // autom. aanwezig in Actions
const HEADERS = {
  'User-Agent': 'n8n-knowledge-bot',
  ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
};

const GH_CORE_CONTENTS =
  'https://api.github.com/repos/n8n-io/n8n/contents/packages/nodes-base/nodes';
const GH_TOPIC_SEARCH =
  'https://api.github.com/search/repositories?q=topic:n8n-community-node&per_page=100';
const AWESOME_README =
  'https://raw.githubusercontent.com/restyler/awesome-n8n/main/README.md';

const NPM_TEXT_QUERIES = ['n8n-nodes-', 'n8n-node-'];
const NPM_KEYWORD_QUERY = 'keywords:n8n-community-node';   // officiële tag
const NPMS_PAGE_SIZE = 250;
const NPMS_MAX_RESULTS = 2400;                             // ± 5 pag., pas aan naar wens
const REGISTRY_PAGE_SIZE = 300;                            // lager = minder kans op 429
const REGISTRY_BACKOFF_MS = 20_000;                        // 12 s wachten bij 429

/* ─────────────────── Helpers ─────────────────── */
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
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const dedupe = (arr) => [...new Set(arr.filter(Boolean))];

/* ─────────────────── Core nodes ─────────────────── */
async function getCoreNodes() {
  const list = await fetchJson(GH_CORE_CONTENTS);
  return list.filter((item) => item.type === 'dir').map((d) => d.name);
}

/* ─────────────────── Community: README ─────────────────── */
async function communityFromReadme() {
  try {
    const md = await fetchText(AWESOME_README);
    const re =
      /(?:@[\w-]+\/)?n8n(?:-|_)(?:node|nodes|community)[\w/-]*/gi;
    return dedupe(md.match(re) || []);
  } catch (e) {
    console.warn('⚠️  README‑scrape mislukt:', e.message);
    return [];
  }
}

/* ─────────────────── Community: npms.io ─────────────────── */
async function npmSearchNpms(query, max = NPMS_MAX_RESULTS) {
  let from = 0;
  let collected = [];
  while (from < max) {
    const url = `https://api.npms.io/v2/search?size=${NPMS_PAGE_SIZE}&from=${from}&q=${encodeURIComponent(
      query,
    )}`;
    const data = await fetchJson(url);
    const names =
      data.results?.map((o) => o.package?.name.trim()).filter(Boolean) || [];
    collected.push(...names);
    if (names.length < NPMS_PAGE_SIZE) break; // laatste pagina
    from += NPMS_PAGE_SIZE;
  }
  return collected;
}

/* ─────────────────── Community: registry fallback ─────────────────── */
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
        data.objects?.map((o) => o.package?.name.trim()).filter(Boolean) || [];
      results.push(...names);
      if (names.length < REGISTRY_PAGE_SIZE) break;
      from += REGISTRY_PAGE_SIZE;
    } catch (err) {
      if (err.message.startsWith('429')) {
        console.log('⏳  429 Registry – wacht 12 s…');
        await sleep(REGISTRY_BACKOFF_MS);
        continue; // zelfde pagina opnieuw
      }
      throw err;
    }
  }
  return results;
}

/* ─────────────────── Community: GitHub topic ─────────────────── */
async function communityFromGithubTopic() {
  try {
    const data = await fetchJson(GH_TOPIC_SEARCH);
    return data.items?.map((repo) => repo.name.trim()).filter(Boolean) || [];
  } catch (e) {
    console.warn('⚠️  GitHub topic‑search mislukt:', e.message);
    return [];
  }
}

/* ─────────────────── Main ─────────────────── */
(async () => {
  try {
    /* Core */
    console.log('⏳  Core nodes ophalen…');
    const core = await getCoreNodes();
    console.log(`   → ${core.length}`);

    /* Community – README */
    console.log('⏳  Community README…');
    const readmePkgs = await communityFromReadme();
    console.log(`   → ${readmePkgs.length}`);

    /* Community – npms.io search */
    console.log('⏳  Community npms.io…');
    let npmsPkgs = [];
    for (const q of [...NPM_TEXT_QUERIES, NPM_KEYWORD_QUERY]) {
      const batch = await npmSearchNpms(q);
      npmsPkgs.push(...batch);
    }
    npmsPkgs = dedupe(npmsPkgs);
    console.log(`   → ${npmsPkgs.length}`);

    /* Community – GitHub topic */
    console.log('⏳  Community GitHub topic…');
    const ghPkgs = await communityFromGithubTopic();
    console.log(`   → ${ghPkgs.length}`);

    /* Fallback – Registry only if very few npms results */
    let registryPkgs = [];
    if (npmsPkgs.length < 150) {
      console.log('ℹ️  Weinig npms‑hits; fallback naar registry (met throttle)…');
      for (const q of [...NPM_TEXT_QUERIES, NPM_KEYWORD_QUERY]) {
        const batch = await npmSearchRegistry(q);
        registryPkgs.push(...batch);
      }
      registryPkgs = dedupe(registryPkgs);
      console.log(`   → ${registryPkgs.length}`);
    }

    const community = dedupe([
      ...readmePkgs,
      ...npmsPkgs,
      ...ghPkgs,
      ...registryPkgs,
    ]);
    const allNodes = dedupe([...core, ...community]).sort();

    /* Output */
    const payload = {
      _generated: new Date().toISOString(),
      coreCount: core.length,
      communityCount: community.length,
      total: allNodes.length,
      nodes: allNodes,
      meta: {
        readme: readmePkgs.length,
        npms: npmsPkgs.length,
        githubTopic: ghPkgs.length,
        registryFallback: registryPkgs.length,
      },
    };

    await mkdir('data', { recursive: true });
    await writeFile('data/nodes.json', JSON.stringify(payload, null, 2));
    console.log(
      `✅  nodes.json geschreven (${payload.total} totaal – ${payload.communityCount} community)`,
    );
  } catch (err) {
    console.error('❌  Scraper‑error:', err);
    process.exit(1); // job rood → makkelijker debuggen
  }
})();
