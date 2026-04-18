interface Env { KV_STORE: KVNamespace; DB: D1Database; }
interface Context { request: Request; env: Env; }

export async function onRequestPut({ request, env }: Context) {
  const url = new URL(request.url);
  const chunkPrefix = url.searchParams.get('prefix');
  const index = parseInt(url.searchParams.get('index') || '0', 10);
  const backend = url.searchParams.get('backend') || 'KV';
  
  // Clean worker proxied logic without tokens
  if (!chunkPrefix) return new Response('Bad Request', { status: 400 });
  if (!request.body) return new Response('Missing body', { status: 400 });

  const kvKey = `${chunkPrefix}_${index}`;
  
  if (backend === 'D1') {
      const buffer = await request.arrayBuffer();
      // Use parameterised query binding to write up to 2MB BLOB per row entirely free from SQL length constraints
      await env.DB.prepare('INSERT INTO d1_chunks (chunk_key, chunk_data) VALUES (?, ?)').bind(kvKey, buffer).run();
  } else {
      await env.KV_STORE.put(kvKey, request.body);
  }
  
  return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet({ request, env }: Context) {
  const url = new URL(request.url);
  const chunkPrefix = url.searchParams.get('prefix');
  const index = parseInt(url.searchParams.get('index') || '0', 10);
  const backend = url.searchParams.get('backend') || 'KV';
  
  if (!chunkPrefix) return new Response('Bad Request', { status: 400 });
  
  let objectStream: any;
  if (backend === 'D1') {
      const row = await env.DB.prepare('SELECT chunk_data FROM d1_chunks WHERE chunk_key = ?').bind(`${chunkPrefix}_${index}`).first();
      if (!row || !row.chunk_data) return new Response('Not found in D1', { status: 404 });
      objectStream = row.chunk_data; // This is a raw ArrayBuffer mapped from the SQLite BLOB
  } else {
      objectStream = await env.KV_STORE.get(`${chunkPrefix}_${index}`, 'stream');
      if (!objectStream) return new Response('Not found in KV', { status: 404 });
  }
  
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  // Instruct caching since we use obfuscated immutable prefix keys
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  
  return new Response(objectStream, { headers });
}
