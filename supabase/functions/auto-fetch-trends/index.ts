import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CATEGORIES = [
  'עולם עסקי וליווי עסקי',
  'נדל"ן',
  'בנייה ואחזקת מבנים',
  'ייבוא ויצוא',
  'טכנולוגיה וצ\'אטבוטים',
  'עמותות ומלכ"רים',
];

const ALLOWED_DOMAINS = [
  'tiktok.com', 'instagram.com', 'facebook.com', 'youtube.com', 'youtu.be',
  'linkedin.com', 'fb.watch',
];

function isSocialUrl(url: string): boolean {
  if (!url || url === '#') return false;
  return ALLOWED_DOMAINS.some(domain => url.toLowerCase().includes(domain));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const perplexityKey = Deno.env.get('PERPLEXITY_API_KEY');
  if (!perplexityKey) {
    return new Response(JSON.stringify({ error: 'Missing PERPLEXITY_API_KEY' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let categoriesToFetch = CATEGORIES;
  try {
    const body = await req.json();
    if (body?.category && body.category !== 'all') {
      categoriesToFetch = [body.category];
    }
  } catch {
    // No body = fetch all categories
  }

  const results: { category: string; count: number }[] = [];

  // Delete trends older than 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('saved_trends').delete().lt('fetched_at', weekAgo);

  for (const category of categoriesToFetch) {
    try {
      console.log(`Fetching trends for: ${category}`);

      await supabase.from('saved_trends').delete().eq('category', category);

      const prompt = `אתה מומחה לתוכן ויראלי ברשתות חברתיות. מצא בדיוק 10 פוסטים/סרטונים/תמונות ויראליים מהשבוע האחרון בתחום "${category}".

⚠️ כללים קריטיים - חובה לקיים:
- חפש אך ורק תוכן מתוך: TikTok, Instagram (Reels/Posts), Facebook (Reels/Posts), YouTube (Shorts/Videos), LinkedIn.
- אסור בתכלית האיסור קישורים לאתרי חדשות, בלוגים, מגזינים, עיתונים (מעריב, גלובס, ynet, וואלה, Forbes וכו׳). רק פוסטים מרשתות חברתיות!
- כל קישור חייב להיות URL ישיר לפוסט/סרטון/ריל ספציפי ברשת חברתית.
- עדיפות לתוכן ישראלי. אם אין מספיק, תוכן בינלאומי ויראלי מאותו תחום.
- בדיוק 10 תוצאות.
- רק תוכן שבאמת ויראלי - צפיות גבוהות, שיתופים, תגובות.
- כלול מגוון: סרטונים, תמונות, Reels, Shorts, קרוסלות.
- הכל בעברית חוץ משמות פלטפורמות.

לכל טרנד:
1. title - כותרת מושכת בעברית
2. description - מה התוכן, למה הצליח, מי היוצר
3. platform - TikTok / Instagram / YouTube / Facebook / LinkedIn
4. url - קישור ישיר לפוסט ברשת החברתית
5. views - צפיות/לייקים משוערים
6. content_type - "video" / "image" / "carousel" / "reel" / "short"
7. tip - טיפ קריאייטיבי: מבנה, קצב, טקסטים, CTA, Hook
8. visual_style - סגנון ויזואלי: צבעים, קומפוזיציה, עריכה, תאורה, אפקטים
9. music_style - מוזיקה/אודיו: סוג, קצב, אווירה, קריינות. לתמונות "ללא"

החזר רק JSON:
{
  "trends": [
    { "title": "...", "description": "...", "platform": "...", "url": "...", "views": "...", "content_type": "...", "tip": "...", "visual_style": "...", "music_style": "..." }
  ],
  "summary": "סיכום קצר בעברית"
}`;

      const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${perplexityKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'sonar-pro',
          messages: [
            { role: 'system', content: 'אתה מומחה בתוכן ויראלי ברשתות חברתיות (TikTok, Instagram, YouTube, Facebook, LinkedIn). תענה ב-JSON תקין בלבד. כל הקישורים חייבים להיות URLs ישירים לפוסטים ברשתות חברתיות. אסור לכלול קישורים לאתרי חדשות או בלוגים.' },
            { role: 'user', content: prompt }
          ],
          search_domain_filter: [
            'tiktok.com', 'instagram.com', 'facebook.com', 'youtube.com',
            'linkedin.com', 'fb.watch',
          ],
          search_recency_filter: 'week',
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        console.error(`Perplexity error for ${category}:`, response.status);
        continue;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';
      const citations = data.citations || [];
      const socialCitations = citations.filter((c: string) => isSocialUrl(c));

      let parsed;
      try {
        const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        console.error(`JSON parse failed for ${category}`);
        continue;
      }

      if (!parsed.trends || !Array.isArray(parsed.trends)) continue;

      // Fix non-social URLs
      let citationIdx = 0;
      parsed.trends = parsed.trends.map((trend: any) => {
        const url = trend.url || '';
        if (!isSocialUrl(url)) {
          if (citationIdx < socialCitations.length) {
            trend.url = socialCitations[citationIdx++];
          } else {
            const platform = (trend.platform || '').toLowerCase();
            const query = encodeURIComponent(trend.title || '');
            if (platform.includes('tiktok')) trend.url = `https://www.tiktok.com/search?q=${query}`;
            else if (platform.includes('instagram')) trend.url = `https://www.instagram.com/explore/tags/${query}`;
            else if (platform.includes('youtube')) trend.url = `https://www.youtube.com/results?search_query=${query}`;
            else if (platform.includes('facebook')) trend.url = `https://www.facebook.com/search/videos/?q=${query}`;
            else if (platform.includes('linkedin')) trend.url = `https://www.linkedin.com/search/results/content/?keywords=${query}`;
          }
        }
        return trend;
      });

      // Filter out any remaining news URLs
      parsed.trends = parsed.trends.filter((t: any) => {
        const url = (t.url || '').toLowerCase();
        return !['maariv', 'globes', 'ynet', 'walla', 'themarker', 'calcalist', 'forbes', 'techcrunch'].some(d => url.includes(d));
      });

      const trendsToSave = parsed.trends.slice(0, 10);

      for (const trend of trendsToSave) {
        const enrichedVisualStyle = [
          trend.visual_style || '',
          trend.music_style ? `🎵 מוזיקה: ${trend.music_style}` : '',
          trend.content_type ? `📦 סוג: ${trend.content_type}` : '',
        ].filter(Boolean).join(' | ');

        const { error } = await supabase.from('saved_trends').insert({
          category,
          title: trend.title || '',
          description: trend.description || '',
          platform: trend.platform || '',
          url: trend.url || '',
          views: trend.views || '',
          tip: trend.tip || '',
          visual_style: enrichedVisualStyle,
          summary: parsed.summary || '',
        });
        if (error) console.error('Insert error:', error.message);
      }

      results.push({ category, count: trendsToSave.length });
      console.log(`Saved ${trendsToSave.length} trends for ${category}`);

    } catch (err) {
      console.error(`Error processing ${category}:`, err);
    }
  }

  return new Response(
    JSON.stringify({ success: true, results }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
