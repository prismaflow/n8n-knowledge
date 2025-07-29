// scripts/updateKnowledge.js
import { mkdir, writeFile } from 'fs/promises';

const GH_API = 'https://api.github.com';
const UA      = { 'User-Agent': 'n8n-knowledge-bot' };

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} → ${url}`);
  return res.json();
}

(async () => {
  // 1) Core nodes via GitHub‑API directory‑listing
  const coreDir = await fetchJson(
    `${GH_API}/repos/n8n-io/n8n/contents/packages/nodes-base/nodes`
  );                                           // :contentReference[oaicite:0]{index=0}
  const core    = coreDir.filter(d => d.type === 'dir').map(d => d.name);

  // 2) Community nodes via Awesome‑n8n JSON (→ 2 500+ nodes)
  const communityRaw = await fetchJson(
    'https://raw.githubusercontent.com/restyler/awesome-n8n/main/community_nodes.json'
  );                                           // :contentReference[oaicite:1]{index=1}
  const community    = Array.isArray(communityRaw) ? communityRaw : communityRaw.nodes;

  // 3) Merge & sort
  const allNodes = [...new Set([...core, ...community])].sort();

  // 4) Schrijf uit
  await mkdir('data', { recursive: true });
  const payload = {
    _generated: new Date().toISOString(),
    coreCount: core.length,
    communityCount: community.length,
    total: allNodes.length,
    nodes: allNodes
  };
  await writeFile('data/nodes.json', JSON.stringify(payload, null, 2));
  console.log(`✅  nodes.json refreshed (${payload.total} nodes)`);
})();

