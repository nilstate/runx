import http from 'http';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg_001' }));
});

server.listen(8732, '127.0.0.1', () => {
  console.log('Mock Nango proxy listening on 127.0.0.1:8732');
});
