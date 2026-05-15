// Deno.serve used natively
import opentype from "npm:opentype.js@1.3.4";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SHOTSTACK_ENDPOINTS = {
  production: "https://api.shotstack.io/edit/v1",
  stage: "https://api.shotstack.io/edit/stage",
} as const;

const HEBREW_FONT_URLS = [
  "https://raw.githubusercontent.com/openmaptiles/fonts/master/noto-sans/NotoSansHebrew-Regular.ttf",
  "https://cdn.jsdelivr.net/gh/openmaptiles/fonts@noto-sans/NotoSansHebrew-Regular.ttf",
];

type ShotstackEnv = keyof typeof SHOTSTACK_ENDPOINTS;

interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
}

interface SubtitleStyle {
  font?: string;
  fontSize?: number;
  color?: string;
  bgColor?: string;
  borderRadius?: number;
  shadow?: string;
  fontWeight?: number;
  padding?: string;
  // SVG-specific overrides derived from font preset
  strokeColor?: string;
  strokeWidth?: number;
  shadowBlur?: number;
  shadowColor?: string;
  shadowOpacity?: number;
}

interface StickerItem {
  emoji: string;
  position: string;
  startTime: number;
  duration: number;
  scale?: number;
}

interface LogoPlacement {
  xPct: number; // 0-100, left edge as % of contentRect width
  yPct: number; // 0-100, top edge as % of contentRect height
  scalePct: number; // 2-30 (logo width as % of contentRect width)
  opacity: number; // 0-1
}

interface ContentRectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface OutputConfig {
  width: number;
  height: number;
  resolution: string;
}

interface LogoPlacementSummary {
  outputSize: { width: number; height: number };
  contentRectPx: { x: number; y: number; w: number; h: number };
  logoPxX: number;
  logoPxY: number;
  logoPxW: number;
  logoPxH: number;
}

interface ComposeRenderResponse {
  renderId: string | null;
  status: string;
  outputUrl: string | null;
  thumbnailUrl: string | null;
  subtitleCount: number;
  logoPlacementSummary: LogoPlacementSummary | null;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const round2 = (value: number): number => Math.round(value * 100) / 100;

let cachedHebrewFont: any | null = null;
const subtitleAssetUrlCache = new Map<string, string>();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function loadHebrewFont(): Promise<any> {
  if (cachedHebrewFont) return cachedHebrewFont;

  try {
    const localBytes = await Deno.readFile(new URL("./NotoSansHebrew-Regular.ttf", import.meta.url));
    cachedHebrewFont = opentype.parse(toArrayBuffer(localBytes));
    return cachedHebrewFont;
  } catch (error) {
    console.warn("Failed loading bundled Hebrew font, trying fallback URLs", error);
  }

  for (const url of HEBREW_FONT_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      cachedHebrewFont = opentype.parse(toArrayBuffer(bytes));
      return cachedHebrewFont;
    } catch (_) {
      // try next source
    }
  }

  throw new Error("Failed to load Hebrew font for subtitle vector rendering");
}

