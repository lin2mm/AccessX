// Bump C whenever shell assets change. Pages are network-first so users
// always get the latest UI (and security fixes) when online; the cache is
// only an offline fallback. API calls are never cached.
const C='axess-v25';
const A=['./','./index.html','./app.js','./qr.js','./manifest.json','./icon.svg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(A)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(u.pathname.startsWith('/api/')){
    e.respondWith(fetch(e.request).catch(()=>new Response('{"ok":false,"offline":true}',{headers:{'Content-Type':'application/json'}})));
    return;
  }
  if(e.request.mode==='navigate'||u.pathname.endsWith('.html')||u.pathname.endsWith('.js')){
    e.respondWith(fetch(e.request).then(r=>{const copy=r.clone();caches.open(C).then(c=>c.put(e.request,copy));return r;})
      .catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))));
    return;
  }
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});
