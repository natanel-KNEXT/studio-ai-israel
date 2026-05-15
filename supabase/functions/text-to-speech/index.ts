const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const HEBREW_WARNING = "הקול שנבחר לא תומך בעברית בצורה טובה. בחר קול אחר או שנה הגדרות.";

const languageConfig = {
  he: { languageCode: "he", modelId: "eleven_v3" },
  en: { languageCode: "en", modelId: "eleven_multilingual_v2" },
  ar: { languageCode: "ar", modelId: "eleven_multilingual_v2" },
} as const;

type SupportedLanguage = keyof typeof languageConfig;

const resolveLanguage = (text: string, requestedLanguage?: string): SupportedLanguage => {
  if (/[\u0590-\u05FF]/.test(text)) return "he";
  if (requestedLanguage === "he" || requestedLanguage === "en" || requestedLanguage === "ar") {
    return requestedLanguage;
  }
  return "en";
};

const parseProviderErrorBody = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const fetchAvailableModelIds = async (apiKey: string): Promise<Set<string>> => {
  const response = await fetch("https://api.elevenlabs.io/v1/models", {
    headers: { "xi-api-key": apiKey },
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`מודלים לא זמינים: ${response.status} ${raw}`);
  }

  const models = await response.json();
  const modelIds = new Set<string>();
  if (Array.isArray(models)) {
    for (const model of models) {
      if (typeof model?.model_id === "string") modelIds.add(model.model_id);
    }
  }
  return modelIds;
};

const providerErrorResponse = (params: {
  status: number;
  error: string;
  providerError: unknown;
  modelId: string;
  language: string;
}) =>
  new Response(
    JSON.stringify({
      functionName: "text-to-speech",
      provider: "ElevenLabs",
      providerStatus: params.status,
      modelId: params.modelId,
      language: params.language,
      error: params.error,
      providerError: params.providerError,
    }),
    {
      status: params.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { text, voiceId, language } = await req.json();
    const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
    if (!ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY is not configured");
    if (!text?.trim()) {
      return new Response(JSON.stringify({ error: "יש להזין טקסט לקריינות" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const selectedVoiceId = voiceId || "onwK4e9ZLuTAKqWW03F9";
    const selectedLanguage = resolveLanguage(text, language);
    const selectedConfig = languageConfig[selectedLanguage];

    const modelIds = await fetchAvailableModelIds(ELEVENLABS_API_KEY);
    if (!modelIds.has(selectedConfig.modelId)) {
      return providerErrorResponse({
        status: 422,
        error: selectedLanguage === "he" ? HEBREW_WARNING : "המודל שנבחר לא זמין כרגע",
        providerError: {
          code: "model_not_available",
          message: `Model ${selectedConfig.modelId} is not available for this account`,
        },
        modelId: selectedConfig.modelId,
        language: selectedConfig.languageCode,
      });
    }

    const payload = {
      text,
      model_id: selectedConfig.modelId,
      language_code: selectedConfig.languageCode,
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.85,
        use_speaker_boost: true,
        speed: 1,
      },
    };

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      const providerError = parseProviderErrorBody(errorText);
      console.error("ElevenLabs error:", response.status, providerError);

      const unsupportedLanguage =
        typeof providerError === "object" &&
        providerError !== null &&
        "detail" in providerError &&
        typeof (providerError as { detail?: { status?: string } }).detail?.status === "string" &&
        (providerError as { detail?: { status?: string } }).detail?.status === "unsupported_language";

      return providerErrorResponse({
        status: response.status,
        error: unsupportedLanguage ? HEBREW_WARNING : `שגיאה ביצירת קול (${response.status})`,
        providerError,
        modelId: selectedConfig.modelId,
        language: selectedConfig.languageCode,
      });
    }

    const audioBuffer = await response.arrayBuffer();

    return new Response(audioBuffer, {
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/mpeg",
        "x-tts-model": selectedConfig.modelId,
        "x-tts-language": selectedConfig.languageCode,
      },
    });
  } catch (e) {
    console.error("TTS error:", e);
    return new Response(
      JSON.stringify({ functionName: "text-to-speech", error: e instanceof Error ? e.message : "שגיאה לא ידועה" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