function formatCodepoint(codepoint: number): string {
  return `U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function getRemovedCodepointReason(codepoint: number): string | null {
  if (codepoint >= 0x0000 && codepoint <= 0x001F) return "control_char";
  if (codepoint === 0x007F) return "control_char";

  if (codepoint === 0x200E || codepoint === 0x200F) return "bidi_mark";
  if (codepoint >= 0x202A && codepoint <= 0x202E) return "bidi_mark";
  if (codepoint >= 0x2066 && codepoint <= 0x2069) return "bidi_mark";

  if (codepoint >= 0x200B && codepoint <= 0x200D) return "zero_width";
  if (codepoint === 0xFEFF) return "zero_width";

  return null;
}

function isRenderableGlyph(char: string, font: any): boolean {
  if (!char) return false;
  if (/\s/u.test(char)) return true;

  try {
    if (typeof font?.charToGlyph !== "function") return true;
    const glyph = font.charToGlyph(char);
    if (!glyph) return false;

    if (glyph.name === ".notdef") return false;

    if (Array.isArray(glyph.unicodes) && glyph.unicodes.length > 0) return true;
    if (Number.isFinite(glyph.unicode)) return true;

    const glyphIndex = Number(glyph.index);
    if (Number.isFinite(glyphIndex) && glyphIndex > 0) return true;

    const path = glyph.getPath?.(0, 0, 10);
    return Array.isArray(path?.commands) && path.commands.length > 0;
  } catch {
    return false;
  }
}

function sanitizeSubtitleText(rawText: string, font: any): { text: string; removedCodepoints: string[] } {
  const normalized = (rawText || "").normalize("NFC");
  const sanitizedChars: string[] = [];
  const removedCodepoints: string[] = [];

  for (const char of normalized) {
    const codepoint = char.codePointAt(0);
    if (!Number.isFinite(codepoint)) continue;

    const removalReason = getRemovedCodepointReason(codepoint as number);
    if (removalReason) {
      removedCodepoints.push(`${formatCodepoint(codepoint as number)}:${removalReason}`);
      continue;
    }

    if (!isRenderableGlyph(char, font)) {
      removedCodepoints.push(`${formatCodepoint(codepoint as number)}:unknown_glyph`);
      continue;
    }

    sanitizedChars.push(char);
  }

  const text = sanitizedChars.join("").replace(/\s+/g, " ").trim();
  return { text, removedCodepoints };
}

function toPathData(commands: any[]): string {
  return commands.map((cmd: any) => {
    if (cmd.type === "M" || cmd.type === "L") return `${cmd.type}${round2(cmd.x)} ${round2(cmd.y)}`;
    if (cmd.type === "C") {
      return `C${round2(cmd.x1)} ${round2(cmd.y1)} ${round2(cmd.x2)} ${round2(cmd.y2)} ${round2(cmd.x)} ${round2(cmd.y)}`;
    }
    if (cmd.type === "Q") return `Q${round2(cmd.x1)} ${round2(cmd.y1)} ${round2(cmd.x)} ${round2(cmd.y)}`;
    if (cmd.type === "Z") return "Z";
    return "";
  }).filter(Boolean).join(" ");
}

function measureRtlTextWidth(text: string, font: any, fontSize: number): number {
  const glyphs = font.stringToGlyphs(text);
  const unitsPerEm = font.unitsPerEm || 1000;

  return glyphs.reduce((sum: number, glyph: any) => {
    const advanceUnits = Number.isFinite(glyph?.advanceWidth) ? glyph.advanceWidth : unitsPerEm;
    return sum + (advanceUnits / unitsPerEm) * fontSize;
  }, 0);
}

function buildRtlPathData(text: string, font: any, fontSize: number, baselineY: number, centerX: number): string {
  const glyphs = font.stringToGlyphs(text);
  const totalWidth = measureRtlTextWidth(text, font, fontSize);
  const unitsPerEm = font.unitsPerEm || 1000;
  let cursor = centerX + totalWidth / 2;
  const pathChunks: string[] = [];

  for (const glyph of glyphs) {
    const advanceUnits = Number.isFinite(glyph?.advanceWidth) ? glyph.advanceWidth : unitsPerEm;
    const advancePx = (advanceUnits / unitsPerEm) * fontSize;
    cursor -= advancePx;

    const path = glyph.getPath(cursor, baselineY, fontSize);
    const d = toPathData(path.commands || []);
    if (d) pathChunks.push(d);
  }

  return pathChunks.join(" ");
}

async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getStorageConfig(): { supabaseUrl: string; serviceKey: string } {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing storage config for subtitle graphic upload");
  }

  return { supabaseUrl, serviceKey };
}

function buildPublicStorageUrl(supabaseUrl: string, objectPath: string): string {
  return `${supabaseUrl}/storage/v1/object/public/media/${objectPath}`;
}

let storageClient: ReturnType<typeof createClient> | null = null;

function getStorageClient() {
  if (storageClient) return storageClient;

  const { supabaseUrl, serviceKey } = getStorageConfig();
  storageClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return storageClient;
}

async function uploadSubtitleSvg(svg: string, objectPath: string): Promise<string> {
  const cached = subtitleAssetUrlCache.get(objectPath);
  if (cached) return cached;

  const supabase = getStorageClient();
  const svgBytes = new TextEncoder().encode(svg);

  const { error } = await supabase.storage
    .from("media")
    .upload(objectPath, svgBytes, {
      contentType: "text/plain",
      upsert: true,
      cacheControl: "31536000",
    });

  if (error) {
    throw new Error(`Failed uploading subtitle overlay (${error.message.slice(0, 120)})`);
  }

  const { data } = supabase.storage.from("media").getPublicUrl(objectPath);
  if (!data?.publicUrl) {
    throw new Error("Failed generating public URL for subtitle overlay");
  }

  subtitleAssetUrlCache.set(objectPath, data.publicUrl);
  return data.publicUrl;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parsePadding(padding: string | undefined): { vertical: number; horizontal: number } {
  if (!padding) return { vertical: 12, horizontal: 28 };
  const tokens = padding
    .split(/\s+/)
    .map((t) => Number.parseFloat(t.replace("px", "")))
    .filter((n) => Number.isFinite(n));

  if (tokens.length === 1) {
    return { vertical: tokens[0], horizontal: tokens[0] };
  }
  if (tokens.length >= 2) {
    return { vertical: tokens[0], horizontal: tokens[1] };
  }
  return { vertical: 12, horizontal: 28 };
}

function wrapText(text: string, maxCharsPerLine: number, maxLines = 3): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }

    const next = `${current} ${word}`;
    if (next.length <= maxCharsPerLine) {
      current = next;
      continue;
    }

    lines.push(current);
    current = word;

    if (lines.length >= maxLines - 1) {
      break;
    }
  }

  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  // Hard split for very long single tokens (e.g. no spaces)
  if (lines.length === 1 && lines[0].length > maxCharsPerLine) {
    const hard: string[] = [];
    for (let i = 0; i < lines[0].length && hard.length < maxLines; i += maxCharsPerLine) {
      hard.push(lines[0].slice(i, i + maxCharsPerLine));
    }
    return hard;
  }

  return lines.slice(0, maxLines);
}

function buildSubtitleHtmlAsset(
  text: string,
  style: SubtitleStyle,
  width: number,
  height: number,
): string {
  const fontSize = style.fontSize || 30;
  const color = style.color || "#FFFFFF";
  const bgColor = style.bgColor || "rgba(0,0,0,0.65)";
  const borderRadius = style.borderRadius ?? 16;
  const fontWeight = style.fontWeight || 800;
  const padding = parsePadding(style.padding);

  const maxCharsPerLine = Math.max(10, Math.floor((width - padding.horizontal * 2) / Math.max(10, fontSize * 0.62)));
  const lines = wrapText(text, maxCharsPerLine, 3);
  const safeLines = (lines.length > 0 ? lines : [text]).map(escapeXml).join("<br />");

  return `<div style="
      width:${width}px;
      height:${height}px;
      box-sizing:border-box;
      display:flex;
      align-items:center;
      justify-content:center;
      text-align:center;
      direction:rtl;
      unicode-bidi:bidi-override;
      font-family:'Arial',sans-serif;
      font-size:${fontSize}px;
      font-weight:${fontWeight};
      color:${color};
      background:${bgColor};
      border-radius:${borderRadius}px;
      line-height:1.35;
      text-shadow:0 2px 6px rgba(0,0,0,0.85),0 0 1px rgba(0,0,0,0.65);
      padding:${padding.vertical}px ${padding.horizontal}px;
      white-space:normal;
      overflow-wrap:break-word;
      word-break:break-word;
    ">${safeLines}</div>`;
}

