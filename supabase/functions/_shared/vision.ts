// Images in a chat: Gemma 4 only looks at them and writes a detailed
// description; the main model (gpt-oss-120b) then answers from that text.
// Gemma 4 runs on Ollama Cloud first (fast, our key), with OpenRouter's free
// Gemma 4 as a backup.
//
// A message with images uses the OpenAI shape:
//   { role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }] }
// describeImages() returns the messages with every image part replaced by its
// description, as plain text any model can read.

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const OLLAMA_KEYS = [Deno.env.get("OLLAMA_API_KEY"), Deno.env.get("OLLAMA_API_KEY_FALLBACK")].filter(Boolean) as string[];
export const VISION_MODEL = Deno.env.get("VISION_MODEL") || "gemma4:31b"; // on Ollama Cloud
const OPENROUTER_VISION = ["google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free"];
const MAX_IMAGES = 6;

type Part = { type: string; text?: string; image_url?: { url?: string } };
type Msg = { role: string; content: unknown };

const isImage = (p: Part) => p && p.type === "image_url" && typeof p.image_url?.url === "string";
export function hasImages(messages: Msg[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && (m.content as Part[]).some(isImage));
}

const PROMPT = `You are the eyes for another AI that cannot see images. Describe each image so that AI can answer the user without seeing it.
Include: what it is (photo, screenshot, document, chart, UI...), every piece of visible text word for word (keep numbers, names, code and errors exact), the layout, important colors, and anything unusual.
If there are several images, label them Image 1, Image 2 and so on. Be thorough but plain. Do not answer the user's question yourself.`;

/** Ollama Cloud's native chat: images as bare base64. */
async function lookOllama(images: string[], prompt: string): Promise<string | null> {
  for (const key of OLLAMA_KEYS) {
    try {
      const res = await fetch("https://ollama.com/api/chat", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: VISION_MODEL, stream: false, options: { temperature: 0 }, messages: [{ role: "user", content: prompt, images: images.map((u) => u.replace(/^data:[^,]*,/, "")) }] }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) { console.warn("[vision] ollama", res.status, (await res.text()).slice(0, 200)); continue; }
      const text = (await res.json())?.message?.content;
      if (typeof text === "string" && text.trim()) return text.trim();
    } catch (e) { console.warn("[vision] ollama", e instanceof Error ? e.message : String(e)); }
  }
  return null;
}

/** OpenRouter's free Gemma 4 (often rate limited, so only a backup). */
async function lookOpenRouter(images: string[], prompt: string): Promise<string | null> {
  if (!OPENROUTER_API_KEY) return null;
  for (const model of OPENROUTER_VISION) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://codeply.app", "X-Title": "Codeply" },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 1500, messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] }] }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) { console.warn("[vision]", model, res.status, (await res.text()).slice(0, 200)); continue; }
      const text = (await res.json())?.choices?.[0]?.message?.content;
      if (typeof text === "string" && text.trim()) return text.trim();
    } catch (e) { console.warn("[vision]", model, e instanceof Error ? e.message : String(e)); }
  }
  return null;
}

async function look(images: string[], userText: string): Promise<string | null> {
  if (!images.length) return null;
  const prompt = `${PROMPT}\n\nThe user's message with the image(s): ${userText || "(no text)"}`;
  return (await lookOllama(images, prompt)) ?? (await lookOpenRouter(images, prompt));
}

/** The messages with images turned into descriptions (only the newest message with images is looked at; older ones are noted). */
export async function describeImages(messages: Msg[]): Promise<Msg[]> {
  if (!hasImages(messages)) return messages;
  let newest = -1;
  messages.forEach((m, i) => { if (Array.isArray(m.content) && (m.content as Part[]).some(isImage)) newest = i; });
  const out: Msg[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) { out.push(m); continue; }
    const parts = m.content as Part[];
    const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n").trim();
    const imgs = parts.filter(isImage).map((p) => p.image_url!.url!).slice(0, MAX_IMAGES);
    if (!imgs.length) { out.push({ role: m.role, content: text }); continue; }
    if (i !== newest) { out.push({ role: m.role, content: `${text}\n\n[${imgs.length} image(s) were shared here earlier.]`.trim() }); continue; }
    const seen = await look(imgs, text);
    const note = seen
      ? `[The user attached ${imgs.length} image(s). A vision model looked at them and described them as follows. Treat this as what the images show; answer as if you can see them.]\n${seen}`
      : `[The user attached ${imgs.length} image(s), but they could not be looked at right now. Say so briefly and answer from the text.]`;
    out.push({ role: m.role, content: `${text}\n\n${note}`.trim() });
  }
  return out;
}
