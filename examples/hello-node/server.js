import http from "node:http";

const port = Number(process.env.PORT ?? 8080);

http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello from scad\n");
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`hello-node listening on ${port}`);
  });
