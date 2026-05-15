const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const ALLOWED_DOMAINS = [
  'tiktok.com', 'instagram.com', 'facebook.com', 'youtube.com', 'youtu.be',
  'linkedin.com', 'fb.watch', 'reels', 'shorts',
];

function isSocialUrl(url: string): boolean {
  if (!url || url === '#') return false;
  return ALLOWED_DOMAINS.some(domain => url.toLowerCase().includes(domain));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { industry, language = 'he' } = await req.json();

    const apiKey = Deno.env.get('PERPLEXITY_API_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'Perplexity API key not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const industryText = industry || 'שיווק דיגיטלי';

    const prompt = `אתה מומחה לטרנדים ויראליים ברשתות החברתיות. מצא בדיוק 10 פוסטים/סרטונים/תמונות ויראליים מהשבוע האחרון בתחום "${industryText}".

⚠️ כללים קריטיים - חובה לקיים:
- חפש אך ורק תוכן מתוך הרשתות החברתיות הבאות: TikTok, Instagram (Reels/Posts/Stories), Facebook (Reels/Posts), YouTube (Shorts/Videos), LinkedIn.
- אסור בתכלית האיסור לכלול קישורים לאתרי חדשות, בלוגים, מגזינים, עיתונים (כמו מעריב, גלובס, ynet, וואלה, TheMarker, Forbes וכו׳). רק תוכן מרשתות חברתיות!
- כל קישור חייב להיות URL ישיר לפוסט/סרטון/ריל ספציפי ברשת חברתית. לא לדף ראשי, לא לפרופיל, לא לחיפוש.
- עדיפות לתוכן ישראלי בעברית. אם אין מספיק, אפשר להוסיף תוכן בינלאומי ויראלי מאותו תחום.
- בדיוק 10 תוצאות - לא פחות ולא יותר.
- רק תוכן שבאמת התפוצץ ויראלית - צפיות גבוהות, שיתופים, תגובות.
- כלול מגוון: גם סרטונים, גם תמונות/קרוסלות, גם Reels וגם Shorts.
- הכל בעברית חוץ משמות פלטפורמות.

לכל טרנד תן:
1. title - כותרת קצרה ומושכת בעברית שמתארת את התוכן
2. description - תיאור בעברית: מה התוכן מראה, למה הוא הצליח, מה הקהל אהב, מי היוצר
3. platform - הפלטפורמה המדויקת: TikTok / Instagram / YouTube / Facebook / LinkedIn
4. url - קישור ישיר לפוסט/סרטון/ריל הספציפי ברשת החברתית (חובה URL אמיתי מהמקורות שלך!)
5. views - מספר צפיות/לייקים/שיתופים משוער
6. content_type - "video" / "image" / "carousel" / "reel" / "short"
7. tip - טיפ קריאייטיבי בעברית: איך ליצור תוכן דומה, מבנה הסרטון, קצב עריכה, טקסטים, CTA, Hook
8. visual_style - תיאור מפורט של הסגנון הויזואלי: צבעים, קומפוזיציה, זוויות צילום, סגנון עריכה, תאורה, טיפוגרפיה, אפקטים, טרנזישנים
9. music_style - סגנון מוזיקה/אודיו: סוג המוזיקה, קצב BPM, אווירה, קריינות, אפקטי סאונד. לתמונות - "ללא"

החזר רק JSON תקין:
{
  "trends": [
    {
      "title": "...",
      "description": "...",
      "platform": "...",
      "url": "https://www.tiktok.com/@user/video/... או https://www.instagram.com/reel/... וכו׳",
      "views": "...",
      "content_type": "video|image|carousel|reel|short",
      "tip": "...",
      "visual_style": "...",
      "music_style": "..."
    }
  ],
  "summary": "סיכום של 2-3 משפטים בעברית על הטרנדים הויראליים ברשתות החברתיות השבוע"
}`;

    console.log('Fetching trends for industry:', industryText);

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          {
            role: 'system',
            content: 'אתה מומחה בתוכן ויראלי ברשתות חברתיות (TikTok, Instagram, YouTube, Facebook, LinkedIn). תמיד תענה ב-JSON תקין בלבד. קריטי מאוד: כל הקישורים חייבים להיות URLs ישירים לפוסטים/סרטונים ברשתות חברתיות בלבד. אסור לכלול קישורים לאתרי חדשות, בלוגים, או מגזינים. השתמש רק בURLים שמגיעים מתוצאות החיפוש שלך ושמפנים לרשתות חברתיות.'
          },
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
      const errText = await response.text();
      console.error('Perplexity API error:', response.status, errText);
      return new Response(
        JSON.stringify({ success: false, error: `Perplexity API error: ${response.status}` }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const citations = data.citations || [];

    // Filter citations to only social media URLs
    const socialCitations = citations.filter((c: string) => isSocialUrl(c));

    let parsed;
    try {
      const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { trends: [], summary: content, raw: true };
    }

    if (parsed.trends && Array.isArray(parsed.trends)) {
      // Replace non-social URLs with social citation URLs
      let citationIdx = 0;
      parsed.trends = parsed.trends.map((trend: any) => {
        const url = trend.url || '';
        if (!isSocialUrl(url)) {
          // Try to find a matching social citation
          if (citationIdx < socialCitations.length) {
            trend.url = socialCitations[citationIdx++];
          } else {
            // Build a search URL as fallback
            const platform = (trend.platform || '').toLowerCase();
            const query = encodeURIComponent(trend.title || '');
            if (platform.includes('tiktok')) {
              trend.url = `https://www.tiktok.com/search?q=${query}`;
            } else if (platform.includes('instagram')) {
              trend.url = `https://www.instagram.com/explore/tags/${query}`;
            } else if (platform.includes('youtube')) {
              trend.url = `https://www.youtube.com/results?search_query=${query}`;
            } else if (platform.includes('facebook')) {
              trend.url = `https://www.facebook.com/search/videos/?q=${query}`;
            } else if (platform.includes('linkedin')) {
              trend.url = `https://www.linkedin.com/search/results/content/?keywords=${query}`;
            }
          }
        }
        return trend;
      });

      // Remove any trends that still have non-social URLs (news sites etc.)
      parsed.trends = parsed.trends.filter((t: any) => {
        const url = (t.url || '').toLowerCase();
        const isNews = ['maariv', 'globes', 'ynet', 'walla', 'themarker', 'calcalist', 'forbes', 'techcrunch', 'bbc', 'cnn'].some(d => url.includes(d));
        return !isNews;
      });

      // Limit to 10
      parsed.trends = parsed.trends.slice(0, 10);
    }

    console.log('Trends fetched successfully, count:', parsed.trends?.length || 0);

    return new Response(
      JSON.stringify({ success: true, ...parsed, citations: socialCitations }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error fetching trends:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to fetch trends';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
