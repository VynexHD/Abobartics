const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

const srv = http.createServer((req, res) => {
  if (req.url === '/api/avatars') {
    let l = [];
    try { l = fs.readdirSync(path.join(PUB, 'Pictures')).filter(f => /^foto\d+\.(png|jpe?g|webp|gif)$/i.test(f)).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4))); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(l));
  }
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(PUB, path.normalize(p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' }); res.end(d);
  });
});

const wss = new WebSocketServer({ server: srv, maxPayload: 8 * 1024 * 1024 });
const rooms = {};
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const bcast = (r, o) => r.players.forEach(p => send(p.ws, o));
const newCode = () => { let c; do { c = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join(''); } while (rooms[c]); return c; };
const clean = (s, n) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n);
const num = (v, min, max) => { v = String(v).trim(); return /^\d+$/.test(v) && +v >= min && +v <= max ? +v : null; };

const parseSet = s => { s = s || {}; const set = { games: num(s.games, 1, 10), w: num(s.w, 30, 3600), d: num(s.d, 300, 3600), g: num(s.g, 60, 3600) }; return Object.values(set).some(v => v === null) ? null : set; };
const lobby = r => bcast(r, { t: 'lobby', code: r.code, host: r.hostId, set: r.set, players: r.players.map(p => ({ id: p.id, name: p.name, av: p.av })) });

// telefone sem fio contínuo: etapa 0 = escrever; depois cada partida = desenhar (ímpar) + adivinhar (par).
// O palpite de uma partida vira o tema do desenho da próxima. Na etapa s, o jogador i pega a corrente (i+s)%N,
// então ninguém recebe diretamente o que ele mesmo acabou de escrever ou desenhar.
function startGame(r) {
  r.state = 'play';
  r.order = r.players.filter(p => !p.gone);
  r.steps = 1 + 2 * r.set.games;
  r.chains = r.order.map(() => Array(r.steps).fill(null));
  r.phase = 0; begin(r);
}

const kind = ph => ph === 0 ? 0 : ph % 2 ? 1 : 2;

function begin(r) {
  clearTimeout(r.t1); clearTimeout(r.t2); r.subs = {};
  const ph = r.phase, N = r.order.length, k = kind(ph), secs = [r.set.w, r.set.d, r.set.g][k];
  r.order.forEach((p, i) => send(p.ws, { t: 'phase', phase: ph, kind: k, game: ph ? Math.ceil(ph / 2) : 0, total: r.set.games, secs, n: r.steps, prompt: ph ? r.chains[(i + ph) % N][ph - 1] : null }));
  r.t1 = setTimeout(() => { bcast(r, { t: 'timeup' }); r.t2 = setTimeout(() => end(r, ph), 2500); }, secs * 1000);
}

function end(r, ph) {
  if (r.phase !== ph || r.state !== 'play') return;
  clearTimeout(r.t1); clearTimeout(r.t2);
  const N = r.order.length;
  if (++r.phase >= r.steps) {
    const chains = r.chains.map((c, ci) => ({ items: c.map((d, p) => { const a = r.order[(((ci - p) % N) + N) % N]; return { by: a.name, av: a.av, d }; }) }));
    r.state = 'reveal'; bcast(r, { t: 'reveal', chains, host: r.hostId });
  } else begin(r);
}

function check(r) {
  const live = r.order.filter(p => !p.gone);
  if (live.length && live.every(p => r.subs[p.id])) end(r, r.phase);
}

wss.on('connection', ws => {
  let r, me;
  const err = msg => send(ws, { t: 'err', msg });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'ping') return send(ws, { t: 'pong' });

    if (m.t === 'create' || m.t === 'join') {
      if (me) return;
      const name = clean(m.name, 14);
      if (!name) return err('Digite um nome.');
      const av = /^foto\d+\.(png|jpe?g|webp|gif)$/i.test(m.av) ? m.av : 'foto1.png';
      const p = { id: Math.random().toString(36).slice(2), name, av, ws };
      if (m.t === 'create') {
        const set = parseSet(m.set);
        if (!set) return err('Configuração inválida: use apenas números e respeite os mínimos.');
        r = { code: newCode(), hostId: p.id, players: [p], set, state: 'lobby', game: 0 };
        rooms[r.code] = r;
      } else {
        r = rooms[clean(m.code, 5).toUpperCase()];
        if (!r) return err('Sala não encontrada.');
        if (r.state !== 'lobby') { r = null; return err('A partida já começou.'); }
        if (r.players.length >= 8) { r = null; return err('Sala cheia (máximo 8).'); }
        r.players.push(p);
      }
      me = p; send(ws, { t: 'joined', id: me.id }); lobby(r);
    }
    else if (!r || !me) return;
    else if (m.t === 'start') {
      if (me.id !== r.hostId || r.state !== 'lobby') return;
      if (r.players.length < 3) return err('Mínimo de 3 jogadores para começar.');
      r.game = 0; r.done = []; startGame(r);
    }
    else if (m.t === 'submit') {
      if (r.state !== 'play' || m.phase !== r.phase) return;
      const idx = r.order.indexOf(me); if (idx < 0) return;
      if (typeof m.data === 'string') {
        const d = kind(r.phase) === 1 ? (m.data.startsWith('data:image/jpeg;base64,') ? m.data : null) : (clean(m.data, 120) || null);
        r.chains[(idx + r.phase) % r.order.length][r.phase] = d;
      }
      if (m.ready) r.subs[me.id] = 1; else delete r.subs[me.id];
      bcast(r, { t: 'prog', n: Object.keys(r.subs).length, total: r.order.filter(p => !p.gone).length });
      if (m.ready) check(r);
    }
    else if (m.t === 'set') {
      if (me.id !== r.hostId || r.state !== 'lobby') return;
      const set = parseSet(m.set); if (!set) return err('Configuração inválida: use apenas números e respeite os mínimos.');
      r.set = set; lobby(r);
    }
    else if (m.t === 'next') {
      if (me.id !== r.hostId || r.state !== 'reveal') return;
      r.state = 'lobby'; r.game = 0; lobby(r);
    }
    else if (m.t === 'skip') { if (me.id === r.hostId && r.state === 'reveal') bcast(r, { t: 'skip' }); }
  });

  ws.on('close', () => {
    if (!r || !me) return;
    if (r.state === 'lobby') r.players = r.players.filter(p => p !== me); else me.gone = true;
    const alive = r.players.filter(p => !p.gone && p.ws.readyState === 1);
    if (!alive.length) { clearTimeout(r.t1); clearTimeout(r.t2); delete rooms[r.code]; return; }
    if (r.hostId === me.id) r.hostId = alive[0].id;
    if (r.state === 'lobby') lobby(r); else if (r.state === 'play') check(r);
  });
});

setInterval(() => wss.clients.forEach(c => c.readyState === 1 && c.ping()), 20000);
const PORT = process.env.PORT || 3000;
srv.listen(PORT, () => console.log('Rabisco rodando em http://localhost:' + PORT));