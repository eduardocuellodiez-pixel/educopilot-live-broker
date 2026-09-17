import http from "node:http";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const BROKER_TOKEN = process.env.EDUCOPILOT_BROKER_TOKEN || "";
const PROTOCOL_VERSION = "53.0";
const MAX_BODY = 128 * 1024;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_SESSIONS_PER_WINDOW = 12;
const rate = new Map();

// Current built-in GPT-Live voices from the Live API schema.
const SAFE_VOICES = new Set([
  "alloy","ash","ballad","beacon","bossa","cedar","cinder","coral","delta","echo","gleam",
  "marin","meridian","quartz","ripple","sage","shimmer","stone","tempo","verse","vesper","willow"
]);

const FALLBACK_FRONTEND = `Eres Edu, la inteligencia de taller de EduCopilot. Tu nombre es Edu y no tienes género: nunca uses masculino ni femenino para describirte. Habla en español de España con una presencia técnica sobria, directa, rápida y segura. Frases cortas. Sin sentimentalismo, sin muletillas y sin decir «un momento», «déjame», «estoy pensando», «sereno/serena», «me alegra» ni similares. No imites a ningún personaje ni voz concreta. Escucha mientras hablas y deja que el mecánico te interrumpa. Mantén continuidad estricta del caso y de la misión activa. Cuando haya pantalla OTOFIX, usa únicamente la evidencia de pantalla recibida; si el runtime indica VISION_OTOFIX: AVAILABLE no digas que no puedes verla. Si el snapshot está ausente u obsoleto, dilo con precisión. Nunca inventes valores, DTC, vehículo, pruebas ni ejecución. ACK no significa objetivo cumplido. Solo afirma que una acción de máquina terminó cuando el runtime indique OBJECTIVE_VERIFIED. Las órdenes físicas pasan siempre por las autorizaciones deterministas de EduCopilot.`;

function clip(value, max) {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}

function backend(context) {
  return `Eres el cerebro diagnóstico de EduCopilot. Resuelve las consultas técnicas delegadas por GPT-Live con exactitud y baja latencia. Un DTC describe una condición y no confirma una pieza. Correlaciona vehículo, motor, síntomas, freeze frame, datos, unidades, referencia de presión, pruebas previas y evidencia real OTOFIX. No inventes especificaciones ni datos ausentes. No repitas pruebas cerradas. La evidencia imperfecta reduce certeza, no destruye el razonamiento. Responde para voz normalmente en 2-5 frases.\n\nCONTEXTO INICIAL EDUCOPILOT:\n${clip(context, 3500)}`;
}

function sameToken(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket.remoteAddress || "unknown";
}

function allowed(ip) {
  const now = Date.now();
  const prev = (rate.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (prev.length >= MAX_SESSIONS_PER_WINDOW) {
    rate.set(ip, prev);
    return false;
  }
  prev.push(now);
  rate.set(ip, prev);
  return true;
}

// Prevent an unbounded in-memory IP map on long-lived free-tier instances.
setInterval(() => {
  const now = Date.now();
  for (const [ip, values] of rate) {
    const fresh = values.filter(t => now - t < WINDOW_MS);
    if (fresh.length) rate.set(ip, fresh); else rate.delete(ip);
  }
}, WINDOW_MS).unref?.();

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let rejected = false;
    req.on("data", chunk => {
      if (rejected) return;
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > MAX_BODY) {
        rejected = true;
        reject(new Error("request_too_large"));
      }
    });
    req.on("end", () => {
      if (rejected) return;
      try { resolve(JSON.parse(raw || "{}")); }
      catch { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function json(res, code, value) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    return json(res, 200, {
      ok: true,
      service: "EduCopilot Live Broker",
      broker_version: PROTOCOL_VERSION,
      openai_key_configured: Boolean(OPENAI_API_KEY),
      broker_token_configured: Boolean(BROKER_TOKEN)
    });
  }

  if (req.method === "POST" && req.url === "/v1/live/session") {
    if (!OPENAI_API_KEY) return json(res, 503, { error: "OPENAI_API_KEY no configurada", broker_version: PROTOCOL_VERSION });
    // Secure by default: do not leave a public session-minting endpoint on the Internet.
    if (!BROKER_TOKEN) return json(res, 503, { error: "EDUCOPILOT_BROKER_TOKEN no configurado", broker_version: PROTOCOL_VERSION });

    const suppliedToken = String(req.headers["x-educopilot-token"] || "");
    if (!sameToken(suppliedToken, BROKER_TOKEN)) return json(res, 401, { error: "broker_token_invalid", broker_version: PROTOCOL_VERSION });

    const ip = clientIp(req);
    if (!allowed(ip)) return json(res, 429, { error: "rate_limit", broker_version: PROTOCOL_VERSION });

    try {
      const body = await readJson(req);
      if (body.protocol_version !== PROTOCOL_VERSION) {
        return json(res, 409, {
          error: "protocol_version_mismatch",
          expected: PROTOCOL_VERSION,
          received: String(body.protocol_version || "")
        });
      }

      const offerSdp = typeof body.offer_sdp === "string" ? body.offer_sdp : "";
      if (!offerSdp.startsWith("v=0")) return json(res, 400, { error: "offer_sdp ausente o invalido", broker_version: PROTOCOL_VERSION });

      const caseContext = clip(body.case_context, 3500);
      const frontend = clip(body.frontend_instructions, 3500) || FALLBACK_FRONTEND;
      const requestedVoice = typeof body.voice === "string" ? body.voice : "stone";
      const voice = SAFE_VOICES.has(requestedVoice) ? requestedVoice : "stone";

      const session = {
        model: "gpt-live-1",
        store: false,
        audio: { output: { voice } },
        instructions: frontend,
        delegation: {
          type: "responses",
          responses: {
            model: "gpt-5.6-terra",
            instructions: backend(caseContext),
            max_output_tokens: 700,
            reasoning: { effort: "low" },
            text: { verbosity: "low" },
            parallel_tool_calls: false,
            tool_choice: "none"
          }
        }
      };

      const openai = await fetch("https://api.openai.com/v1/live/sessions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ session, transport: { type: "webrtc", sdp: offerSdp } })
      });

      const text = await openai.text();
      if (!openai.ok) {
        console.error("OpenAI Live error:", openai.status, text.slice(0, 1200));
        return json(res, openai.status, {
          error: "openai_live_error",
          status: openai.status,
          detail: clip(text, 1200),
          broker_version: PROTOCOL_VERSION
        });
      }

      const data = JSON.parse(text);
      const answerSdp = data?.transport?.sdp || "";
      if (!answerSdp) throw new Error("OpenAI no devolvio transport.sdp");

      return json(res, 200, {
        answer_sdp: answerSdp,
        session_id: data?.session?.id || data?.id || "",
        voice,
        broker_version: PROTOCOL_VERSION
      });
    } catch (error) {
      const m = String(error?.message || error);
      if (m === "request_too_large") return json(res, 413, { error: m, broker_version: PROTOCOL_VERSION });
      if (m === "invalid_json") return json(res, 400, { error: m, broker_version: PROTOCOL_VERSION });
      console.error("Broker error:", m);
      return json(res, 500, { error: "Error creando sesión GPT-Live", detail: clip(m, 500), broker_version: PROTOCOL_VERSION });
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => console.log(`EduCopilot ${PROTOCOL_VERSION} Live Broker en puerto ${PORT}`));
        
