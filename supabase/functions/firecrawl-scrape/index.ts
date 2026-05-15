const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { url, options } = await req.json();
    if (!url) {
      return new Response(JSON.stringify({ success: false, error: 'URL is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let formattedUrl = url.trim();
    if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
      formattedUrl = `https://${formattedUrl}`;
    }

    const apiKey = Deno.env.get('FIRECRAWL_API_KEY');

    // Path A: Firecrawl (full JS rendering, screenshot, branding)
    if (apiKey) {
      console.log('Scraping with Firecrawl:', formattedUrl);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: formattedUrl,
            formats: options?.formats || ['markdown', 'screenshot', 'branding', 'links'],
            onlyMainContent: options?.onlyMainContent ?? false,
            waitFor: options?.waitFor || 5000,
            location: options?.location,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const data = await response.json();
        if (response.ok) {
          console.log('Firecrawl scrape successful');
          return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        console.warn('Firecrawl API error, falling back:', data);
      } catch (fcErr) {
        console.warn('Firecrawl request failed, falling back:', fcErr);
      }
    } else {
      console.warn('FIRECRAWL_API_KEY not configured — using direct fetch fallback');
    }

    // Path B: Direct HTML fetch fallback
    console.log('Direct HTML fetch fallback for:', formattedUrl);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const htmlRes = await fetch(formattedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const html = await htmlRes.text();

      const get = (re: RegExp) => html.match(re)?.[1]?.trim() || '';
      const title    = get(/<title[^>]*>([^<]+)<\/title>/i);
      const desc     = get(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']{0,300})["']/i) || get(/<meta[^>]*content=["']([^"']{0,300})["'][^>]*name=["']description["']/i);
      const ogTitle  = get(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)      || get(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
      const ogDesc   = get(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']{0,400})["']/i) || get(/<meta[^>]*content=["']([^"']{0,400})["'][^>]*property=["']og:description["']/i);
      const ogImage  = get(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)      || get(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
      const favicon  = get(/<link[^>]*rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/i);

      const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 6000);
      const linkMatches = [...html.matchAll(/href=["']([^"'#?]+)["']/gi)];
      const links = [...new Set(linkMatches.map(m => m[1]).filter(l => l.startsWith('/') || l.startsWith(formattedUrl)).map(l => l.startsWith('/') ? new URL(l, formattedUrl).href : l))].slice(0, 20);

      let logoUrl: string | null = ogImage || null;
      if (!logoUrl && favicon) {
        try { logoUrl = favicon.startsWith('http') ? favicon : new URL(favicon, formattedUrl).href; } catch { /* skip */ }
      }

      const markdown = stripped || `כותרת: ${ogTitle || title}\nתיאור: ${ogDesc || desc}`;
      console.log(`Fallback scrape OK — title: "${ogTitle || title}", markdown: ${markdown.length} chars`);

      return new Response(JSON.stringify({
        success: true,
        data: {
          markdown,
          metadata: { title: ogTitle || title, description: ogDesc || desc, ogTitle, ogDescription: ogDesc, ogImage: logoUrl || '', sourceURL: formattedUrl },
          branding: logoUrl ? { logo: logoUrl, colors: {}, fonts: [] } : null,
          links,
          screenshot: null,
        },
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    } catch (fallbackErr) {
      console.error('Both Firecrawl and fallback failed:', fallbackErr);
      return new Response(JSON.stringify({ success: false, error: 'לא ניתן להגיע לאתר — בדוק שהכתובת נכונה ושהאתר פעיל' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

  } catch (error) {
    console.error('firecrawl-scrape error:', error);
    return new Response(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'שגיאה בסריקת האתר' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
