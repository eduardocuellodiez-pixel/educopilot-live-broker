import http from "node:http";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const FRONTEND = `Eres EDU, la interfaz de voz de EduCopilot en un taller. Habla en español con una personalidad de asistente tecnológico original: serena, precisa, elegante, cálida y muy concisa. Responde enseguida; no digas "espera" ni "estoy pensando". Para conversación simple responde directamente. Para DTC, diagnosis, interpretación de datos, causalidad, procedimientos o cualquier consulta técnica que requiera conocimiento, delega al backend Responses. Usa el contexto real de EduCopilot y la máquina cuando esté disponible. Nunca inventes valores, DTC, vehículo, pruebas o ejecución. Una orden física solo es válida si el sistema determinista de EduCopilot la verifica. Si te interrumpen, para y escucha.`;

function backend(context) {
  return `Eres el cerebro diagnóstico de EduCopilot. Resuelve las consultas técnicas delegadas por GPT-Live con exactitud y baja latencia. Para una pregunta directa como "qué es P0238", da primero significado/sistema y después la discriminación útil; no hagas investigación larga si no hace falta. Un DTC describe una condición y no confirma una pieza. Correlaciona vehículo, motor, síntomas, freeze frame, datos, unidades, referencia de presión, pruebas previas y pantalla real OTOFIX. No inventes especificaciones ni datos ausentes. No repitas pruebas cerradas. La evidencia imperfecta reduce certeza, no destruye el razonamiento. Responde para voz normalmente en 2-5 frases.\n\nCONTEXTO VIVO EDUCOPILOT:\n${context || ""}`;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("EduCopilot 51 Live Broker OK");
    return;
  }

  if (req.method === "POST" && req.url === "/v1/live/session") {
    if (!OPENAI_API_KEY) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "OPENAI_API_KEY no configurada" }));
      return;
    }

    let rawBody = "";
    req.on("data", chunk => { rawBody += chunk; });
    req.on("end", async () => {
      try {
        const androidRequest = JSON.parse(rawBody);
        const offerSdp = typeof androidRequest.offer_sdp === "string" ? androidRequest.offer_sdp : "";
        const caseContext = typeof androidRequest.case_context === "string" ? androidRequest.case_context : "";
        if (!offerSdp.startsWith("v=0")) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "offer_sdp ausente o invalido" }));
          return;
        }

        const session = {
          model: "gpt-live-1",
          store: false,
          audio: { output: { voice: "cedar" } },
          instructions: FRONTEND,
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
          console.error("OpenAI Live error:", openai.status, text);
          res.writeHead(openai.status, { "Content-Type": "application/json; charset=utf-8" });
          res.end(text);
          return;
        }

        const data = JSON.parse(text);
        const answerSdp = data?.transport?.sdp || "";
        if (!answerSdp) throw new Error("OpenAI no devolvio transport.sdp");

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ answer_sdp: answerSdp, session_id: data?.session?.id || data?.id || "" }));
      } catch (error) {
        console.error("Broker error:", error);
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Error creando sesion GPT-Live", detail: String(error?.message || error) }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => console.log(`EduCopilot 51 Live Broker en puerto ${PORT}`));
