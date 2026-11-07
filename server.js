'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Railway: mount a persistent Volume at /app/data. Never put credentials in GitHub.
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.GYMCLO_DATA_DIR || (process.env.RAILWAY_ENVIRONMENT ? '/app/data' : path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'gymclo.json');
const PROOF_DIR = path.join(DATA_DIR, 'proofs');
const SETUP_CODE = process.env.GYMCLO_SETUP_CODE || '';
const SESSION_SECRET = process.env.GYMCLO_SESSION_SECRET || '';
const COOKIE_NAME = 'gymclo_session';
const SESSION_SECONDS = 7 * 24 * 3600;
const ADMIN_PIN = process.env.GYMCLO_ADMIN_PIN || '';
const ADMIN_SECONDS = 15 * 60;
const PIN_ATTEMPTS = new Map();
const DEFAULTS = [
  '40 bodyweight squats + 30-second plank',
  '60 alternating lunges + 60-second plank',
  '80 bodyweight squats + 90-second wall sit',
  '15-minute brisk incline walk + 60 walking lunges'
];

if (!SETUP_CODE || SETUP_CODE.length < 12 || !SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('Configure GYMCLO_SETUP_CODE (12+ characters) and GYMCLO_SESSION_SECRET (32+ characters) as Railway service Variables.');
  process.exit(1);
}
fs.mkdirSync(PROOF_DIR, { recursive: true });
function emptyState() {
  return { profiles: [], checkins: [], rules: [], done: [], proposals: [], proposalVotes: [], mvpVotes: [], defaults: DEFAULTS, cycleRules: [], reactions: [], messages: [], messageReactions: [], audit: [] };
}
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : emptyState();
if (!db.mvpCrown || typeof db.mvpCrown !== 'object' || Array.isArray(db.mvpCrown)) db.mvpCrown = null;
if (!db.jukebox || typeof db.jukebox !== 'object' || Array.isArray(db.jukebox)) db.jukebox = {url:'',title:'',selectedBy:null,updatedAt:0};
// Retain the previously selected track when upgrading an existing installation.
if (!Array.isArray(db.radioHistory)) db.radioHistory = db.jukebox.url ? [{id:crypto.randomUUID(),...db.jukebox}] : [];

