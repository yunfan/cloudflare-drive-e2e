interface Env { MY_BUCKET: R2Bucket; DB: D1Database; }
interface Context { request: Request; env: Env; params: Record<string, string>; }

export async function onRequestGet({ env }: Context) {
  const { results } = await env.DB.prepare('SELECT * FROM files ORDER BY uploaded_at DESC').all();
  return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
}

export async function onRequestPost({ request, env }: Context) {
  try {
     const body = await request.json() as { id: string, name: string, size: number, totalChunks: number, salt: string };
     await env.DB.prepare(
       'INSERT INTO files (id, name, size, total_chunks, salt) VALUES (?, ?, ?, ?, ?)'
     ).bind(body.id, body.name, body.size, body.totalChunks, body.salt).run();
     
     return new Response(JSON.stringify({ success: true, id: body.id }), { headers: { "Content-Type": "application/json" } });
  } catch(e) {
     return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
