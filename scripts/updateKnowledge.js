// scripts/updateKnowledge.js — Node ≥ 18
import { mkdir, writeFile } from 'fs/promises';

/* ───── Config ───── */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_CORE_DIR =
  'https://api.github.com/repos/n8n-io/n8n/contents/packages/nodes-base/nodes';
const GH_TOPIC = 'n8n-community-node';
const GH_TOPIC_PAGES = 10;

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
const NPMS_PAGES = 6;

const REG_QUERIES = NPMS_QUERIES;
const REG_SIZE = 250;
const REG_PAGES = 10;
const REG_BACKOFF_MS = 12_000;

/* ───── Helpers ───── */
let httpCalls = 0;
function buildHeaders(url) {
  const isGitHub = url.includes('api.github.com');
  return {
    'User-Agent': 'n8n-knowledge-bot',
    ...(isGitHub && GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    ...(isGitHub ? { Accept: 'application/vnd.github+json' } : {}),
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dedupe = (arr) => [...new Set(arr.filter(Boolean))];
const filterPackage = (name) =>
  /(?:^|\/)n8n[-_]node[s]?[-_/]/i.test(name) ||
  /(?:^|\/)n8n[-_]community[-_]/i.test(name);

/* ───── Core ───── */
const getCoreNodes = async () =>
  (await fetchJson(GH_CORE_DIR))
    .filter((d) => d.type === 'dir')
    .map((d) => d.name);

/* ───── Community sources ───── */
const communityFromReadme = async () => {
  try {
    const md = await fetchText(AWESOME_README);
    const re = /(?:@[\w-]+\/)?n8n[-_](?:node|nodes|community)[\w/-]*/gi;
    return dedupe(md.match(re) || []);
  } catch (e) {
    console.warn('README‑scrape mislukt:', e.message);
    return [];
  }
};

const npmsSearch = async (q) => {
  let out = [];
  for (let p = 0; p < NPMS_PAGES; p += 1) {
    const url = `https://api.npms.io/v2/search?size=${NPMS_SIZE}&from=${
      p * NPMS_SIZE
    }&q=${encodeURIComponent(q)}`;
    const data = await fetchJson(url);
    const names =
      data.results?.map((o) => o.package?.name.trim()).filter(Boolean) || [];
    out.push(...names);
    if (names.length < NPMS_SIZE) break;
  }
  return dedupe(out).filter(filterPackage);
};

const registrySearch = async (q) => {
  let out = [];
  for (let p = 0; p < REG_PAGES; p += 1) {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(
      q,
    )}&size=${REG_SIZE}&from=${p * REG_SIZE}`;
    try {
      const data = await fetchJson(url);
      const names =
        data.objects?.map((o) => o.package?.name.trim()).filter(Boolean) || [];
      out.push(...names);
      if (names.length < REG_SIZE) break;
    } catch (err) {
      if (err.message.startsWith('429')) {
        console.log('⏳  429 Registry – back‑off…');
        await sleep(REG_BACKOFF_MS);
        p -= 1; // retry
        continue;
      }
      throw err;
    }
  }
  return dedupe(out).filter(filterPackage);
};

const communityFromGithubTopic = async () => {
  let repos = [];
  for (let p = 1; p <= GH_TOPIC_PAGES; p += 1) {
    const url = `https://api.github.com/search/repositories?q=topic:${GH_TOPIC}&per_page=100&page=${p}`;
    const data = await fetchJson(url);
    repos.push(...(data.items || []).map((r) => r.name.trim()));
    if ((data.items || []).length < 100) break;
  }
  return dedupe(repos);
};

/* ───── Main ───── */
(async () => {
  try {
    /* Core */
    console.log('⏳  Core nodes…');
    const core = await getCoreNodes();
    console.log(`   → ${core.length}`);

    /* Sources */
    console.log('⏳  README…');
    const readme = await communityFromReadme();

    console.log('⏳  npms.io…');
    const npms = (await Promise.all(NPMS_QUERIES.map(npmsSearch))).flat();

    console.log('⏳  GitHub topic…');
    const ghTopic = await communityFromGithubTopic();

    let registry = [];
    if (npms.length < 150) {
      console.log('ℹ️  Registry fallback…');
      registry = (await Promise.all(REG_QUERIES.map(registrySearch))).flat();
    }

    const community = dedupe([...readme, ...npms, ...ghTopic, ...registry]);
    const allNodes = dedupe([...core, ...community]).sort();

    /* Write */
    const payload = {
      _generated: new Date().toISOString(),
      coreCount: core.length,
      communityCount: community.length,
      total: allNodes.length,
      httpCalls,
      nodes: allNodes,
      meta: {
        readme: readme.length,
        npms: npms.length,
        githubTopic: ghTopic.length,
        registry: registry.length,
      },
    };
    await mkdir('data', { recursive: true });
    await writeFile('data/nodes.json', JSON.stringify(payload, null, 2));
    console.log(
      `✅  nodes.json (${payload.total} totaal – ${payload.communityCount} community, ${httpCalls} HTTP‑calls)`,
    );
  } catch (err) {
    console.error('❌  Scraper‑fout:', err);
    process.exit(1);
  }
})();
