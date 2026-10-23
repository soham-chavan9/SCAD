import http from "node:http";

const port = Number(process.env.PORT ?? 8080);

http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`http-echo listening on ${port}`);
  });
