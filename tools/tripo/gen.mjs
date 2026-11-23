// node gen.mjs <name> <prompt> [faceLimit]  — Tripo text-to-3D via Atlas Cloud. Key from ATLASCLOUD_API_KEY (never printed).
import { writeFile } from 'node:fs/promises';
const [name, prompt, faces = '4000'] = process.argv.slice(2);
const key = process.env.ATLASCLOUD_API_KEY;
if (!key) { console.error('no key in env'); process.exit(1); }
const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const API = 'https://api.atlascloud.ai/api/v1/model';
const body = {
  model: 'tripo-h3.1/text-to-3d', prompt,
  negative_prompt: 'realistic fur, photorealistic, ground plane, base, pedestal, multiple animals',
  face_limit: Number(faces), texture: true, pbr: false, texture_quality: 'standard', geometry_quality: 'standard',
};
const r = await fetch(`${API}/generateImage`, { method: 'POST', headers: H, body: JSON.stringify(body) });
const j = await r.json();
const id = j?.data?.id ?? j?.id;
if (!id) { console.error('submit failed', r.status, JSON.stringify(j).slice(0, 400)); process.exit(1); }
console.log('submitted', name, id);
const t0 = Date.now();
for (;;) {
  await new Promise((s) => setTimeout(s, 5000));
  const p = await (await fetch(`${API}/prediction/${id}`, { headers: H })).json();
  const d = p?.data ?? p;
  if (d.status === 'failed' || d.error) { console.error('failed', JSON.stringify(d).slice(0, 400)); process.exit(1); }
  if (d.status === 'completed' || d.status === 'succeeded') {
    const urls = [...(d.outputs ?? []), ...((d.files ?? []).map((f) => f.url))].filter((u) => typeof u === 'string');
    console.log('done in', Math.round((Date.now() - t0) / 1000), 's; outputs:', urls.map((u) => u.split('?')[0].split('/').pop()));
    let i = 0;
    for (const u of urls) {
      const ext = (u.split('?')[0].split('.').pop() || 'bin').slice(0, 5);
      const buf = Buffer.from(await (await fetch(u)).arrayBuffer());
      const f = `out/${name}${i ? '_' + i : ''}.${ext}`;
      await writeFile(new URL(f, import.meta.url), buf);
      console.log('saved', f, buf.length, 'bytes');
      i++;
    }
    break;
  }
  if (Date.now() - t0 > 600000) { console.error('timeout', d.status); process.exit(1); }
}
