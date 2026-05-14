const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function claudeAPI(system: string, user: string): Promise<string> {
  const KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!KEY) throw new Error("LOVABLE_API_KEY לא מוגדר");
  const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      max_tokens: 2048,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`AI gateway error ${r.status}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "";
}

function extractJSON(text: string): any {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try { return JSON.parse(clean); } catch {}
  const start = clean.indexOf("{");
  if (start !== -1) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < clean.length; i++) {
      const ch = clean[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(clean.slice(start, i + 1)); } catch {} } }
    }
  }
  throw new Error("JSON parse failed");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { platform = "TikTok", category = "כללי", count = 8 } = await req.json();
    const raw = await claudeAPI(
      "אתה מומחה לתוכן ויראלי ברשתות חברתיות בישראל. החזר JSON תקין בלבד.",
      `צור ${count} טרנדים לתוכן וידאו בתחום "${category}" לפלטפורמת ${platform}.
לכל טרנד: title, description, platform, category, visualStyle, contentHook, scriptIdea, engagementScore (7-10), tags (מערך 3-5).
פורמט: {"trends":[{...}]}`
    );
    try {
      return new Response(JSON.stringify(extractJSON(raw)), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch {
      return new Response(JSON.stringify({ trends: [] }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "שגיאה" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