for (const [k, v] of Object.entries(emptyState())) if (!Array.isArray(db[k])) db[k] = v;
function persist() {
  const temporary = DB_FILE + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(temporary, DB_FILE);
}
function fail(message, status = 400) { const err = new Error(message); err.status = status; throw err; }
function send(res, status, data, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...extra
  });
  res.end(JSON.stringify(data));
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function pinValid(pin) { return typeof pin === 'string' && /^\d{4}$/.test(pin); }
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
}
function pinMatches(pin, stored) {
  if (!pinValid(pin) || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  const actual = crypto.scryptSync(pin, salt, 32).toString('hex');
  return safeEqual(actual, expected);
}
function publicProfile(p) { return { id: p.id, name: p.name, avatar: p.avatar || '', claimed: !!p.claimed, isAdmin: !!p.isAdmin }; }
function londonDay() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const t = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${t.year}-${t.month}-${t.day}`;
}
function monday(day) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
function cycleStart(day) { const anchor=Date.parse('2026-11-02T12:00:00Z');const week=Date.parse(monday(day)+'T12:00:00Z');return addDays('2026-11-02',Math.floor((week-anchor)/(28*86400000))*28); }
function cycleTarget(day) {return db.cycleRules.find(x=>x.start===cycleStart(day))?.target||4;}
function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0,10);
}
function nextMonth(m) {
  const [y, v] = m.split('-').map(Number);
  return v === 12 ? `${y + 1}-01` : `${y}-${String(v + 1).padStart(2,'0')}`;
}
function lastMonth(m) {
  const [y, v] = m.split('-').map(Number);
  return v === 1 ? `${y - 1}-12` : `${y}-${String(v - 1).padStart(2,'0')}`;
}
function monthWeeks(month) {
  let d = monday(month + '-01'); if (!d.startsWith(month)) d = addDays(d, 7);
  const dates = []; while (d.startsWith(month)) { dates.push(d); d = addDays(d, 7); }
  return dates;
}
function monthTarget(month) { return db.rules.find(x => x.month === month)?.target || 4; }
function activeCheckins(profileId, week) {
  return db.checkins.filter(c => c.profileId === profileId && c.week === week && !['rejected','deleted'].includes(c.status));
}
function attendanceDays(profileId, week) { return new Set(activeCheckins(profileId, week).map(c => c.day)).size; }
function eligibleForMvp(profileId, start, today) {
  if (cycleStart(start) !== start || addDays(start, 27) >= today) return false;
  return Array.from({length:4}, (_, i) => addDays(start, i * 7)).every(week =>
    attendanceDays(profileId, week) >= cycleTarget(week));
}
function validDay(day) {
  if (typeof day !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(day) ||
      Number.isNaN(Date.parse(day + 'T12:00:00Z')) || new Date(day+'T12:00:00Z').toISOString().slice(0,10) !== day)
    fail('Enter a valid date');
  return day;
}
const REACTION_EMOJIS = ['🔥','👏','💪','❤️','🏆'];
const MESSAGE_EMOJIS = ['❤️','😂','🔥','👏','💪','💎'];
const GIPHY_KEY = process.env.GYMCLO_GIPHY_API_KEY || '';
function gifId(value) { if (!value) return ''; const x=String(value).trim(); const match=/^https:\/\/(?:www\.)?giphy\.com\/(?:gifs\/(?:[a-z0-9-]+-)?|embed\/)([A-Za-z0-9]+)(?:[/?#].*)?$/i.exec(x) || /^https:\/\/media\.giphy\.com\/media\/([A-Za-z0-9]+)\/giphy\.gif(?:[?#].*)?$/i.exec(x); if(!match)fail('Use a valid GIPHY GIF link'); return match[1]; }
function messageText(text) { if (typeof text!=='string' || text.length>1000)fail('Message must be under 1,000 characters'); return text.trim(); }
function publicMessages(viewerId) {return db.messages.slice(-150).reverse().map(m=>({id:m.id,profileId:m.profileId,parentId:m.parentId||null,text:m.text,hasImage:!!m.image,gifId:m.gifId||'',createdAt:m.createdAt,editedAt:m.editedAt||null,reactions:MESSAGE_EMOJIS.map(emoji=>({emoji,count:db.messageReactions.filter(r=>r.messageId===m.id&&r.emoji===emoji).length})),myReaction:db.messageReactions.find(r=>r.messageId===m.id&&r.profileId===viewerId)?.emoji||''}));}

function published(c) { return !!(c && c.shareToFeed === true && c.status === 'approved' && c.hasProof && !c.adminAdded); }
function feedFor(viewerId) {
  return db.checkins.filter(published).sort((a,b) => b.createdAt-a.createdAt).slice(0,60).map(c => ({
    id:c.id,profileId:c.profileId,day:c.day,kind:c.kind,note:c.note,createdAt:c.createdAt,
    reactions:REACTION_EMOJIS.map(emoji=>({emoji,count:db.reactions.filter(r=>r.checkinId===c.id&&r.emoji===emoji).length})),
    myReaction:db.reactions.find(r=>r.checkinId===c.id&&r.profileId===viewerId)?.emoji||''
  }));
}

function cookie(req) {
  const all = String(req.headers.cookie || '').split(';').map(x => x.trim());
  const found = all.find(x => x.startsWith(COOKIE_NAME + '='));
  return found ? found.slice(COOKIE_NAME.length + 1) : '';
}
function sign(profile) {
  const data = Buffer.from(JSON.stringify({ sub: profile.id, v: profile.sessionVersion || 0, exp: Math.floor(Date.now()/1000)+SESSION_SECONDS })).toString('base64url');
  const digest = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${digest}`;
}
function currentUser(req) {
  try {
    const [payload, signature] = cookie(req).split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    if (!safeEqual(signature, expected)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp <= Date.now()/1000) return null;
    const user = db.profiles.find(p => p.id === data.sub);
    return user && user.claimed && data.v === (user.sessionVersion || 0) ? user : null;
  } catch { return null; }
}
function auth(req) { const p = currentUser(req); if (!p) fail('Please sign in again', 401); return p; }
function admin(req) {
  const p=auth(req);
  if (!p.isAdmin) fail('Admin access required',403);
  const token=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('gymclo_admin='))?.slice(13)||'';
  const [stamp,sig]=token.split('.');
  if (!stamp || !sig || !/^\d+$/.test(stamp) || Number(stamp)<Date.now()/1000 || Number(stamp)>Date.now()/1000+ADMIN_SECONDS) fail('Unlock admin with your PIN first',403);
  const expected=crypto.createHmac('sha256',SESSION_SECRET).update(`${p.id}:${p.sessionVersion||0}:${stamp}`).digest('base64url');
  if (!safeEqual(sig,expected)) fail('Unlock admin with your PIN first',403);
  return p;
}
function setLogin(res, profile) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sign(profile)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT ? '; Secure' : ''}`);
}
function clearLogin(res) { res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`); }
function attemptKey(req, id) { return `${req.socket.remoteAddress}:${id}`; }
function checkPinRate(req, id) {
  const key = attemptKey(req,id), entry = PIN_ATTEMPTS.get(key);
  if (entry && entry.until > Date.now() && entry.count >= 5) fail('Too many attempts. Try again in 15 minutes.', 429);
  if (entry && entry.until <= Date.now()) PIN_ATTEMPTS.delete(key);
}
function wrongPin(req, id) {
  const key = attemptKey(req,id), entry = PIN_ATTEMPTS.get(key) || { count:0, until:Date.now()+15*60*1000 };
  entry.count++; PIN_ATTEMPTS.set(key, entry);
  fail('Incorrect PIN or invitation code', 401);
}
function clearPinRate(req, id) { PIN_ATTEMPTS.delete(attemptKey(req,id)); }
function checkName(n) {
  if (typeof n !== 'string' || n.trim().length < 1 || n.trim().length > 28) fail('Name must be between 1 and 28 characters');
  return n.trim();
}
function checkMonth(m) { if (typeof m !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(m)) fail('Invalid month'); return m; }
function photoData(value, maxBytes = 550000) {
  if (typeof value !== 'string') fail('Please select a JPG, PNG or WebP image');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) fail('Only JPG, PNG or WebP images are supported');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > maxBytes) fail('Photo is too large. Try a smaller one.');
  const mime = match[1];
  const valid = mime === 'image/jpeg' && data[0] === 0xff && data[1] === 0xd8 ||
    mime === 'image/png' && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
    mime === 'image/webp' && data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP';
  if (!valid) fail('Invalid image file');
  return { mime, data, value };
}
async function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let count = 0, chunks = [];
    req.on('data', chunk => {
      count += chunk.length;
      if (count > 2 * 1024 * 1024) { reject(Object.assign(new Error('Upload exceeds the 2 MB limit'), {status:413})); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('Invalid request'), {status:400})); } });
    req.on('error', reject);
  });
}
function validateOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  try { if (new URL(origin).host !== req.headers.host) fail('Untrusted request origin', 403); }
  catch (e) { if (e.status) throw e; fail('Invalid request origin', 403); }
}
function validForfeits(a) {
  if (!Array.isArray(a) || a.length !== 4 || a.some(x => typeof x !== 'string' || !x.trim() || x.length > 180)) fail('Provide exactly four fitness forfeits (one per week)');
  return a.map(x => x.trim());
}
const id = () => crypto.randomUUID();
const code = () => crypto.randomBytes(9).toString('hex').toUpperCase();

