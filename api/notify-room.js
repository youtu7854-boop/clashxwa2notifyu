// Vercel function: Room ID/Password update hone par joined users ko phone notification bhejta hai.
// Do raste:
//  1) NAYA (staff panel se, Supabase ke baad): body me uids/name/roomId... aata hai + Authorization: Bearer <Firebase ID token>.
//     Sirf staff ya admin ka token chalta hai. Match Firestore se nahi padhta.
//  2) PURANA (sirf matchId): pehle ki tarah Firestore ke tournaments se padhta hai (waisa hi, kuch nahi badla).
let admin = null, loadErr = null;
try { admin = require('firebase-admin'); } catch (e) { loadErr = e; }

// Do Firebase projects:
//  - Firestore (matches/users): vip-tournament-3f64b -> env FIRESTORE_SERVICE_ACCOUNT
//  - Push (FCM) bhejna        : push-331f5           -> env FIREBASE_SERVICE_ACCOUNT
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

// ids = users ke document id (uid). Tokens users/{id}.fcmToken se, push bhejta hai, kharab token hata deta hai.
async function sendToUsers(db, messaging, ids, name) {
  const docs = ids.length ? await db.getAll(...ids.map((id) => db.collection('users').doc(id))) : [];
  const tokens = [];
  const owner = {};
  docs.forEach((d) => {
    const t = d.exists && d.data().fcmToken;
    if (t && !owner[t]) { tokens.push(t); owner[t] = d.id; }
  });
  if (!tokens.length) return { ok: true, sent: 0, reason: 'No tokens saved yet' };

  let sent = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const r = await messaging.sendEachForMulticast({
      tokens: chunk,
      // Data-only message: Firebase library khud notification nahi banati (usi se crash aa raha tha).
      // Notification app ka NotifyService.java banata hai.
      data: {
        title: 'Room ID & Password Updated 🎮',
        body: `${name || 'Your match'} - room details are live. Open the app to join.`,
      },
      android: { priority: 'high' },
    });
    sent += r.successCount;
    // Purane/invalid tokens hata do
    await Promise.all(r.responses.map(async (x, j) => {
      const code = (x.error && x.error.code) || '';
      if (!x.success && /registration-token-not-registered|invalid-registration-token/.test(code)) {
        const uid = owner[chunk[j]];
        if (uid) await db.collection('users').doc(uid).update({ fcmToken: admin.firestore.FieldValue.delete() }).catch(() => {});
      }
    }));
  }
  return { ok: true, sent };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (loadErr) return res.status(500).json({ error: 'Server setup error: ' + loadErr.message });

  try {
    const body = req.body || {};

    // ---------- ADMIN PANEL: sab users ko phone notification (topic 'all') + history ----------
    if (body.action === 'broadcast' || body.action === 'history' || body.action === 'history_delete') {
      const A = getApps();
      const h = String(req.headers.authorization || '');
      if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'no token' });
      let dec;
      try { dec = await A.auth.verifyIdToken(h.slice(7)); }
      catch (e) { return res.status(401).json({ error: 'bad token' }); }
      if (dec.admin !== true) return res.status(403).json({ error: 'not allowed' });

      if (body.action === 'history_delete') {
        const did = typeof body.id === 'string' ? body.id : '';
        if (!did || did.indexOf('/') >= 0) return res.status(400).json({ error: 'id required' });
        await A.db.collection('pushLog').doc(did).delete();
        return res.json({ ok: true });
      }
      if (body.action === 'history') {
        const q = await A.db.collection('pushLog').orderBy('at', 'desc').limit(50).get();
        return res.json({ ok: true, items: q.docs.map((d) => { const x = d.data(); return { id: d.id, title: x.title || '', body: x.body || '', image: x.image || '', by: x.by || '', at: x.at && x.at.toMillis ? x.at.toMillis() : 0 }; }) });
      }

      const s2 = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
      const title = s2(body.title, 200), text = s2(body.message, 1000);
      let image = s2(body.image, 1000);
      if (!title || !text) return res.status(400).json({ error: 'title and message required' });
      if (image && !/^https?:\/\//i.test(image)) return res.status(400).json({ error: 'image link must start with http' });
      // Sketchware wale ke jaisa hi data-only message (title, body, image, type, extra) topic "all" par
      const id = await A.messaging.send({
        topic: 'all',
        data: { title, body: text, image: image || '', type: 'chat', extra: '' },
        android: { priority: 'high' },
      });
      await A.db.collection('pushLog').add({ title, body: text, image, by: dec.email || dec.uid || '', at: new Date(), fcmId: String(id) });
      return res.json({ ok: true, id });
    }

    const { matchId } = body;
    if (!matchId) return res.status(400).json({ error: 'matchId required' });

    const { db, auth, messaging } = getApps();

    // ---------- NAYA RASTA: staff panel match ki jaankari khud bhejta hai ----------
    if (Array.isArray(body.uids)) {
      const h = String(req.headers.authorization || '');
      if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'no token' });
      let dec;
      try { dec = await auth.verifyIdToken(h.slice(7)); }
      catch (e) { return res.status(401).json({ error: 'bad token' }); }
      if (!(dec.staff === true || dec.admin === true)) return res.status(403).json({ error: 'not allowed' });

      const s = (v) => (typeof v === 'string' ? v : '');
      const m = { name: s(body.name), roomId: s(body.roomId), roomPass: s(body.roomPass), status: s(body.status), publishRoom: body.publishRoom === true };
      if (!m.publishRoom || !m.roomId) return res.json({ ok: true, sent: 0, reason: 'Room not published' });
      if (m.status === 'Cancelled' || m.status === 'Results') return res.json({ ok: true, sent: 0, reason: 'Match not active' });

      // Same ID/Pass par dobara notification nahi jayega
      const key = `${m.roomId}|${m.roomPass}`;
      const dref = db.collection('roomNotif').doc(String(matchId));
      const dsnap = await dref.get();
      if (dsnap.exists && dsnap.data().key === key) return res.json({ ok: true, sent: 0, reason: 'Already notified' });
      await dref.set({ key, at: new Date() });

      const ids = [...new Set(body.uids.filter((x) => typeof x === 'string' && x && x.indexOf('/') < 0))].slice(0, 2000);
      return res.json(await sendToUsers(db, messaging, ids, m.name));
    }

    // ---------- PURANA RASTA (jaisa tha waisa) ----------
    const ref = db.collection('tournaments').doc(String(matchId));
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Match not found' });
    const m = snap.data();

    // Sirf tab bhejo jab room info publish ho chuki ho
    if (!m.publishRoom || !m.roomId) return res.json({ ok: true, sent: 0, reason: 'Room not published' });
    if (m.status === 'Cancelled' || m.status === 'Results') return res.json({ ok: true, sent: 0, reason: 'Match not active' });

    // Same ID/Pass par dobara notification nahi jayega (duplicate / spam se bachav)
    const key = `${m.roomId}|${m.roomPass || ''}`;
    if (m.lastRoomNotifKey === key) return res.json({ ok: true, sent: 0, reason: 'Already notified' });
    await ref.update({ lastRoomNotifKey: key, lastRoomNotifAt: new Date() });

    const ids = [...new Set((m.joinedUsers || []).map((u) => u.userDocId || u.ffUid).filter(Boolean))];
    return res.json(await sendToUsers(db, messaging, ids, m.name));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error: ' + (e && e.message ? e.message : 'unknown') });
  }
};
