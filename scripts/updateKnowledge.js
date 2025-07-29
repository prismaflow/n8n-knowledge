// scripts/updateKnowledge.js
// Node ≥ 18: fetch is ingebouwd, module‑type = "module" in package.json

import { mkdir, writeFile } from 'fs/promises';

/* ---------- Config ---------- */
const UA_HEADERS = { 'User-Agent': 'n8n-knowledge-bot' };
const GH_API = 'https://api.github.com';
const CORE_REPO = {
  owner: 'n8n-io',
  repo: 'n8n',
  path: 'packages/nodes-base/nodes',
};
const AWESOME_README_RAW =
  'https://raw.githubusercontent.com/restyler/awesome-n8n/main/README.md';
const NPM_SEARCH_ENDPOINT =
  'https://registry.npmjs.org/-/v1/search?text=keywords:n8n-community-node&page_size=250';

/* ---------- Helpers ---------- */

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA_HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: UA_HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url}`);
  return res.text();
}

/**
 * Haal alle directory‑namen op in een GitHub‑map met paginatie.
 */
async function getCoreNodes({ owner, repo, path }) {
  const perPage = 100;
  let page = 1;
  let dirs = [];
  /* eslint-disable no-await-in-loop */
  while (true) {
    const url = `${GH_API}/repos/${owner}/${repo}/contents/${path}?per_page=${perPage}&page=${page}`;
    const batch = await fetchJson(url);
    const names = batch.filter((d) => d.type === 'dir').map((d) => d.name);
    dirs.push(...names);
    if (names.length < perPage) break; // laatste pagina
    page += 1;
  }
  return dirs;
}

/**
 * Parse community‑pakketnamen uit awesome‑n8n‑README.
 */
async function getCommunityFromReadme() {
  try {
    const md = await fetchText(AWESOME_README_RAW);
    const regex = /(?:@[\w-]+\/)?n8n[-_]nodes[\w/-]*/g;
    return [...new Set(md.match(regex) || [])];
  } catch (err) {
    console.warn('⚠️  README‑scrape mislukt:', err.message);
    return [];
  }
}

/**
 * Fallback: haal community‑nodes uit npm‑zoek‑API.
 */
async function getCommunityFromNpm() {
  try {
    const data = await fetchJson(NPM_SEARCH_ENDPOINT);
    const pkgs = data.objects?.map((o) => o.package?.name) || [];
    return pkgs.filter(Boolean);
  } catch (err) {
    console.warn('⚠️  npm‑search mislukt:', err.message);
    return [];
  }
}

/* ---------- Main ---------- */
(async () => {
  try {
    console.log('⏳  Core nodes ophalen…');
    const coreNodes = await getCoreNodes(CORE_REPO);
    console.log(`   → gevonden: ${coreNodes.length}`);

    console.log('⏳  Community nodes (README) ophalen…');
    let communityNodes = await getCommunityFromReadme();
    // Fallback als README weinig of niks oplevert
    if (communityNodes.length < 50) {
      console.log('ℹ️  Fallback naar npm‑zoek‑API…');
      communityNodes = await getCommunityFromNpm();
    }
    console.log(`   → gevonden: ${communityNodes.length}`);

    // Merge en sorteren
    const allNodes = [...new Set([...coreNodes, ...communityNodes])].sort();

    // Output‑payload
    const payload = {
      _generated: new Date().toISOString(),
      coreCount: coreNodes.length,
      communityCount: communityNodes.length,
      total: allNodes.length,
      nodes: allNodes,
    };

    // Schrijf weg
    await mkdir('data', { recursive: true });
    await writeFile('data/nodes.json', JSON.stringify(payload, null, 2));
    console.log(`✅  nodes.json refreshed (${payload.total} nodes)`);

    // Exit netjes
    process.exit(0);
  } catch (err) {
    // Toon fout maar laat workflow NIET falen
    console.error('❌  Onverwachte fout:', err);
    process.exit(0); // exit 0 → GitHub Action blijft groen
  }
})();
