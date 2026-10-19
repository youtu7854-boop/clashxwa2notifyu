// Vercel function: chalu (Upcoming/Ongoing) matches ki list.
// Firestore se ek baar padhta hai aur Vercel ka cache us jawab ko 30 second tak sabhi users ko deta hai,
// isliye users kitne bhi ho jayein, Firestore reads lagbhag utne hi rehte hain.
// Room ID / Password is list me NAHI jata (URL public hai). Joined users ko wo seedhe Firestore se milta hai.
let admin = null, loadErr = null;
try { admin = require('firebase-admin'); } catch (e) { loadErr = e; }

// Firestore (matches/users): vip-tournament-3f64b -> env FIRESTORE_SERVICE_ACCOUNT (notify-room.js jaisa hi setup)
function getDb() {
  if (!admin.apps.find((x) => x.name === 'fs')) {
    const fsRaw = process.env.FIRESTORE_SERVICE_ACCOUNT;
    if (fsRaw) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fsRaw)) }, 'fs');
    } else {
      admin.initializeApp(
        {
          credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
          projectId: process.env.FIRESTORE_PROJECT_ID || 'vip-tournament-3f64b',
        },
        'fs'
      );
    }
  }
  return admin.firestore(admin.app('fs'));
}

const SECRET = ['roomId', 'roomPass', 'lastRoomNotifKey']; // lastRoomNotifKey me roomId|pass hota hai

// Firestore Timestamp -> ISO string (JSON me bhejne ke liye)
const plain = (v) => {
  if (v && typeof v.toDate === 'function') return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k in v) o[k] = plain(v[k]);
    return o;
  }
  return v;
};

let memo = { t: 0, body: null }; // garam instance me 20s tak wahi jawab (CDN miss par bhi reads bachte hain)

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (loadErr) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: 'Server setup error: ' + loadErr.message });
  }

  try {
    if (!memo.body || Date.now() - memo.t > 20000) {
      const snap = await getDb().collection('tournaments').where('status', 'in', ['Upcoming', 'Ongoing']).get();
      const matches = [];
      snap.forEach((d) => {
        const x = plain(d.data());
        SECRET.forEach((k) => delete x[k]);
        matches.push({ id: d.id, ...x });
      });
      memo = { t: Date.now(), body: { ok: true, at: Date.now(), matches } };
    }
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30');
    return res.status(200).json(memo.body);
  } catch (e) {
    console.error(e);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: 'Server error: ' + (e && e.message ? e.message : 'unknown') });
  }
};