function parseShadowStyle(shadow: string | undefined): { strokeColor: string; strokeWidth: number; shadowBlur: number; shadowColor: string; shadowOpacity: number } {
  // Parse CSS text-shadow into SVG-friendly stroke/shadow params
  if (!shadow || shadow === 'none') {
    return { strokeColor: '#000000', strokeWidth: 0, shadowBlur: 0, shadowColor: '#000000', shadowOpacity: 0 };
  }

  // Detect thick outline style (multiple directional shadows like "2px 2px 0 #000, -2px -2px 0 #000")
  const outlineMatch = shadow.match(/(\d+)px\s+\d+px\s+\d+px?\s+(#[0-9a-fA-F]+|rgba?\([^)]+\))/);
  const strokeW = outlineMatch ? Math.max(2, Number(outlineMatch[1]) * 1.2) : 2.5;
  const strokeCol = outlineMatch ? outlineMatch[2] : '#000000';

  // Detect blur-based shadow (e.g. "0 2px 6px rgba(0,0,0,0.85)")
  const blurMatch = shadow.match(/(\d+)px\s+(\d+)px\s+(\d+)px\s+(rgba?\([^)]+\)|#[0-9a-fA-F]+)/);
  const blur = blurMatch ? Number(blurMatch[3]) : 1.8;

  // Detect glow (multiple large blur shadows)
  const glowMatch = shadow.match(/0\s+0\s+(\d+)px\s+(#[0-9a-fA-F]+|rgba?\([^)]+\))/);
  const isGlow = glowMatch && Number(glowMatch[1]) >= 10;

  return {
    strokeColor: strokeCol,
    strokeWidth: isGlow ? 1.5 : strokeW,
    shadowBlur: isGlow ? Number(glowMatch![1]) * 0.3 : Math.min(blur * 0.4, 3),
    shadowColor: isGlow ? (glowMatch![2] || '#FFFFFF') : (strokeCol || '#000000'),
    shadowOpacity: isGlow ? 0.6 : 0.75,
  };
}

function buildSubtitleSvgAsset(
  text: string,
  style: SubtitleStyle,
  width: number,
  height: number,
  font: any,
): string {
  const fontSize = style.fontSize || 30;
  const color = style.color || "#FFFFFF";
  const bgColor = style.bgColor || "rgba(0,0,0,0.65)";
  const borderRadius = style.borderRadius ?? 16;
  const padding = parsePadding(style.padding);

  // Derive stroke/shadow from font preset's shadow string or explicit overrides
  const shadowParams = parseShadowStyle(style.shadow);
  const strokeColor = style.strokeColor || shadowParams.strokeColor;
  const strokeWidth = style.strokeWidth ?? shadowParams.strokeWidth;
  const shadowBlur = style.shadowBlur ?? shadowParams.shadowBlur;
  const shadowColor = style.shadowColor || shadowParams.shadowColor;
  const shadowOpacity = style.shadowOpacity ?? shadowParams.shadowOpacity;

  const maxCharsPerLine = Math.max(10, Math.floor((width - padding.horizontal * 2) / Math.max(10, fontSize * 0.62)));
  const lines = wrapText(text, maxCharsPerLine, 3);
  const safeLines = lines.length > 0 ? lines : [text];

  const lineHeight = fontSize * 1.35;
  const textBlockHeight = safeLines.length * lineHeight;
  const firstBaseline = (height - textBlockHeight) / 2 + fontSize;

  const strokePaths = strokeWidth > 0 ? safeLines.map((line, index) => {
    const baselineY = firstBaseline + index * lineHeight;
    const d = buildRtlPathData(line, font, fontSize, baselineY, width / 2);
    return d
      ? `<path d="${d}" fill="none" stroke="${strokeColor}" stroke-width="${round2(strokeWidth)}" stroke-linejoin="round" stroke-linecap="round" filter="url(#subtitleShadow)" />`
      : "";
  }).join("") : "";

  const fillPaths = safeLines.map((line, index) => {
    const baselineY = firstBaseline + index * lineHeight;
    const d = buildRtlPathData(line, font, fontSize, baselineY, width / 2);
    return d ? `<path d="${d}" fill="${color}" />` : "";
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <filter id="subtitleShadow" x="-25%" y="-25%" width="150%" height="150%">
        <feDropShadow dx="0" dy="2" stdDeviation="${round2(shadowBlur)}" flood-color="${shadowColor}" flood-opacity="${shadowOpacity}" />
      </filter>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" rx="${borderRadius}" ry="${borderRadius}" fill="${bgColor}" />
    ${strokePaths}
    ${fillPaths}
  </svg>`;
}

async function buildSubtitleClips(
  segments: SubtitleSegment[],
  style: SubtitleStyle,
  outputWidth: number,
  outputHeight: number,
  contentRect: ContentRectPx,
  captionPosition?: string,
): Promise<any[]> {
  const subWidth = Math.round(contentRect.w * 0.85);
  const subHeight = Math.round(outputHeight * 0.15);
  const font = await loadHebrewFont();

  // Position: bottom (default), middle, top — matching preview captionPosition
  const subtitleCenterX = contentRect.x + contentRect.w / 2;
  let subtitleCenterY: number;
  const margin = Math.max(18, contentRect.h * 0.05);

  if (captionPosition === 'top') {
    subtitleCenterY = contentRect.y + subHeight / 2 + margin;
  } else if (captionPosition === 'middle') {
    subtitleCenterY = contentRect.y + contentRect.h / 2;
  } else {
    // bottom (default)
    subtitleCenterY = contentRect.y + contentRect.h - subHeight / 2 - margin;
  }

  const offsetX = subtitleCenterX / outputWidth - 0.5;
  const offsetY = -(subtitleCenterY / outputHeight - 0.5);

  return Promise.all(
    segments
      .map((seg, cueIndex) => {
        const sanitized = sanitizeSubtitleText(seg.text || "", font);
        if (sanitized.removedCodepoints.length > 0) {
          console.log("Subtitle sanitization removed codepoints", {
            cueIndex,
            cueStart: seg.start,
            cueEnd: seg.end,
            removedCodepoints: sanitized.removedCodepoints,
          });
        }

        return {
          cueIndex,
          start: seg.start,
          end: seg.end,
          text: sanitized.text,
        };
      })
      .filter((seg) => seg.text.trim().length > 0)
      .map(async (seg) => {
        const svgMarkup = buildSubtitleSvgAsset(seg.text, style || {}, subWidth, subHeight, font);
        const hash = await sha1Hex(`${subWidth}x${subHeight}|${JSON.stringify(style || {})}|${seg.text}`);
        const objectPath = `uploads/subtitle-overlays/${hash}.svg`;
        const src = await uploadSubtitleSvg(svgMarkup, objectPath);

        return {
          asset: {
            type: "image",
            src,
          },
          start: seg.start,
          length: Math.max(0.5, seg.end - seg.start),
          position: "center",
          offset: { x: round2(offsetX), y: round2(offsetY) },
          scale: round2(subWidth / outputWidth),
          transition: {
            in: "slideUp",
            out: "fade",
          },
        };
      }),
  );
}

function buildStickerClips(stickers: StickerItem[]): any[] {
  return stickers.map((s) => ({
    asset: {
      type: "html",
      html: `<div style="font-size:64px;filter:drop-shadow(0 4px 10px rgba(0,0,0,0.4));">${s.emoji}</div>`,
      width: 100,
      height: 100,
    },
    start: s.startTime,
    length: Math.max(0.5, s.duration),
    position: s.position || "topRight",
    offset: {
      x: s.position?.includes("Right") ? -0.05 : s.position?.includes("Left") ? 0.05 : 0,
      y: s.position?.includes("top") ? -0.05 : s.position?.includes("bottom") ? 0.05 : 0,
    },
    scale: s.scale || 0.8,
    transition: {
      in: "zoom",
      out: "fade",
    },
  }));
}

function resolveOutputConfig(orientation?: string): OutputConfig {
  if (orientation === "portrait" || orientation === "9:16") {
    return { width: 1080, height: 1920, resolution: "1080" };
  }
  return { width: 1920, height: 1080, resolution: "hd" };
}

function resolveContentRect(
  outputWidth: number,
  outputHeight: number,
  sourceWidth?: number,
  sourceHeight?: number,
  orientation?: string,
): ContentRectPx {
  let sw = Number(sourceWidth);
  let sh = Number(sourceHeight);

  if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0) {
    return { x: 0, y: 0, w: outputWidth, h: outputHeight };
  }

  // Mirror the preview's orientation override logic exactly
  if (orientation === 'landscape' && sh > sw) {
    // Portrait source → landscape target: use 16:9 effective aspect
    const targetAspect = 16 / 9;
    sw = Math.max(sw, sh * targetAspect);
    sh = sw / targetAspect;
  } else if (orientation === 'portrait' && sw > sh) {
    // Landscape source → portrait target: use 9:16 effective aspect
    const targetAspect = 9 / 16;
    sh = Math.max(sh, sw / targetAspect);
    sw = sh * targetAspect;
  }

  const sourceAspect = sw / sh;
  const targetAspect = outputWidth / outputHeight;

  if (sourceAspect > targetAspect) {
    const w = outputWidth;
    const h = outputWidth / sourceAspect;
    return { x: 0, y: (outputHeight - h) / 2, w, h };
  }

  const h = outputHeight;
  const w = outputHeight * sourceAspect;
  return { x: (outputWidth - w) / 2, y: 0, w, h };
}

function buildLogoClip(
  logoUrl: string,
  totalDuration: number,
  outputWidth: number,
  outputHeight: number,
  contentRect: ContentRectPx,
  placement?: LogoPlacement,
): { track: any; debug: Record<string, unknown> } {
  const p = placement || { xPct: 88, yPct: 4, scalePct: 10, opacity: 0.92 };
  const scalePct = clamp(Number(p.scalePct) || 10, 2, 30);
  const xPct = clamp(Number(p.xPct) || 0, 0, 100 - scalePct);
  const yPct = clamp(Number(p.yPct) || 0, 0, 100 - scalePct);
  const opacity = clamp(Number(p.opacity) || 0.92, 0, 1);

  // EXACT preview parity:
  // logo width/height are based on contentRect WIDTH, while x/y are percentages over contentRect.
  const logoPxW = (contentRect.w * scalePct) / 100;
  const logoPxH = logoPxW;
  const logoPxX = contentRect.x + (contentRect.w * xPct) / 100;
  const logoPxY = contentRect.y + (contentRect.h * yPct) / 100;

  const centerX = logoPxX + logoPxW / 2;
  const centerY = logoPxY + logoPxH / 2;

  const offsetX = centerX / outputWidth - 0.5;
  const offsetY = -(centerY / outputHeight - 0.5);

  return {
    track: {
      clips: [
        {
          asset: { type: "image", src: logoUrl },
          start: 0,
          length: totalDuration,
          position: "center",
          offset: { x: offsetX, y: offsetY },
          scale: logoPxW / outputWidth,
          opacity,
        },
      ],
    },
    debug: {
      outputSize: { width: outputWidth, height: outputHeight },
      contentRectPx: {
        x: round2(contentRect.x),
        y: round2(contentRect.y),
        w: round2(contentRect.w),
        h: round2(contentRect.h),
      },
      logoPxX: round2(logoPxX),
      logoPxY: round2(logoPxY),
      logoPxW: round2(logoPxW),
      logoPxH: round2(logoPxH),
    },
  };
}

function getShotstackEnvOrder(preferredEnv?: unknown): ShotstackEnv[] {
  const normalized = typeof preferredEnv === "string" ? preferredEnv.toLowerCase() : "";
  if (normalized === "stage") return ["stage", "production"];
  if (normalized === "production") return ["production", "stage"];
  return ["production", "stage"];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SHOTSTACK_API_KEY = Deno.env.get("SHOTSTACK_API_KEY");
    if (!SHOTSTACK_API_KEY) throw new Error("SHOTSTACK_API_KEY is not configured");

    const { action, ...params } = await req.json();

    const headers = {
      "x-api-key": SHOTSTACK_API_KEY,
      "Content-Type": "application/json",
    };

    if (action === "render") {
      const {
        videoUrl,
        videoUrls,
        scenes,
        logoUrl,
        logoPlacement,
        brandColors,
        audioUrl,
        subtitleStyle,
        stickers,
        subtitleSegments,
        totalDuration: requestedDuration,
        orientation,
        sourceWidth,
        sourceHeight,
        captionPosition,
        pipAvatarUrl,
      } = params;

      const clipUrls: string[] = videoUrls || (videoUrl ? [videoUrl] : []);

      if (clipUrls.length === 0) {
        return new Response(JSON.stringify({ error: "חסר קישור לסרטון בסיס" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const outputConfig = resolveOutputConfig(orientation);

      const sceneDuration = (scenes || []).reduce(
        (sum: number, s: any) => sum + (s.duration || 10),
        0,
      );
      const totalDuration = requestedDuration || Math.max(sceneDuration, clipUrls.length * 10) || 30;

      const contentRect = resolveContentRect(
        outputConfig.width,
        outputConfig.height,
        Number(sourceWidth),
        Number(sourceHeight),
        orientation,
      );

      const tracks: any[] = [];

      let logoDebug: Record<string, unknown> | null = null;
      if (logoUrl) {
        const logo = buildLogoClip(
          logoUrl,
          totalDuration,
          outputConfig.width,
          outputConfig.height,
          contentRect,
          logoPlacement as LogoPlacement | undefined,
        );
        logoDebug = logo.debug;
        tracks.push(logo.track);
      }

      // PiP avatar overlay (picture-in-picture)
      if (pipAvatarUrl) {
        const pipSize = Math.round(outputConfig.width * 0.18); // 18% of width
        const pipMargin = Math.round(outputConfig.width * 0.03);
        // Bottom-left corner
        const pipX = pipMargin;
        const pipY = outputConfig.height - pipMargin - pipSize;
        const pipOffsetX = (pipX + pipSize / 2) / outputConfig.width - 0.5;
        const pipOffsetY = -((pipY + pipSize / 2) / outputConfig.height - 0.5);

        tracks.push({
          clips: [{
            asset: {
              type: "image",
              src: pipAvatarUrl,
            },
            start: 0,
            length: totalDuration,
            fit: "cover",
            position: "center",
            offset: { x: pipOffsetX, y: pipOffsetY },
            scale: pipSize / outputConfig.width,
            opacity: 0.95,
            transition: { in: "fade", out: "fade" },
          }],
        });
        console.log(`PiP avatar added: ${pipSize}px at offset (${pipOffsetX.toFixed(3)}, ${pipOffsetY.toFixed(3)})`);
      }

      if (stickers && stickers.length > 0) {
        tracks.push({ clips: buildStickerClips(stickers) });
      }

      if (subtitleSegments && subtitleSegments.length > 0) {
        const subClips = await buildSubtitleClips(
          subtitleSegments,
          subtitleStyle || {},
          outputConfig.width,
          outputConfig.height,
          contentRect,
          captionPosition,
        );
        if (subClips.length > 0) {
          tracks.push({ clips: subClips });
        }
      } else if (scenes && scenes.length > 0) {
        const textClips: any[] = [];
        const sceneSubtitleSegments: SubtitleSegment[] = [];
        let cumulativeTime = 0;

        for (const scene of scenes) {
          const dur = scene.duration || 10;
          const subtitle = scene.subtitleText || scene.spokenText?.slice(0, 80) || "";

          if (subtitle) {
            sceneSubtitleSegments.push({
              start: cumulativeTime + 0.3,
              end: cumulativeTime + dur - 0.3,
              text: subtitle,
            });
          }

          if (scene.title && dur > 2) {
            const titleWidth = 520;
            const titleHeight = 70;
            const titleHtml = buildSubtitleHtmlAsset(
              scene.title,
              {
                fontSize: 22,
                color: "#1a1a1a",
                bgColor: "rgba(255,180,40,0.95)",
                borderRadius: 12,
                fontWeight: 800,
                padding: "10px 24px",
              },
              titleWidth,
              titleHeight,
            );

            textClips.push({
              asset: {
                type: "html",
                html: titleHtml,
                width: titleWidth,
                height: titleHeight,
              },
              start: cumulativeTime + 0.15,
              length: Math.min(dur - 0.3, 3),
              position: "top",
              offset: { y: -0.05 },
              transition: { in: "slideRight", out: "slideLeft" },
            });
          }

          if (scene.icons && scene.icons.length > 0) {
            const iconPositions = ["left", "right", "topLeft", "topRight"];
            scene.icons.slice(0, 4).forEach((icon: string, i: number) => {
              textClips.push({
                asset: {
                  type: "html",
                  html: `<div style="font-size:56px;filter:drop-shadow(0 6px 12px rgba(0,0,0,0.4));">${icon}</div>`,
                  width: 90,
                  height: 90,
                },
                start: cumulativeTime + 0.8 + i * 0.5,
                length: Math.min(dur - 1.5, 2.5),
                position: iconPositions[i % iconPositions.length],
                offset: { x: i % 2 === 0 ? 0.1 : -0.1, y: -0.18 },
                scale: 0.85,
                transition: { in: "zoom", out: "fade" },
              });
            });
          }

          cumulativeTime += dur;
        }

        if (sceneSubtitleSegments.length > 0) {
          const subClips = await buildSubtitleClips(
            sceneSubtitleSegments,
            subtitleStyle || {},
            outputConfig.width,
            outputConfig.height,
            contentRect,
            captionPosition,
          );
          textClips.push(...subClips);
        }

        if (textClips.length > 0) {
          tracks.push({ clips: textClips });
        }
      }

      const videoClips: any[] = [];
      let videoStart = 0;
      for (let i = 0; i < clipUrls.length; i++) {
        const sceneDur = scenes?.[i]?.duration || totalDuration / clipUrls.length;
        videoClips.push({
          asset: {
            type: "video",
            src: clipUrls[i],
            volume: audioUrl ? 0.15 : 1,
          },
          start: videoStart,
          length: clipUrls.length === 1 ? totalDuration : sceneDur,
          fit: "contain",
          transition: i > 0 ? { in: "fade", out: "fade" } : undefined,
        });
        videoStart += sceneDur;
      }
      tracks.push({ clips: videoClips });

      const bgColor = brandColors?.[0] || "#0f0f23";
      tracks.push({
        clips: [
          {
            asset: {
              type: "html",
              html: `<div style="width:100%;height:100%;background:linear-gradient(160deg, ${bgColor} 0%, #1a1a2e 50%, #0d0d1a 100%);"></div>`,
              width: outputConfig.width,
              height: outputConfig.height,
            },
            start: 0,
            length: totalDuration,
          },
        ],
      });

      const soundtrack: any = {};
      if (audioUrl) {
        soundtrack.src = audioUrl;
        soundtrack.effect = "fadeOut";
      }

      const subtitleProofClip = tracks
        .flatMap((track: any) => track?.clips ?? [])
        .find((clip: any) => clip?.asset?.type === "image" && typeof clip?.asset?.src === "string" && clip.asset.src.includes("/subtitle-overlays/"));

      if (subtitleProofClip?.asset?.src) {
        console.log("Subtitle overlay proof", {
          type: subtitleProofClip.asset.type,
          src: String(subtitleProofClip.asset.src).slice(0, 180),
        });
      }

      const renderBody: any = {
        timeline: {
          background: bgColor,
          tracks,
          ...(audioUrl ? { soundtrack } : {}),
        },
        output: {
          format: "mp4",
          resolution: outputConfig.resolution,
          fps: 30,
          size: { width: outputConfig.width, height: outputConfig.height },
        },
      };

      const subtitleCount = subtitleSegments?.length || 0;
      const logoPlacementSummary = logoDebug as LogoPlacementSummary | null;

      const responseSummary: Omit<ComposeRenderResponse, "renderId" | "status"> = {
        outputUrl: null,
        thumbnailUrl: null,
        subtitleCount,
        logoPlacementSummary,
      };

      console.log("Submitting Shotstack render (payload KB):", Math.round(JSON.stringify(renderBody).length / 1024));

      const envOrder = getShotstackEnvOrder(params.shotstackEnv);
      const renderErrors: string[] = [];

      for (const env of envOrder) {
        const baseUrl = SHOTSTACK_ENDPOINTS[env];
        const response = await fetch(`${baseUrl}/render`, {
          method: "POST",
          headers,
          body: JSON.stringify(renderBody),
        });

        if (response.ok) {
          const data = await response.json();
          const renderResponse: ComposeRenderResponse = {
            renderId: data.response?.id ?? null,
            status: "rendering",
            ...responseSummary,
          };

          return new Response(JSON.stringify(renderResponse), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Always consume provider body but never echo it back to the client
        const providerError = await response.text();
        renderErrors.push(`${env}:${response.status}`);
        console.error(`Shotstack render error (${env}):`, response.status, providerError.slice(0, 220));

        if (![401, 402, 403, 404].includes(response.status)) {
          break;
        }
      }

      const failedResponse: ComposeRenderResponse = {
        renderId: null,
        status: `failed:${renderErrors.join(",") || "unknown"}`,
        ...responseSummary,
      };

      return new Response(JSON.stringify(failedResponse), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "check_status") {
      const { renderId } = params;
      const envOrder = getShotstackEnvOrder(params.shotstackEnv);
      const statusErrors: string[] = [];
      let data: any = null;

      for (const env of envOrder) {
        const baseUrl = SHOTSTACK_ENDPOINTS[env];
        const response = await fetch(`${baseUrl}/render/${renderId}`, { headers });

        if (response.ok) {
          data = await response.json();
          break;
        }

        await response.text();
        statusErrors.push(`${env}:${response.status}`);
        console.error(`Shotstack status error (${env}):`, response.status);

        if (![401, 403, 404].includes(response.status)) {
          break;
        }
      }

      if (!data) {
        return new Response(
          JSON.stringify({ error: `שגיאה בבדיקת סטטוס הרכבה: ${statusErrors.join(" | ")}` }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const r = data.response;
      const isDone = r.status === "done" || r.status === "rendered";
      const normalizedStatus = isDone ? "done" : r.status;

      const statusResponse: ComposeRenderResponse = {
        renderId: String(renderId),
        status: normalizedStatus,
        outputUrl: r.url || null,
        thumbnailUrl: r.poster || null,
        subtitleCount: Number(params.subtitleCount) || 0,
        logoPlacementSummary: null,
      };

      return new Response(JSON.stringify(statusResponse), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const unknownActionResponse: ComposeRenderResponse = {
      renderId: null,
      status: "failed:unknown_action",
      outputUrl: null,
      thumbnailUrl: null,
      subtitleCount: 0,
      logoPlacementSummary: null,
    };

    return new Response(JSON.stringify(unknownActionResponse), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("compose-video error:", e);

    const failureResponse: ComposeRenderResponse = {
      renderId: null,
      status: `failed:${e instanceof Error ? e.message.slice(0, 80) : "compose_error"}`,
      outputUrl: null,
      thumbnailUrl: null,
      subtitleCount: 0,
      logoPlacementSummary: null,
    };

    return new Response(JSON.stringify(failureResponse), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});