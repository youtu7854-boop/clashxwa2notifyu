const admin = require('firebase-admin');

// Safely initialize Firebase app with a unique name
function getFirebaseApp(envKey, appName) {
  const existingApp = admin.apps.find(app => app && app.name === appName);
  if (existingApp) {
    return existingApp;
  }

  const envValue = process.env[envKey];
  if (!envValue) {
    throw new Error(`Environment variable ${envKey} missing hai!`);
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(envValue);
  } catch (e) {
    throw new Error(`Invalid JSON in ${envKey}: ${e.message}`);
  }

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  }, appName);
}

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-secret');
  
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST method required' });
  
  // Secret Check
  if (!process.env.NOTIFY_SECRET || req.headers['x-secret'] !== process.env.NOTIFY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized: Invalid secret key' });
  }

  try {
    // 1. Initialize Main Database (Firestore)
    const fsApp = getFirebaseApp('FIRESTORE_SERVICE_ACCOUNT', 'mainFirestoreApp');
    const fs = fsApp.firestore();

    // 2. Initialize Push Notification App (Firebase Cloud Messaging)
    const pushApp = getFirebaseApp('FIREBASE_SERVICE_ACCOUNT', 'pushNotificationApp');
    const msg = pushApp.messaging();

    const { matchId, title, body } = req.body || {};

    let uids = null;
    if (matchId) {
      const m = await fs.collection('tournaments').doc(String(matchId)).get();
      const d = m.data() || {};
      uids = (d.joinedUsers || []).map(u => u.userDocId).filter(Boolean);
    }

    let tokens = [];
    if (Array.isArray(uids) && uids.length) {
      const docs = await Promise.all(uids.map(u => fs.collection('users').doc(String(u)).get()));
      tokens = docs.map(x => (x.exists && x.data() ? x.data().fcmTok : null)).filter(Boolean);
    } else if (!matchId) {
      // Safe query without needing composite index
      const snap = await fs.collection('users').get();
      tokens = snap.docs.map(x => x.data()?.fcmTok).filter(Boolean);
    }

    // Duplicate tokens remove karein
    tokens = [...new Set(tokens)];
    let sent = 0;

    // Send notifications in batches of 500
    for (let i = 0; i < tokens.length; i += 500) {
      const batchTokens = tokens.slice(i, i + 500);
      if (batchTokens.length === 0) continue;

      const r = await msg.sendEachForMulticast({
        tokens: batchTokens,
        notification: { 
          title: title || 'Room Update', 
          body: body || 'Room ID/Password updated' 
        },
        android: { priority: 'high' }
      });
      sent += r.successCount;
    }

    return res.json({ ok: true, sent, total: tokens.length });

  } catch (e) {
    console.error('Notification API Error:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
};
