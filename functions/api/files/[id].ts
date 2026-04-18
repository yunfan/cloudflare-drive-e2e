interface Env { KV_STORE: KVNamespace; DB: D1Database; }
interface Context { request: Request; env: Env; params: Record<string, string>; }

export async function onRequestGet({ env, params }: Context) {
  const file = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(params.id).first();
  if (!file) return new Response('Not found', { status: 404 });
  return new Response(JSON.stringify(file), { headers: { "Content-Type": "application/json" } });
}

export async function onRequestDelete({ env, params }: Context) {
  const fileId = params.id;
  
  // Use Recursive CTE to find all descendant files/folders
  const stmt = `
    WITH RECURSIVE
      under_dir(id, type, chunk_prefix, total_chunks, storage_backend) AS (
        SELECT id, type, chunk_prefix, total_chunks, storage_backend FROM files WHERE id = ?
        UNION ALL
        SELECT f.id, f.type, f.chunk_prefix, f.total_chunks, f.storage_backend
        FROM files f INNER JOIN under_dir u ON f.parent_id = u.id
      )
    SELECT * FROM under_dir;
  `;
  
  const results = await env.DB.prepare(stmt).bind(fileId).all();
  if (!results.results || results.results.length === 0) {
      return new Response('Not found', { status: 404 });
  }

  const records = results.results as any[];
  const kvKeys: string[] = [];
  const d1Keys: string[] = [];
  
  for (const rec of records) {
      if (rec.type === 'file' && rec.total_chunks && rec.chunk_prefix) {
          const backend = rec.storage_backend || 'KV';
          for (let i = 0; i < rec.total_chunks; i++) {
              const k = `${rec.chunk_prefix}_${i}`;
              if (backend === 'D1') d1Keys.push(k);
              else kvKeys.push(k);
          }
      }
  }
  
  // Safe batch deletion from CF KV
  if (kvKeys.length > 0) {
      for (let i = 0; i < kvKeys.length; i += 50) {
          const batch = kvKeys.slice(i, i + 50);
          await Promise.all(batch.map(k => env.KV_STORE.delete(k)));
      }
  }

  // Batch deletion from CF D1 BLOBs
  if (d1Keys.length > 0) {
      for (let i = 0; i < d1Keys.length; i += 50) {
         const batch = d1Keys.slice(i, i + 50);
         const placeholders = batch.map(() => '?').join(',');
         await env.DB.prepare(`DELETE FROM d1_chunks WHERE chunk_key IN (${placeholders})`).bind(...batch).run();
      }
  }
  
  // Recursively delete from D1 SQLite
  const ids = records.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  await env.DB.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).bind(...ids).run();
  
  // Invalidate tree cache globally
  const listed = await env.KV_STORE.list({ prefix: 'tree_cache_' });
  await Promise.all(listed.keys.map(k => env.KV_STORE.delete(k.name)));
  
  return new Response(JSON.stringify({ success: true, deletedItems: ids.length, deletedChunks: kvKeys.length + d1Keys.length }), { headers: { "Content-Type": "application/json" } });
}
