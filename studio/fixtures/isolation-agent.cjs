const fs = require('fs');
const assert = require('assert/strict');
const net = require('net');
const { createHash } = require('crypto');

assert.equal(fs.readFileSync('/checkout/scene.txt', 'utf8'), 'original fixture checkout');
assert.throws(() => fs.readFileSync(process.env.FIXTURE_HOST_SECRET_PATH), e => ['ENOENT', 'EACCES'].includes(e.code));
assert.equal(process.env.STUDIO_HOST_ONLY, undefined);
assert.equal(process.env.FIXTURE_GATEWAY_KEY, undefined);
assert.ok(!Object.values(process.env).some(value => createHash('sha256').update(value).digest('hex') === process.env.FIXTURE_GATEWAY_KEY_HASH));
assert.throws(() => fs.readFileSync(process.env.FIXTURE_GATEWAY_KEY_PATH), e => ['ENOENT', 'EACCES'].includes(e.code));
assert.throws(() => fs.writeFileSync('/checkout/scene.txt', 'changed'), e => ['EROFS', 'EACCES'].includes(e.code));
assert.throws(() => fs.writeFileSync('/checkout/new.txt', 'changed'), e => ['EROFS', 'EACCES'].includes(e.code));
const blocked = (host, port, expected) => new Promise((resolve, reject) => {
  const socket = net.connect({ host, port, timeout: 2000 });
  socket.on('connect', () => { socket.destroy(); reject(Error('unexpected network access')); });
  socket.on('timeout', () => { socket.destroy(); reject(Error('network check timed out')); });
  socket.on('error', error => expected.includes(error.code) ? resolve() : reject(error));
});
Promise.all([blocked('127.0.0.1', Number(process.env.FIXTURE_HOST_PORT), ['ECONNREFUSED', 'ENETUNREACH']), blocked('1.1.1.1', 443, ['ENETUNREACH'])]).then(() => {
  fs.writeFileSync('/workspace/agent-output', 'scratch works', { flag: 'wx' });
  setTimeout(() => console.log('ISOLATION_TOOL_OK'), process.env.FIXTURE_PAUSE_TOOL ? 1500 : 0);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
