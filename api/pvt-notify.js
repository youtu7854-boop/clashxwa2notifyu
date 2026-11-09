// Vercel function: Private Contest chat me message bhejne par samne wale khiladi ko phone notification.
// App Authorization: Bearer <Firebase ID token> ke saath { challengeId } bhejta hai.
// Ye Supabase ko usi khiladi ke token se bulata hai (koi service key nahi) -> pta chalta hai kise bhejna hai aur message kya hai.
let admin = null, loadErr = null;
try { admin = require('firebase-admin'); } catch (e) { loadErr = e; }

const SB_URL = 'https://ajpavrhczyzvjltvouxf.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqcGF2cmhjenl6dmpsdHZvdXhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0MDAwMDcsImV4cCI6MjEwNzk3NjAwN30._pv6uWwsRVxSwveDQTKcGdRvsmG47lDr0R1v1GRmQgk';

function getApps() {
  if (!admin.apps.find((x) => x.name === 'msg')) {
    const fcmSa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const fsRaw = process.env.FIRESTORE_SERVICE_ACCOUNT;
    admin.initializeApp(
      fsRaw
        ? { credential: admin.credential.cert(JSON.parse(fsRaw)) }
        : { credential: admin.credential.cert(fcmSa), projectId: process.env.FIRESTORE_PROJECT_ID || 'vip-tournament-3f64b' },
      'fs'
    );
    admin.initializeApp({ credential: admin.credential.cert(fcmSa) }, 'msg');
  }
  return { db: admin.firestore(admin.app('fs')), auth: admin.auth(admin.app('fs')), messaging: admin.messaging(admin.app('msg')) };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (loadErr) return res.status(500).json({ error: 'Server setup error: ' + loadErr.message });
  try {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'no token' });
    const token = h.slice(7);
    const id = req.body && typeof req.body.challengeId === 'string' ? req.body.challengeId.slice(0, 80) : '';
    if (!id) return res.status(400).json({ error: 'challengeId required' });

    const { db, auth, messaging } = getApps();
    try { await auth.verifyIdToken(token); } catch (e) { return res.status(401).json({ error: 'bad token' }); }

    const r = await fetch(SB_URL + '/rest/v1/rpc/pvt_chat_notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SB_ANON, Authorization: 'Bearer ' + token },
      body: JSON.stringify({ p_id: id }),
    });
    if (!r.ok) return res.status(403).json({ error: 'not allowed' });
    const t = await r.json();
    if (!t || !t.toUid) return res.json({ ok: true, sent: 0, reason: 'nothing to send' });

    const doc = await db.collection('users').doc(String(t.toUid)).get();
    const fcm = doc.exists && doc.data().fcmToken;
    if (!fcm) return res.json({ ok: true, sent: 0, reason: 'No token' });

    try {
      await messaging.send({
        token: fcm,
        // Data-only (NotifyService.java notification banata hai), pichhli Room ID wali notification jaisa
        data: { title: String(t.name), body: String(t.msg), type: 'chat', extra: '' },
        android: { priority: 'high' },
      });
    } catch (e) {
      const code = (e && e.code) || '';
      if (/registration-token-not-registered|invalid-registration-token/.test(code)) {
        await db.collection('users').doc(String(t.toUid)).update({ fcmToken: admin.firestore.FieldValue.delete() }).catch(() => {});
      }
      return res.json({ ok: true, sent: 0 });
    }
    return res.json({ ok: true, sent: 1 });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error: ' + (e && e.message ? e.message : 'unknown') });
  }
};
