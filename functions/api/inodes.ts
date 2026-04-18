interface Env { MY_BUCKET: R2Bucket; DB: D1Database; }
interface Context { request: Request; env: Env; params: Record<string, string>; }

export async function onRequestPut({ request, env }: Context) {
  const url = new URL(request.url);
  const fileId = url.searchParams.get('fileId');
  const index = parseInt(url.searchParams.get('index') || '0', 10);
  
  if (!fileId) return new Response('Bad Request', { status: 400 });
  if (!request.body) return new Response('Missing body', { status: 400 });
  
  const r2Key = `inode_${fileId}_${index}`;
  await env.MY_BUCKET.put(r2Key, request.body);
  
  const inodeId = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO inodes (id, file_id, chunk_index, r2_key) VALUES (?, ?, ?, ?)'
  ).bind(inodeId, fileId, index, r2Key).run();
  
  return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet({ request, env }: Context) {
  const url = new URL(request.url);
  const fileId = url.searchParams.get('fileId');
  const index = parseInt(url.searchParams.get('index') || '0', 10);
  
  if (!fileId) return new Response('Bad Request', { status: 400 });
  
  const record = await env.DB.prepare('SELECT r2_key FROM inodes WHERE file_id = ? AND chunk_index = ?').bind(fileId, index).first();
  if (!record || !record.r2_key) return new Response('Not found in DB', { status: 404 });
  
  const object = await env.MY_BUCKET.get(record.r2_key as string);
  if (!object) return new Response('Not found in R2', { status: 404 });
  
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  
  return new Response(object.body as unknown as ReadableStream, { headers });
}
