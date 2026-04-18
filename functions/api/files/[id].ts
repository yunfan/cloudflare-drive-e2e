interface Env { MY_BUCKET: R2Bucket; DB: D1Database; }
interface Context { request: Request; env: Env; params: Record<string, string>; }

export async function onRequestGet({ env, params }: Context) {
  const id = params.id;
  const file = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
  if (!file) return new Response('Not found', { status: 404 });
  return new Response(JSON.stringify(file), { headers: { "Content-Type": "application/json" } });
}

export async function onRequestDelete({ env, params }: Context) {
  const fileId = params.id;
  const inodes = await env.DB.prepare('SELECT r2_key FROM inodes WHERE file_id = ?').bind(fileId).all();
  
  // Delete chunks from R2 safely
  const keys = (inodes.results || []).map((row: any) => row.r2_key);
  if (keys.length > 0) {
      await Promise.all(keys.map(k => env.MY_BUCKET.delete(k)));
  }
  
  // Delete from DB (foreign key should cascade but we do it manually to be safe)
  await env.DB.prepare('DELETE FROM inodes WHERE file_id = ?').bind(fileId).run();
  await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(fileId).run();
  
  return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
}
