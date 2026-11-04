const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let waitingPlayer = null;
let roomNumber = 0;

app.get("/", (req, res) => {
  res.send("Donya Ye Raqabat Server is Online!");
});

wss.on("connection", (ws) => {
  if (waitingPlayer && waitingPlayer.readyState === WebSocket.OPEN) {
    const room = ++roomNumber;

    ws.room = room;
    waitingPlayer.room = room;

    ws.send(JSON.stringify({ type: "matched", room }));
    waitingPlayer.send(JSON.stringify({ type: "matched", room }));

    waitingPlayer = null;
  } else {
    waitingPlayer = ws;
    ws.send(JSON.stringify({ type: "waiting" }));
  }

  ws.on("message", (message) => {
    wss.clients.forEach((client) => {
      if (
        client !== ws &&
        client.readyState === WebSocket.OPEN &&
        client.room === ws.room
      ) {
        client.send(message.toString());
      }
    });
  });

  ws.on("close", () => {
    if (waitingPlayer === ws) waitingPlayer = null;

    wss.clients.forEach((client) => {
      if (
        client !== ws &&
        client.readyState === WebSocket.OPEN &&
        client.room === ws.room
      ) {
        client.send(JSON.stringify({ type: "opponent_left" }));
      }
    });
  });
});

server.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("Game server is running!");
});
