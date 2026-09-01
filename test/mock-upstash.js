// Minimal in-memory Upstash REST mock used by the persistence tests.
const http = require('http');
const db = new Map();
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let cmd = [];
    try { cmd = JSON.parse(body || '[]'); } catch (e) {}
    const [op, key, val] = cmd;
    let result = null;
    if (op === 'GET') result = db.has(key) ? db.get(key) : null;
    else if (op === 'SET') { db.set(key, val); result = 'OK'; }
    else if (op === 'DEL') { result = db.delete(key) ? 1 : 0; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result }));
  });
});
server.listen(Number(process.env.MOCK_PORT || 7999), '127.0.0.1', () => {
  console.log('mock upstash on', server.address().port);
});
