'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Railway: mount a persistent Volume at /app/data. Never put credentials in GitHub.
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.GYMCLO_DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'gymclo.json');
const PROOF_DIR = path.join(DATA_DIR, 'proofs');
const SETUP_CODE = process.env.GYMCLO_SETUP_CODE || '';
const SESSION_SECRET = process.env.GYMCLO_SESSION_SECRET || '';
const COOKIE_NAME = 'gymclo_session';
const SESSION_SECONDS = 7 * 24 * 3600;
const PIN_ATTEMPTS = new Map();
const DEFAULTS = [
  '40 bodyweight squats + 30-second plank',
  '60 alternating lunges + 60-second plank',
  '80 bodyweight squats + 90-second wall sit',
  '15-minute brisk incline walk + 60 walking lunges',
  '20-minute incline walk + 3 minutes total plank'
];

if (!SETUP_CODE || SETUP_CODE.length < 12 || !SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('Configure GYMCLO_SETUP_CODE (12+ characters) and GYMCLO_SESSION_SECRET (32+ characters) as Railway service Variables.');
  process.exit(1);
}
fs.mkdirSync(PROOF_DIR, { recursive: true });
function emptyState() {
  return { profiles: [], checkins: [], rules: [], done: [], proposals: [], proposalVotes: [], mvpVotes: [], defaults: DEFAULTS };
}
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : emptyState();
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
function eligibleForMvp(profileId, month, today) {
  const weeks = monthWeeks(month);
  return !!weeks.length && weeks.every(week => addDays(week, 6) < today &&
    db.checkins.filter(x => x.profileId === profileId && x.week === week && x.status !== 'rejected').length >= monthTarget(week.slice(0,7)));
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
function admin(req) { const p = auth(req); if (!p.isAdmin) fail('Admin access required', 403); return p; }
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
  if (!Array.isArray(a) || a.length !== 5 || a.some(x => typeof x !== 'string' || !x.trim() || x.length > 180)) fail('Provide five fitness forfeits (one for each week)');
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
  if (req.method === 'GET' && uri === '/api/state') {
    const me = auth(req);
    return send(res,200,{ me:publicProfile(me), profiles:db.profiles.map(publicProfile), today:londonDay(), defaults:db.defaults, rules:db.rules, checkins:db.checkins, done:db.done, proposals:db.proposals, proposalVotes:db.proposalVotes, mvpVotes:db.mvpVotes });
  }
  if (!['POST','PATCH'].includes(req.method)) fail('Method not allowed', 405);
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
  if (req.method === 'POST' && uri === '/api/logout') { clearLogin(res);return send(res,200,{ok:true}); }

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
    if (!who.isAdmin && who.id!==p.id) fail('Only the owner or an admin can update this profile',403);
    p.name=checkName(b.name);
    if (b.avatar !== undefined && b.avatar !== p.avatar) p.avatar=b.avatar ? photoData(b.avatar).value : '';
    persist();return send(res,200,{ok:true});
  }
  if (req.method === 'POST' && uri === '/api/checkins') {
    const who=auth(req), day=londonDay();
    if (db.checkins.some(x=>x.profileId===who.id && x.day===day)) fail('You have already logged today');
    if (!['push','pull','legs','cardio','other'].includes(b.kind)) fail('Invalid workout type');
    if (typeof b.note !== 'string' || b.note.length>180) fail('Notes cannot exceed 180 characters');
    const photo=photoData(b.proof);
    const proofId=id(), digest=crypto.createHash('sha256').update(photo.data).digest('hex');
    const flagged=db.checkins.some(x=>x.proofHash===digest);
    const proofFile=path.join(PROOF_DIR, proofId + '.jpg');
    fs.writeFileSync(proofFile,photo.data,{mode:0o600});
    db.checkins.unshift({id:proofId,profileId:who.id,day,week:monday(day),kind:b.kind,note:b.note,status:'pending',createdAt:Date.now(),hasProof:true,flagged,proofHash:digest,proofMime:photo.mime});
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
  if (req.method==='POST' && uri==='/api/rules') {
    admin(req);const month=checkMonth(b.month), target=Number(b.target);
    if (!Number.isInteger(target)||target<1||target>7)fail('Target must be between 1 and 7');
    const rules={month,target,forfeits:validForfeits(b.forfeits)};
    db.rules=db.rules.filter(x=>x.month!==month);db.rules.push(rules);persist();return send(res,200,{ok:true});
  }
  if (req.method==='POST' && uri==='/api/proposals') {
    const who=auth(req),month=checkMonth(b.month),title=String(b.title||'').trim();
    if (!title || title.length>64)fail('Title must be 1-64 characters');
    if (month!==nextMonth(monday(londonDay()).slice(0,7)))fail('Proposals are for next month');
    db.proposals.push({id:id(),profileId:who.id,createdAt:Date.now(),month,title,forfeits:validForfeits(b.forfeits)});
    persist();return send(res,200,{ok:true});
  }
  if (req.method==='POST' && uri==='/api/proposal-votes') {
    const who=auth(req),p=db.proposals.find(x=>x.id===b.proposalId);
    if (!p||p.month!==nextMonth(monday(londonDay()).slice(0,7)))fail('Proposal unavailable');
    db.proposalVotes=db.proposalVotes.filter(x=>!(x.month===p.month&&x.voterId===who.id));
    db.proposalVotes.push({month:p.month,voterId:who.id,proposalId:p.id});persist();return send(res,200,{ok:true});
  }
  if (req.method==='POST' && uri==='/api/apply-proposal') {
    admin(req);const p=db.proposals.find(x=>x.id===b.proposalId);if(!p)fail('Proposal not found');
    db.rules=db.rules.filter(x=>x.month!==p.month);
    db.rules.push({month:p.month,target:4,forfeits:p.forfeits});persist();return send(res,200,{ok:true});
  }
  if (req.method==='POST' && uri==='/api/mvp-votes') {
    const who=auth(req),month=checkMonth(b.month),candidate=db.profiles.find(x=>x.id===b.candidateId),today=londonDay();
    if (month!==lastMonth(monday(today).slice(0,7)))fail('Only last month MVP voting is open');
    if (!candidate || who.id===candidate.id || !eligibleForMvp(candidate.id,month,today))fail('Candidate is not eligible');
    if (db.mvpVotes.some(x=>x.voterId===who.id&&x.month===month))fail('You have already voted');
    db.mvpVotes.push({month,voterId:who.id,candidateId:candidate.id,createdAt:Date.now()});persist();return send(res,200,{ok:true});
  }
  fail('Unknown API endpoint',404);
}

const server=http.createServer(async(req,res)=>{
  try {
    const proof=/^\/api\/checkins\/([a-f0-9-]+)\/proof$/.exec(new URL(req.url,'http://localhost').pathname);
    if(req.method==='GET'&&proof){
      auth(req);const c=db.checkins.find(x=>x.id===proof[1]);if(!c)fail('Workout not found',404);
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
