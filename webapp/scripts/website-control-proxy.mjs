import http from 'node:http';
import https from 'node:https';

const listenPort = Number(process.env.PROXY_PORT || 8786);
const upstreamPort = Number(process.env.WEBSITE_PORT || 8788);

const server = http.createServer((req, res) => {
    const proxyReq = https.request(
        {
            hostname: '127.0.0.1',
            port: upstreamPort,
            path: req.url,
            method: req.method,
            servername: 'localhost',
            rejectUnauthorized: false,
            headers: {
                ...req.headers,
                host: `localhost:${upstreamPort}`
            }
        },
        (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
            proxyRes.pipe(res);
        }
    );
    proxyReq.on('error', (error) => {
        if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/plain' });
        }
        res.end(error instanceof Error ? error.message : String(error));
    });
    req.pipe(proxyReq);
});

server.listen(listenPort, '127.0.0.1', () => {
    process.stdout.write(
        `[website-control-proxy] http://127.0.0.1:${listenPort} -> https://localhost:${upstreamPort}\n`
    );
});
