// Vercel function: Room ID/Password update hone par joined users ko phone notification bhejta hai.
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
  return { db: admin.firestore(admin.app('fs')), messaging: admin.messaging(admin.app('msg')) };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (loadErr) return res.status(500).json({ error: 'Server setup error: ' + loadErr.message });

  try {
    const { matchId } = req.body || {};
    if (!matchId) return res.status(400).json({ error: 'matchId required' });

    const { db, messaging } = getApps();
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
    const docs = ids.length ? await db.getAll(...ids.map((id) => db.collection('users').doc(id))) : [];
    const tokens = [];
    const owner = {};
    docs.forEach((d) => {
      const t = d.exists && d.data().fcmToken;
      if (t && !owner[t]) { tokens.push(t); owner[t] = d.id; }
    });
    if (!tokens.length) return res.json({ ok: true, sent: 0, reason: 'No tokens saved yet' });

    let sent = 0;
    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      const r = await messaging.sendEachForMulticast({
        tokens: chunk,
        // Data-only message: Firebase library khud notification nahi banati (usi se crash aa raha tha).
        // Notification app ka NotifyService.java banata hai.
        data: {
          title: 'Room ID & Password Updated 🎮',
          body: `${m.name || 'Your match'} - room details are live. Open the app to join.`,
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
    return res.json({ ok: true, sent });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error: ' + (e && e.message ? e.message : 'unknown') });
  }
};
