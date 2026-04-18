interface Env { KV_STORE: KVNamespace; DB: D1Database; }
interface Context { request: Request; env: Env; params: Record<string, string>; }

async function invalidateCache(env: Env) {
    const listed = await env.KV_STORE.list({ prefix: 'tree_cache_' });
    await Promise.all(listed.keys.map(k => env.KV_STORE.delete(k.name)));
}

export async function onRequestGet({ request, env }: Context) {
  const url = new URL(request.url);
  const parentId = url.searchParams.get('parent');
  
  const cacheKey = `tree_cache_${parentId || 'root'}`;
  let cached = await env.KV_STORE.get(cacheKey);
  if (cached) {
      return new Response(cached, { headers: { "Content-Type": "application/json" } });
  }
  
  const startCondition = parentId ? "parent_id = ?" : "parent_id IS NULL";
  
  // Recursively fetch file tree up to depth 3
  const query = `
    WITH RECURSIVE
      tree(id, name, type, parent_id, size, total_chunks, salt, chunk_prefix, storage_backend, uploaded_at, depth) AS (
        SELECT id, name, type, parent_id, size, total_chunks, salt, chunk_prefix, storage_backend, uploaded_at, 1
        FROM files WHERE ${startCondition}
        UNION ALL
        SELECT f.id, f.name, f.type, f.parent_id, f.size, f.total_chunks, f.salt, f.chunk_prefix, f.storage_backend, f.uploaded_at, t.depth + 1
        FROM files f INNER JOIN tree t ON f.parent_id = t.id
        WHERE t.depth < 3
      )
    SELECT * FROM tree ORDER BY depth ASC, type DESC, uploaded_at DESC;
  `;
  
  let results;
  if (parentId) {
      results = await env.DB.prepare(query).bind(parentId).all();
  } else {
      results = await env.DB.prepare(query).all();
  }
  
  const records = (results.results || []) as any[];
  const resolvedParents = [parentId || null];
  
  for (const rec of records) {
      // If it's a folder fetched at depth 1 or 2, its children were unconditionally fetched due to `< 3` loop.
      if (rec.type === 'folder' && rec.depth < 3) {
          resolvedParents.push(rec.id);
      }
  }
  
  const responseData = JSON.stringify({ items: records, resolvedParents });
  await env.KV_STORE.put(cacheKey, responseData);
  
  return new Response(responseData, { headers: { "Content-Type": "application/json" } });
}

export async function onRequestPost({ request, env }: Context) {
  try {
     const body = await request.json() as any;
     const id = body.id || crypto.randomUUID();
     
     if (body.type === 'folder') {
         await env.DB.prepare(
           'INSERT INTO files (id, name, type, parent_id) VALUES (?, ?, ?, ?)'
         ).bind(id, body.name, 'folder', body.parentId || null).run();
     } else {
         const storageBackend = body.storageBackend || 'KV';
         await env.DB.prepare(
           'INSERT INTO files (id, name, type, parent_id, size, total_chunks, salt, chunk_prefix, storage_backend) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
         ).bind(id, body.name, 'file', body.parentId || null, body.size, body.totalChunks, body.salt, body.chunkPrefix, storageBackend).run();
     }
     
     await invalidateCache(env);
     
     return new Response(JSON.stringify({ success: true, id }), { headers: { "Content-Type": "application/json" } });
  } catch(e) {
     return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
