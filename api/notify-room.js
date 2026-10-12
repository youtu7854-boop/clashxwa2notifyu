const admin = require('firebase-admin');
function init(name, envKey){
  const found = admin.apps.find(a=>a && a.name===name);
  if(found) return found;
  return admin.initializeApp({credential: admin.credential.cert(JSON.parse(process.env[envKey]))}, name);
}
module.exports = async (req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,x-secret');
  if(req.method==='OPTIONS') return res.status(204).end();
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  if(!process.env.NOTIFY_SECRET || req.headers['x-secret']!==process.env.NOTIFY_SECRET) return res.status(401).json({error:'unauthorized'});
  try{
    const {matchId,title,body}=req.body||{};
    const fs=init('fs','FIRESTORE_SERVICE_ACCOUNT').firestore();
    const msg=init('push','FIREBASE_SERVICE_ACCOUNT').messaging();
    let uids=null;
    if(matchId){
      const m=await fs.collection('tournaments').doc(String(matchId)).get();
      const d=m.data()||{};
      uids=(d.joinedUsers||[]).map(u=>u.userDocId).filter(Boolean);
    }
    let tokens=[];
    if(Array.isArray(uids)&&uids.length){
      const docs=await Promise.all(uids.map(u=>fs.collection('users').doc(String(u)).get()));
      tokens=docs.map(x=>x.exists&&x.data().fcmTok).filter(Boolean);
    } else if(!matchId){
      const snap=await fs.collection('users').where('fcmTok','!=','').get();
      tokens=snap.docs.map(x=>x.data().fcmTok);
    }
    tokens=[...new Set(tokens)];
    let sent=0;
    for(let i=0;i<tokens.length;i+=500){
      const r=await msg.sendEachForMulticast({tokens:tokens.slice(i,i+500),
        notification:{title:title||'Room Update',body:body||'Room ID/Password updated'},
        android:{priority:'high'}});
      sent+=r.successCount;
    }
    res.json({ok:true,sent,total:tokens.length});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
};