async function route(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const uri = u.pathname;
  if (req.method === 'GET' && uri === '/health') return send(res, 200, { ok:true });
  if (req.method === 'GET' && (uri === '/' || uri === '/index.html')) {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
    return fs.createReadStream(path.join(__dirname,'public','index.html')).pipe(res);
  }
  if (!uri.startsWith('/api/')) return send(res, 404, {error:'Not found'});
  const user = currentUser(req);
  if (req.method === 'GET' && uri === '/api/bootstrap')
    return send(res,200,{ setupRequired:db.profiles.length === 0, profiles:db.profiles.map(publicProfile), me:user?publicProfile(user):null, today:londonDay() });
  if (req.method === 'GET' && uri === '/api/admin/pending-count') {
    const who=auth(req);
    if(!who.isAdmin)fail('Admin access required',403);
    return send(res,200,{count:db.checkins.filter(c=>c.status==='pending'&&c.hasProof).length});
  }
  if (req.method === 'GET' && uri === '/api/admin/status') {
    try { admin(req); return send(res,200,{unlocked:true}); } catch {return send(res,200,{unlocked:false});}
  }
  if (req.method === 'GET' && uri === '/api/state') {
    const me = auth(req);
    const checkins = db.checkins.filter(c => c.status !== 'deleted').map(c => me.isAdmin || me.id === c.profileId ? c : {
      id:c.id,profileId:c.profileId,day:c.day,week:c.week,kind:c.kind,status:c.status,
      createdAt:c.createdAt,hasProof:false,adminAdded:!!c.adminAdded
    });
    return send(res,200,{ me:publicProfile(me), profiles:db.profiles.map(publicProfile), today:londonDay(),
      wallpaper:me.wallpaper||{theme:'ember',dim:0.18,photo:'',textColor:'default'}, defaults:db.defaults,
      rules:db.rules,checkins,done:db.done,cycleRules:db.cycleRules,
      proposals:db.proposals,proposalVotes:db.proposalVotes,mvpVotes:db.mvpVotes,mvpCrown:db.mvpCrown,feed:feedFor(me.id),messages:publicMessages(me.id),giphyEnabled:!!GIPHY_KEY,jukebox:db.jukebox,radioHistory:db.radioHistory });
  }
  const feedImage=/^\/api\/feed\/([a-f0-9-]+)\/image$/.exec(uri);
  if (req.method === 'GET' && feedImage) {
    auth(req);
    const c=db.checkins.find(x=>x.id===feedImage[1]);
    if (!published(c)) fail('Photo not available',404);
    const file=path.join(PROOF_DIR,c.id+'.jpg');
    if (!fs.existsSync(file)) fail('Photo not found',404);
    res.writeHead(200,{'Content-Type':c.proofMime||'image/jpeg','Cache-Control':'private, no-store',
      'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});
    return fs.createReadStream(file).pipe(res);
  }
  const messageImage=/^\/api\/messages\/([a-f0-9-]+)\/image$/.exec(uri);
  if(req.method==='GET'&&messageImage){auth(req);const m=db.messages.find(x=>x.id===messageImage[1]);if(!m||!m.image)fail('Image unavailable',404);const pic=photoData(m.image,550000);res.writeHead(200,{'Content-Type':pic.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});return res.end(pic.data);}
  if (req.method==='GET' && uri==='/api/giphy/search') {auth(req);if(!GIPHY_KEY)fail('GIPHY search is not configured',503);const query=String(u.searchParams.get('q')||'').trim().slice(0,50);if(!query)fail('Enter a search');const upstream=new URL('https://api.giphy.com/v1/gifs/search');upstream.searchParams.set('api_key',GIPHY_KEY);upstream.searchParams.set('q',query);upstream.searchParams.set('limit','12');upstream.searchParams.set('rating','pg');const response=await fetch(upstream,{signal:AbortSignal.timeout(7000)});if(!response.ok)fail('GIPHY search unavailable',502);const data=await response.json();return send(res,200,{gifs:(data.data||[]).map(x=>({id:x.id,url:x.images?.fixed_width?.url||''})).filter(x=>/^[A-Za-z0-9]+$/.test(x.id)).slice(0,12)});}
  if (req.method === 'GET' && uri === '/api/jukebox') { auth(req); return send(res,200,{jukebox:db.jukebox,radioHistory:db.radioHistory}); }
  if (req.method === 'GET' && uri === '/api/feed') { const me=auth(req);return send(res,200,{feed:feedFor(me.id)}); }

  // Only an authenticated message author can remove a chat post or reply.
  const messageDelete=/^\/api\/messages\/([a-f0-9-]+)$/.exec(uri);
  if (req.method==='DELETE' && messageDelete) {
    validateOrigin(req);
    const who=auth(req);
    const message=db.messages.find(m=>m.id===messageDelete[1]);
    if (!message) fail('Message not found',404);
    if (message.profileId!==who.id) fail('You can only delete your own posts',403);
    // Deleting a parent also removes its replies and their reactions.
    const removed=new Set([message.id]);
    if (!message.parentId) db.messages.filter(m=>m.parentId===message.id).forEach(m=>removed.add(m.id));
    db.messages=db.messages.filter(m=>!removed.has(m.id));
    db.messageReactions=db.messageReactions.filter(r=>!removed.has(r.messageId));
    persist();return send(res,200,{ok:true,deleted:removed.size});
  }
  if (!['POST','PATCH','DELETE'].includes(req.method)) fail('Method not allowed', 405);
  validateOrigin(req);
  const b = await bodyJson(req);

  if (req.method === 'POST' && uri === '/api/setup') {
    if (db.profiles.length) fail('Gymclo has already been set up',403);
    if (!safeEqual(b.setupCode, SETUP_CODE)) fail('Invalid setup code',403);
    if (!pinValid(b.pin)) fail('PIN must be exactly four digits');
    const profile = {id:id(),name:checkName(b.name),avatar:'',isAdmin:true,claimed:true,pinHash:hashPin(b.pin),sessionVersion:0};
    db.profiles.push(profile);persist();setLogin(res,profile);return send(res,200,{ok:true});
  }
  if (req.method === 'POST' && uri === '/api/login') {
    const p = db.profiles.find(x=>x.id===b.profileId);
    checkPinRate(req,b.profileId);
    if (!p || !p.claimed || !pinMatches(b.pin,p.pinHash)) wrongPin(req,b.profileId);
    clearPinRate(req,b.profileId);setLogin(res,p);return send(res,200,{ok:true});
  }
  if (req.method === 'POST' && uri === '/api/claim') {
    const p = db.profiles.find(x=>x.id===b.profileId);
    checkPinRate(req,b.profileId);
    if (!p || p.claimed || !safeEqual(String(b.claimCode||'').trim().toUpperCase(),p.claimCode)) wrongPin(req,b.profileId);
    if (!pinValid(b.pin)) fail('PIN must be exactly four digits');
    p.pinHash=hashPin(b.pin);p.claimed=true;delete p.claimCode;p.sessionVersion=(p.sessionVersion||0)+1;
    persist();clearPinRate(req,b.profileId);setLogin(res,p);return send(res,200,{ok:true});
  }
  if (req.method === 'POST' && uri === '/api/admin/unlock') {
    const p=auth(req);if (!p.isAdmin) fail('Admin access required',403);
    checkPinRate(req, 'admin:'+p.id);
    // GYMCLO_ADMIN_PIN is configured in Railway (2002), never shipped to browser.
    // Until configured, the owner's existing login PIN is used.
    const valid=ADMIN_PIN ? safeEqual(String(b.pin), ADMIN_PIN) : pinMatches(b.pin,p.pinHash);
    if (!valid) wrongPin(req,'admin:'+p.id);
    clearPinRate(req,'admin:'+p.id);
    const expiry=Math.floor(Date.now()/1000)+ADMIN_SECONDS;
    const sig=crypto.createHmac('sha256',SESSION_SECRET).update(`${p.id}:${p.sessionVersion||0}:${expiry}`).digest('base64url');
    res.setHeader('Set-Cookie',`gymclo_admin=${expiry}.${sig}; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=${ADMIN_SECONDS}${process.env.RAILWAY_ENVIRONMENT?'; Secure':''}`);
    return send(res,200,{ok:true});
  }
  if (req.method === 'POST' && uri === '/api/logout') { clearLogin(res);res.setHeader('Set-Cookie',[`${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,'gymclo_admin=; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=0']);return send(res,200,{ok:true}); }

  if (req.method === 'PATCH' && uri === '/api/me/wallpaper') {
    const me=auth(req),theme=String(b.theme||'ember'),dim=Number(b.dim);
    if (!['ember','oxide','slate','noir'].includes(theme) || !Number.isFinite(dim) || dim<0 || dim>0.7) fail('Invalid wallpaper settings');
    const photo=b.photo ? photoData(b.photo, 550000).value : '';
    const textColor=String(b.textColor||'default');if(!['default','rose','ice','mint','gold','lavender','warm'].includes(textColor))fail('Invalid text colour');me.wallpaper={theme,dim,photo,textColor};persist();return send(res,200,{ok:true});
  }
  if (req.method === 'POST' && uri === '/api/jukebox') {
    const user = auth(req);
    let url;
    try { url = new URL(String(b.url || '').trim()); } catch { fail('Enter a valid SoundCloud track URL'); }
    if (url.protocol !== 'https:' || !['soundcloud.com','www.soundcloud.com','m.soundcloud.com'].includes(url.hostname) ||
        url.pathname.split('/').filter(Boolean).length < 2 || url.toString().length > 400)
      fail('Paste a public SoundCloud track or playlist link');
    // Restrict URLs to real SoundCloud pages. Never fetch user-supplied URLs on our server.
    url.hash = '';
    const title=typeof b.title==='string' && b.title.trim() ? b.title.trim().slice(0,120) :
      decodeURIComponent(url.pathname.split('/').filter(Boolean).slice(-1)[0]).replace(/-/g,' ').slice(0,120);
    // Keep a persistent record of all selected songs with author attribution.
    const song={id:crypto.randomUUID(),url:url.toString(),title,selectedBy:user.id,updatedAt:Date.now()};
    db.jukebox={url:song.url,title:song.title,selectedBy:song.selectedBy,updatedAt:song.updatedAt};
    db.radioHistory.unshift(song);
    persist();return send(res,200,{ok:true,jukebox:db.jukebox,radioHistory:db.radioHistory});
  }
  const historySelect=/^\/api\/radio-history\/([a-f0-9-]+)\/select$/.exec(uri);
  if (req.method==='POST' && historySelect) {
    const who=auth(req),song=db.radioHistory.find(x=>x.id===historySelect[1]);
    if(!song)fail('Song not found',404);
    if(song.selectedBy!==who.id)fail('Only the member who added this track can select it',403);
    db.jukebox={url:song.url,title:song.title,selectedBy:song.selectedBy,updatedAt:Date.now()};
    persist();return send(res,200,{ok:true,jukebox:db.jukebox,radioHistory:db.radioHistory});
  }
  const historyDelete=/^\/api\/radio-history\/([a-f0-9-]+)$/.exec(uri);
  if(req.method==='DELETE' && historyDelete) {
    const who=auth(req),song=db.radioHistory.find(x=>x.id===historyDelete[1]);
    if(!song)fail('Song not found',404);
    if(song.selectedBy!==who.id)fail('Only the member who added this track can delete it',403);
    const active=db.jukebox?.url===song.url&&db.jukebox?.selectedBy===song.selectedBy;
    db.radioHistory=db.radioHistory.filter(x=>x.id!==song.id);
    // Do not cut off a playing track if only its archive entry was removed.
    // Clear only if the deleted song was the sole matching history entry.
    if(active&&!db.radioHistory.some(x=>x.url===song.url&&x.selectedBy===song.selectedBy))db.jukebox={url:'',title:'',selectedBy:null,updatedAt:Date.now()};
    persist();return send(res,200,{ok:true,jukebox:db.jukebox,radioHistory:db.radioHistory});
  }
  const deleteSession=/^\/api\/admin\/checkins\/([a-f0-9-]+)\/delete$/.exec(uri);
  if (req.method === 'POST' && deleteSession) {
    const who=admin(req),c=db.checkins.find(x=>x.id===deleteSession[1]);
    if (!c) fail('Session not found',404);
    if (c.status !== 'approved') fail('Only approved sessions can be removed',400);
    c.status='deleted';c.deletedBy=who.id;c.deletedAt=Date.now();c.shareToFeed=false;
    db.reactions=db.reactions.filter(r=>r.checkinId!==c.id);
    db.audit.push({event:'approved-session-removed',checkinId:c.id,profileId:c.profileId,day:c.day,adminId:who.id,at:c.deletedAt});
    persist();return send(res,200,{ok:true});
  }
  if (req.method === 'POST' && uri === '/api/admin/checkins') {
    const who=admin(req),day=validDay(b.day),profile=db.profiles.find(p=>p.id===b.profileId);
    if (!profile) fail('Profile not found',404);
    if (day > londonDay()) fail('Cannot record a future session');
    if (db.checkins.filter(c=>c.profileId===profile.id && c.day===day && c.status!=='deleted').length >= 20) fail('Daily safety limit of 20 sessions reached');
    if (!['push','pull','legs','cardio','other'].includes(b.kind)) fail('Choose a valid workout type');
    if (typeof b.note !== 'string'||b.note.length>180) fail('Notes cannot exceed 180 characters');
    const checkin={id:id(),profileId:profile.id,day,week:monday(day),kind:b.kind,note:b.note,
      status:'approved',createdAt:Date.now(),hasProof:false,adminAdded:true,shareToFeed:false,addedBy:who.id};
    db.checkins.unshift(checkin);
    db.audit.push({event:'admin-checkin-added',checkinId:checkin.id,profileId:profile.id,day,adminId:who.id,at:Date.now()});
    persist();return send(res,200,{ok:true});
  }
  if (req.method === 'POST' && uri === '/api/profiles') {
    admin(req);
    if (db.profiles.length >= 40) fail('Maximum of 40 profiles reached');
    const avatar = b.avatar ? photoData(b.avatar).value : '';
    const p = {id:id(),name:checkName(b.name),avatar,claimed:false,isAdmin:false,claimCode:code(),sessionVersion:0};
    db.profiles.push(p);persist();return send(res,200,{ok:true,profileId:p.id,inviteCode:p.claimCode});
  }
  const reset = /^\/api\/profiles\/([^/]+)\/reset$/.exec(uri);
  if (reset && req.method === 'POST') {
    admin(req);const p=db.profiles.find(x=>x.id===reset[1]);if(!p)fail('Profile not found',404);
    if (p.isAdmin) fail('The owner PIN cannot be reset here',403);
    p.claimed=false;p.pinHash='';p.claimCode=code();p.sessionVersion=(p.sessionVersion||0)+1;
    persist();return send(res,200,{inviteCode:p.claimCode});
  }
  const edit = /^\/api\/profiles\/([^/]+)$/.exec(uri);
  if (edit && req.method === 'PATCH') {
    const who=auth(req),p=db.profiles.find(x=>x.id===edit[1]);if(!p)fail('Profile not found',404);
    if (who.id!==p.id) admin(req); // Other people's profiles require the unlocked admin PIN.
    p.name=checkName(b.name);
    if (b.avatar !== undefined && b.avatar !== p.avatar) p.avatar=b.avatar ? photoData(b.avatar).value : '';
    persist();return send(res,200,{ok:true});
  }
  if (req.method === 'POST' && uri === '/api/messages') {
    const who=auth(req),body=messageText(b.text),parentId=b.parentId||null, gif=gifId(b.gifUrl||'');
    const parent=parentId?db.messages.find(m=>m.id===parentId):null;
    if(parentId&&!parent)fail('Original message not found',404);
    if(parent&&parent.parentId)fail('Reply to the original post instead');
    const image=b.image?photoData(b.image,550000).value:'';
    if(!body&&!image&&!gif)fail('Write a message or attach an image/GIF');
    if(db.messages.length>=300)fail('Message board is full; contact the admin');
    const now=Date.now(), recent=db.messages.filter(m=>m.profileId===who.id&&now-m.createdAt<60000).length;
    if(recent>=8)fail('Too many messages. Try again in a minute',429);
    db.messages.push({id:id(),profileId:who.id,parentId,text:body,image,gifId:gif,createdAt:now,editedAt:null});persist();return send(res,200,{ok:true});
  }
  const messageEdit=/^\/api\/messages\/([a-f0-9-]+)$/.exec(uri);
  if(messageEdit&&req.method==='PATCH'){
    const who=auth(req),m=db.messages.find(x=>x.id===messageEdit[1]);if(!m)fail('Message not found',404);
    if(m.profileId!==who.id)fail('You can only edit your own messages',403);
    const body=messageText(b.text),gif=gifId(b.gifUrl||'');
    const image=b.image===undefined?m.image:(b.image?photoData(b.image,550000).value:'');
    if(!body&&!image&&!gif)fail('Message cannot be empty');
    m.text=body;m.image=image;m.gifId=gif;m.editedAt=Date.now();persist();return send(res,200,{ok:true});
  }
  const messageReact=/^\/api\/messages\/([a-f0-9-]+)\/react$/.exec(uri);
  if(messageReact&&req.method==='POST'){
    const who=auth(req),m=db.messages.find(x=>x.id===messageReact[1]);if(!m)fail('Message not found',404);
    if(!MESSAGE_EMOJIS.includes(b.emoji))fail('Invalid reaction');
    const old=db.messageReactions.find(x=>x.messageId===m.id&&x.profileId===who.id);
    db.messageReactions=db.messageReactions.filter(x=>!(x.messageId===m.id&&x.profileId===who.id));
    if(old?.emoji!==b.emoji)db.messageReactions.push({messageId:m.id,profileId:who.id,emoji:b.emoji});
    persist();return send(res,200,{ok:true});
  }
  if (req.method === 'POST' && uri === '/api/checkins') {
    const who=auth(req), day=londonDay();
    if (db.checkins.filter(x=>x.profileId===who.id && x.day===day && x.status!=='deleted').length >= 20) fail('Daily safety limit of 20 sessions reached');
    if (!['push','pull','legs','cardio','other'].includes(b.kind)) fail('Invalid workout type');
    if (typeof b.note !== 'string' || b.note.length>180) fail('Notes cannot exceed 180 characters');
    const photo=photoData(b.proof);
    const proofId=id(), digest=crypto.createHash('sha256').update(photo.data).digest('hex');
    const flagged=db.checkins.some(x=>x.proofHash===digest);
    const proofFile=path.join(PROOF_DIR, proofId + '.jpg');
    fs.writeFileSync(proofFile,photo.data,{mode:0o600});
    db.checkins.unshift({id:proofId,profileId:who.id,day,week:monday(day),kind:b.kind,note:b.note,status:'pending',createdAt:Date.now(),hasProof:true,flagged,proofHash:digest,proofMime:photo.mime,shareToFeed:b.shareToFeed===true});
    persist();return send(res,200,{ok:true});
  }
  const visibility=/^\/api\/checkins\/([a-f0-9-]+)\/visibility$/.exec(uri);
  if (visibility && req.method === 'POST') {
    const me=auth(req),c=db.checkins.find(x=>x.id===visibility[1]);
    if (!c) fail('Session not found',404);
    if (c.profileId!==me.id) fail('Only the member can publish their own photo',403);
    if (!c.hasProof || c.adminAdded) fail('This session has no publishable photo');
    if (typeof b.visible !== 'boolean') fail('Invalid visibility');
    c.shareToFeed=b.visible;
    if (!b.visible) db.reactions=db.reactions.filter(x=>x.checkinId!==c.id);
    persist();return send(res,200,{ok:true});
  }
  const react=/^\/api\/feed\/([a-f0-9-]+)\/react$/.exec(uri);
  if (react && req.method === 'POST') {
    const me=auth(req),c=db.checkins.find(x=>x.id===react[1]);
    if (!published(c)) fail('This achievement is not published',404);
    if (typeof b.emoji!=='string'||!REACTION_EMOJIS.includes(b.emoji)) fail('Invalid reaction');
    const prior=db.reactions.find(r=>r.checkinId===c.id&&r.profileId===me.id);
    db.reactions=db.reactions.filter(r=>!(r.checkinId===c.id&&r.profileId===me.id));
    if (prior?.emoji!==b.emoji) db.reactions.push({checkinId:c.id,profileId:me.id,emoji:b.emoji});
    persist();return send(res,200,{ok:true});
  }
  const proof = /^\/api\/checkins\/([a-f0-9-]+)\/proof$/.exec(uri);
  if (proof && req.method === 'POST') fail('Method not allowed',405);
  if (req.method === 'POST' && uri === '/api/forfeit-completed') {
    admin(req);const p=db.profiles.find(x=>x.id===b.profileId);if(!p)fail('Unknown profile');
    if (typeof b.week!=='string'||!/^20\d\d-\d\d-\d\d$/.test(b.week))fail('Invalid week');
    const prior=db.done.find(x=>x.profileId===b.profileId&&x.week===b.week);
    if (prior) prior.completed=prior.completed?0:1;
    else db.done.push({profileId:b.profileId,week:b.week,month:b.week.slice(0,7),completed:1});
    persist();return send(res,200,{ok:true});
  }
  const review = /^\/api\/checkins\/([a-f0-9-]+)\/review$/.exec(uri);
  if (review && req.method==='POST') {
    admin(req);const c=db.checkins.find(x=>x.id===review[1]);if(!c)fail('Workout not found',404);
    if (!['approved','rejected','pending'].includes(b.status))fail('Invalid status');
    c.status=b.status;persist();return send(res,200,{ok:true});
  }
  if (req.method==='POST' && uri==='/api/cycle-rules') {
    admin(req);
    if (typeof b.start !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(b.start) || !Number.isFinite(Date.parse(b.start)) || cycleStart(b.start)!==b.start) fail('Invalid four-week cycle start');
    const target=Number(b.target);
    if (!Number.isInteger(target) || target<1 || target>7) fail('Weekly target must be 1–7');
    if (!Array.isArray(b.forfeits) || b.forfeits.length!==4 || b.forfeits.some(f=>typeof f!=='string'||!f.trim()||f.length>180)) fail('Exactly four forfeits required');
    db.cycleRules=db.cycleRules.filter(x=>x.start!==b.start);
    db.cycleRules.push({start:b.start,target,forfeits:b.forfeits.map(x=>x.trim())});
    persist(); return send(res,200,{ok:true});
  }
  if (req.method==='POST' && uri==='/api/rules') {
    admin(req);const month=checkMonth(b.month), target=Number(b.target);
    if (!Number.isInteger(target)||target<1||target>7)fail('Target must be between 1 and 7');
    const rules={month,target,forfeits:validForfeits(b.forfeits)};
    db.rules=db.rules.filter(x=>x.month!==month);db.rules.push(rules);persist();return send(res,200,{ok:true});
  }
  if (req.method==='POST' && uri==='/api/proposals') {
    const who=auth(req),title=String(b.title||'').trim();
    if (!title || title.length>64)fail('Title must be 1-64 characters');
    if (b.start!==addDays(cycleStart(londonDay()),28)) fail('Proposals must be for the next four-week cycle');
    db.proposals.push({id:id(),profileId:who.id,createdAt:Date.now(),start:b.start,title,forfeits:validForfeits(b.forfeits)});
    persist();return send(res,200,{ok:true});
  }
  if (req.method==='POST' && uri==='/api/proposal-votes') {
    const who=auth(req),p=db.proposals.find(x=>x.id===b.proposalId);
    if (!p||p.start!==addDays(cycleStart(londonDay()),28))fail('Proposal unavailable');
    db.proposalVotes=db.proposalVotes.filter(x=>!(x.start===p.start&&x.voterId===who.id));
    db.proposalVotes.push({start:p.start,voterId:who.id,proposalId:p.id});persist();return send(res,200,{ok:true});
  }
  if (req.method==='POST' && uri==='/api/apply-proposal') {
    admin(req);const p=db.proposals.find(x=>x.id===b.proposalId);if(!p)fail('Proposal not found');
    if (!p.start || cycleStart(p.start)!==p.start || !Array.isArray(p.forfeits) || p.forfeits.length!==4) fail('Only four-week proposals can be applied');
    const target=db.cycleRules.find(x=>x.start===p.start)?.target||4;
    db.cycleRules=db.cycleRules.filter(x=>x.start!==p.start);
    db.cycleRules.push({start:p.start,target,forfeits:p.forfeits});persist();return send(res,200,{ok:true});
  }
  // A manual crown is useful for bootstrapping a new crew or correcting exceptional outcomes.
  // The title belongs to exactly one profile and persists until deliberately replaced.
  if (req.method === 'POST' && uri === '/api/admin/mvp/crown') {
    const who = admin(req);
    const winner = db.profiles.find(p => p.id === b.profileId);
    if (!winner) fail('Choose an existing member', 404);
    db.mvpCrown = {profileId:winner.id, source:'admin', cycleStart:null, awardedAt:Date.now(), awardedBy:who.id};
    db.audit.push({event:'mvp-crown-manual',profileId:winner.id,adminId:who.id,at:Date.now()});
    persist(); return send(res,200,{ok:true,mvpCrown:db.mvpCrown});
  }
  // Finalize a completed challenge's vote. Existing crown survives when there are
  // no votes or a tie; an admin can resolve a tie with the manual selector.
  if (req.method === 'POST' && uri === '/api/admin/mvp/finalize') {
    const who=admin(req),start=String(b.start||''),today=londonDay();
    if (cycleStart(start)!==start || addDays(start,27)>=today) fail('The four-week challenge has not finished');
    const votes=db.mvpVotes.filter(v=>v.start===start);
    if (!votes.length) fail('No MVP votes to finalize');
    const tally=new Map();
    for(const v of votes) if(db.profiles.some(p=>p.id===v.candidateId)) tally.set(v.candidateId,(tally.get(v.candidateId)||0)+1);
    const sorted=[...tally].sort((a,b)=>b[1]-a[1]);
    if (!sorted.length) fail('No valid MVP votes');
    if (sorted.length>1&&sorted[0][1]===sorted[1][1]) fail('MVP votes are tied. Select a winner manually in Admin.');
    if (db.mvpCrown?.cycleStart && db.mvpCrown.cycleStart>start) fail('A newer MVP has already been crowned');
    db.mvpCrown={profileId:sorted[0][0],source:'vote',cycleStart:start,awardedAt:Date.now(),awardedBy:who.id};
    db.audit.push({event:'mvp-crown-voted',profileId:sorted[0][0],cycleStart:start,adminId:who.id,at:Date.now()});
    persist();return send(res,200,{ok:true,mvpCrown:db.mvpCrown,voteCount:votes.length});
  }
  if (req.method==='POST' && uri==='/api/mvp-votes') {
    const who=auth(req),start=b.start,candidate=db.profiles.find(x=>x.id===b.candidateId),today=londonDay();
    if (start!==addDays(cycleStart(today),-28)) fail('Only the previous four-week cycle MVP voting is open');
    if (!candidate || who.id===candidate.id || !eligibleForMvp(candidate.id,start,today))fail('Candidate is not eligible');
    if (db.mvpVotes.some(x=>x.voterId===who.id&&x.start===start))fail('You have already voted');
    db.mvpVotes.push({start,voterId:who.id,candidateId:candidate.id,createdAt:Date.now()});
    const voters=db.profiles.filter(p=>p.claimed);
    const votes=db.mvpVotes.filter(v=>v.start===start);
    if (voters.length>=2 && voters.every(p=>votes.some(v=>v.voterId===p.id)) && (!db.mvpCrown?.cycleStart || db.mvpCrown.cycleStart<=start)) {
      const tally=new Map();for(const v of votes)tally.set(v.candidateId,(tally.get(v.candidateId)||0)+1);
      const ranked=[...tally].sort((a,b)=>b[1]-a[1]);
      if(ranked.length&&(!ranked[1]||ranked[0][1]>ranked[1][1])) {
        db.mvpCrown={profileId:ranked[0][0],source:'vote',cycleStart:start,awardedAt:Date.now(),awardedBy:null};
        db.audit.push({event:'mvp-crown-auto',profileId:ranked[0][0],cycleStart:start,at:Date.now()});
      }
    }
    persist();return send(res,200,{ok:true});
  }
  fail('Unknown API endpoint',404);
}

const server=http.createServer(async(req,res)=>{
  try {
    const proof=/^\/api\/checkins\/([a-f0-9-]+)\/proof$/.exec(new URL(req.url,'http://localhost').pathname);
    if(req.method==='GET'&&proof){
      const me=auth(req);const c=db.checkins.find(x=>x.id===proof[1]);if(!c||c.status==='deleted')fail('Workout not found',404);
      if (c.profileId!==me.id && !me.isAdmin && !published(c)) fail('This evidence is private',403);
      const file=path.join(PROOF_DIR,proof[1]+'.jpg');
      const photo=fs.existsSync(file)?`data:${c.proofMime||'image/jpeg'};base64,${fs.readFileSync(file).toString('base64')}`:'';
      return send(res,200,{proof:photo});
    }
    await route(req,res);
  } catch(e) {
    const code=e.status||500;
    if(code>=500)console.error(e);
    if(!res.headersSent)send(res,code,{error:code>=500?'Server error; check Railway logs':e.message});
  }
});
server.listen(PORT,'0.0.0.0',()=>console.log(`gymclo listening on ${PORT}, storage ${DATA_DIR}`));
