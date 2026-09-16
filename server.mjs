import http from "node:http";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const server = http.createServer(async (req, res) => {
  // Comprobación sencilla de que el servidor está vivo
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("EduCopilot Live Broker OK");
    return;
  }

  // EduCopilot envía aquí su oferta WebRTC (SDP)
  if (req.method === "POST" && req.url === "/v1/live/session") {
    if (!OPENAI_API_KEY) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("OPENAI_API_KEY no configurada");
      return;
    }

    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", async () => {
      try {
        const openai = await fetch("https://api.openai.com/v1/live/sessions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            session: {
              model: "gpt-live-1"
            },
            transport: {
              type: "webrtc",
              sdp: body
            }
          })
        });

        const text = await openai.text();

        if (!openai.ok) {
          console.error("OpenAI:", openai.status, text);
          res.writeHead(openai.status, {
            "Content-Type": "text/plain; charset=utf-8"
          });
          res.end(text);
          return;
        }

        const data = JSON.parse(text);

        if (!data?.transport?.sdp) {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("OpenAI no devolvio transport.sdp");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "application/sdp"
        });
        res.end(data.transport.sdp);

      } catch (error) {
        console.error(error);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error creando sesion Live");
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
  console.log(`EduCopilot Live Broker escuchando en puerto ${PORT}`);
});
