import http from "node:http";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const server = http.createServer(async (req, res) => {

  // Prueba sencilla del servidor
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8"
    });
    res.end("EduCopilot Live Broker OK");
    return;
  }

  // Negociación GPT-Live desde EduCopilot Android
  if (req.method === "POST" && req.url === "/v1/live/session") {

    if (!OPENAI_API_KEY) {
      res.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8"
      });
      res.end(JSON.stringify({
        error: "OPENAI_API_KEY no configurada"
      }));
      return;
    }

    let rawBody = "";

    req.on("data", chunk => {
      rawBody += chunk;
    });

    req.on("end", async () => {
      try {
        // EduCopilot Android manda:
        // {
        //   offer_sdp: "...",
        //   case_context: "...",
        //   client: "educopilot-android-47"
        // }

        let androidRequest;

        try {
          androidRequest = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8"
          });
          res.end(JSON.stringify({
            error: "JSON de EduCopilot no valido"
          }));
          return;
        }

        const offerSdp =
          typeof androidRequest.offer_sdp === "string"
            ? androidRequest.offer_sdp
            : "";

        const caseContext =
          typeof androidRequest.case_context === "string"
            ? androidRequest.case_context
            : "";

        if (!offerSdp.startsWith("v=0")) {
          res.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8"
          });
          res.end(JSON.stringify({
            error: "offer_sdp ausente o invalido"
          }));
          return;
        }

        const session = {
          model: "gpt-live-1"
        };

        // Mandamos el contexto inicial del diagnóstico a GPT-Live.
        if (caseContext.trim()) {
          session.instructions =
            "Eres EduCopilot, copiloto de diagnosis de automocion. " +
            "Habla de forma natural con el mecanico. " +
            "No inventes datos ni des por averiado un componente solo por un DTC. " +
            "Usa el contexto disponible y pide una prueba discriminante cuando sea necesaria.\n\n" +
            "Contexto actual del caso:\n" +
            caseContext;
        }

        const openai = await fetch(
          "https://api.openai.com/v1/live/sessions",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${OPENAI_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              session,
              transport: {
                type: "webrtc",
                sdp: offerSdp
              }
            })
          }
        );

        const text = await openai.text();

        if (!openai.ok) {
          console.error(
            "OpenAI Live error:",
            openai.status,
            text
          );

          res.writeHead(openai.status, {
            "Content-Type": "application/json; charset=utf-8"
          });

          res.end(text);
          return;
        }

        let data;

        try {
          data = JSON.parse(text);
        } catch {
          throw new Error("OpenAI devolvio una respuesta no JSON");
        }

        const answerSdp =
          data?.transport?.sdp || "";

        if (!answerSdp) {
          console.error(
            "Respuesta OpenAI sin transport.sdp:",
            text
          );

          res.writeHead(502, {
            "Content-Type": "application/json; charset=utf-8"
          });

          res.end(JSON.stringify({
            error: "OpenAI no devolvio transport.sdp"
          }));
          return;
        }

        // IMPORTANTE:
        // GptLiveSessionBroker470.java espera exactamente
        // answer_sdp + session_id.
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8"
        });

        res.end(JSON.stringify({
          answer_sdp: answerSdp,
          session_id: data?.id || ""
        }));

      } catch (error) {
        console.error("Broker error:", error);

        res.writeHead(500, {
          "Content-Type": "application/json; charset=utf-8"
        });

        res.end(JSON.stringify({
          error: "Error creando sesion GPT-Live"
        }));
      }
    });

    return;
  }

  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `EduCopilot Live Broker escuchando en puerto ${PORT}`
  );
});
