/* All dynamic values go through esc() before touching innerHTML.
   Server-built HTML (copilot answers) is escaped server-side. */
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// No token is ever kept in the page. Signing in exchanges it for an
// HttpOnly session cookie; only the CSRF token lives in memory.
let csrf='', signedIn=false;
const api=async(u,o={})=>{
  const headers=new Headers(o.headers||{});
  const m=(o.method||'GET').toUpperCase();
  if(csrf&&m!=='GET'&&m!=='HEAD')headers.set('X-CSRF-Token',csrf);
  if(o.body&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  const r=await fetch(u,{...o,headers,credentials:'same-origin'});
  const body=await r.json().catch(()=>({ok:false,error:`HTTP ${r.status}`}));
  return {...body,_status:r.status};
};
const post=(u,data)=>api(u,{method:'POST',body:JSON.stringify(data||{})});
let DOORS=[],USERS=[];

function showSession(s){
  signedIn=Boolean(s&&s.authenticated);
  csrf=signedIn?s.csrf:'';
  $('#admin-logout').hidden=!signedIn;
  $('#admin-token').hidden=signedIn;$('#admin-submit').hidden=signedIn;
  $('#sso-btn').hidden=signedIn||!(s&&s.sso);
  if(signedIn){
    const op=s.operator||{};
    const scope=(op.siteIds||['*']).includes('*')?'all sites':op.siteIds.join(', ');
    $('#admin-status').textContent=`${op.name||'Operator'} · ${op.roleName||op.role||''} · ${scope}${s.via==='sso'?' · SSO':''}`;
  }
}
$('#admin-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const token=$('#admin-token').value;$('#admin-token').value='';
  const r=await post('/api/auth/login',{token});
  if(r.ok){showSession(r);await init();}
  else $('#admin-status').textContent=r._status===429?'Too many attempts — wait a few minutes':(r.error||'Token rejected');
});
$('#admin-logout').addEventListener('click',async()=>{
  await post('/api/auth/logout',{});
  showSession(null);$('#admin-status').textContent='Read-only';init();
});
{
  const q=new URLSearchParams(location.search);
  const err=q.get('sso_error');
  if(err){
    const msg={not_invited:'Your SSO account has no operator access here. Ask an owner to invite your email.',
      unverified_email:'Your identity provider did not confirm your email address.',
      expired:'The sign-in took too long. Please try again.'}[err]||'Single sign-on failed.';
    setTimeout(()=>{$('#admin-status').textContent=msg;},0);
    history.replaceState(null,'',location.pathname);
  }
}

$$('nav button').forEach(b=>b.onclick=()=>{
  $$('nav button').forEach(x=>x.classList.remove('on'));b.classList.add('on');
  $$('.view').forEach(v=>v.classList.remove('on'));$('#v-'+b.dataset.v).classList.add('on');
});
const batClass=n=>n>50?'hi':n>25?'mid':'lo';
const errText=r=>r._status===401?'Sign in first':r._status===403?`No permission${r.required?` (needs ${r.required})`:''}${r.detail?': '+r.detail:''}`:(r.error||'Request failed');

async function init(){
  const auth=await api('/api/auth/session');
  showSession(auth);
  if(!auth.openReads&&!signedIn){
    $('#mode').textContent=auth.tokenConfigured||auth.operatorsConfigured?'Sign-in required':'Setup required';
    $('#admin-status').textContent=auth.operatorsConfigured||auth.sso?'Sign in for live data':'Set ADMIN_TOKEN on server';
    return;
  }
  const st=await api('/api/status');
  $('#mode').textContent=(st.mode||'').startsWith('DEMO')?'Demo data':'Live';
  const now=new Date();now.setMinutes(now.getMinutes()-now.getTimezoneOffset());
  $('#e-when').value=now.toISOString().slice(0,16);
  await loadDoors();await loadHealth();await loadPeople();await loadRules();await loadAudit();await loadCreds();await loadCompile();
  if(!$('#chat').children.length)addBubble('Copilot ready. I can explain access decisions, plan service visits, spot anomalies and draft rule changes for your approval.',false);
}
async function loadDoors(){
  const d=await api('/api/doors');DOORS=d.doors||[];
  $('#doors').innerHTML=DOORS.length?DOORS.map(l=>{
    const cls=!l.hasGateway?'off':(l.electricQuantity<=25?'warn':'');
    const bat=Number(l.electricQuantity)||0;
    return `<div class="door ${cls}">
      <div><b>${esc(l.lockAlias)}</b>
        <div class="meta">${esc(l.site||'—')} ${l.doorGroup?'· '+esc(l.doorGroup):''}</div>
        <div class="meta"><span class="bat ${batClass(bat)}">${bat}% battery</span>
        ${l.hasGateway?'<span class="tag g" style="margin-left:6px">online</span>':'<span class="tag r" style="margin-left:6px">no gateway</span>'}</div>
      </div><button class="btn sm" type="button" data-unlock="${Number(l.lockId)}">Unlock</button></div>`}).join(''):'<div class="empty">No doors visible to you</div>';
  const opts=DOORS.map(l=>`<option value="${Number(l.lockId)}">${esc(l.lockAlias)}</option>`).join('');
  $('#e-door').innerHTML=opts;$('#r-door').innerHTML=opts;$('#p-door').innerHTML=opts;loadRecords();
}
$('#doors').addEventListener('click',e=>{const b=e.target.closest('[data-unlock]');if(b)unlock(b.dataset.unlock,b);});
async function loadHealth(){
  const h=await api('/api/health');
  const low=(h.lowBattery||[]).length, off=(h.offline||[]).length;
  $('#kpis').innerHTML=`
    <div class="kpi"><div class="n">${Number(h.total)||0}</div><div class="l">Doors</div></div>
    <div class="kpi"><div class="n ${low?'warn':'ok'}">${low}</div><div class="l">Low battery</div></div>
    <div class="kpi"><div class="n ${off?'bad':'ok'}">${off}</div><div class="l">No gateway</div></div>`;
}
async function unlock(id,btn){
  btn.textContent='…';
  const reason=$('#u-reason').value.trim();
  const r=await post('/api/doors/'+encodeURIComponent(id)+'/unlock',{reason});
  if(r._status===400){btn.textContent='Reason?';$('#u-reason').focus();setTimeout(()=>btn.textContent='Unlock',1700);return;}
  btn.textContent=r.ok?'Sent':(r._status===401?'Sign in':r._status===403?'No permission':r._status===404?'Unknown lock':'Denied');
  setTimeout(()=>btn.textContent='Unlock',1700);loadAudit();
}
async function loadPeople(){
  const [u,g,s]=await Promise.all([api('/api/users'),api('/api/userGroups'),api('/api/schedules')]);
  USERS=u.users||[];
  const groups=g.userGroups||[];
  const gname=id=>(groups.find(x=>x.id===id)||{}).name||id;
  $('#people').innerHTML=`<table><tr><th>Name</th><th>Groups</th><th>Status</th><th></th></tr>`+
    USERS.map(p=>`<tr><td><b>${esc(p.name)}</b><div class="meta">${esc(p.email||'')}</div></td>
    <td>${(p.groupIds||[]).map(i=>'<span class="chip">'+esc(gname(i))+'</span>').join('')}</td>
    <td>${p.suspended?'<span class="tag r">suspended</span>':'<span class="tag g">active</span>'}
    ${p.validTo?'<div class="meta">until '+esc(String(p.validTo).slice(0,10))+'</div>':''}</td>
    <td><button class="btn2 sm" type="button" data-suspend="${esc(p.id)}" data-to="${p.suspended?'unsuspend':'suspend'}">${p.suspended?'Reinstate':'Suspend'}</button></td></tr>`).join('')+`</table><div id="people-msg" class="meta" style="margin-top:8px"></div>`;
  $('#ugroups').innerHTML=groups.map(x=>`<span class="chip">${esc(x.name)}</span>`).join('');
  $('#scheds').innerHTML=(s.schedules||[]).map(x=>`<div style="margin-bottom:10px"><b>${esc(x.name)}</b>
    ${x.denyOnHolidays?'<span class="tag o" style="margin-left:6px">no holidays</span>':''}
    <div class="sched">${(x.windows||[]).map(w=>'Days '+esc((w.days||[]).join(','))+' · '+esc(w.from)+'–'+esc(w.to)).join('<br>')}</div></div>`).join('');
  const opts=USERS.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('#e-user').innerHTML=opts;$('#p-user').innerHTML=opts;
}
$('#people').addEventListener('click',async e=>{
  const b=e.target.closest('[data-suspend]');if(!b)return;
  const r=await post('/api/users/'+encodeURIComponent(b.dataset.suspend)+'/'+b.dataset.to,{});
  if(!r.ok){b.textContent=r._status===401?'Sign in':r._status===403?'Outside your sites':'Failed';return;}
  await loadPeople();
  const rc=r.reconcile;
  if(rc&&!rc.error)$('#people-msg').textContent=`Suspended. Credentials revoked remotely: ${Number(rc.revoked)} · awaiting on-site removal: ${Number(rc.pendingRemoval)}${rc.failed?' · failed (will retry): '+Number(rc.failed):''}`;
  loadCreds();loadAudit();loadCompile();
});
async function loadRules(){
  const [a,ug,dg,s]=await Promise.all([api('/api/assignments'),api('/api/userGroups'),api('/api/doorGroups'),api('/api/schedules')]);
  const n=(arr,id)=>((arr||[]).find(x=>x.id===id)||{}).name||'24/7';
  $('#rules').innerHTML=`<table><tr><th>Who</th><th>Can open</th><th>When</th></tr>`+
    (a.assignments||[]).map(r=>`<tr><td>${esc(n(ug.userGroups,r.userGroupId))}</td>
    <td>${esc(n(dg.doorGroups,r.doorGroupId))}</td><td>${esc(n(s.schedules,r.scheduleId))}</td></tr>`).join('')+`</table>`;
}
async function evaluate(){
  const r=await post('/api/evaluate',{userId:$('#e-user').value,lockId:$('#e-door').value,localTime:$('#e-when').value});
  if(!r.ok){$('#e-res').textContent=errText(r);return;}
  const x=r.result;
  $('#e-res').innerHTML=`<div class="res ${x.allowed?'y':'n'}">
    <b style="font-size:14px;letter-spacing:.5px">${x.allowed?'ACCESS GRANTED':'ACCESS DENIED'}</b>
    <div style="margin-top:5px">${esc(x.reason)}</div>
    <div class="meta" style="margin-top:4px">${esc(r.site||'Unassigned door')} · ${esc(r.localTime)}</div>
    ${(x.path&&x.path.length)?'<div style="margin-top:8px;font-size:11.5px;opacity:.85">Rules evaluated:<br>'+
      x.path.map(p=>`· ${esc(p.group)} → ${esc(p.doorGroup)} (${esc(p.schedule)}): ${esc(p.reason)}`).join('<br>')+'</div>':''}</div>`;
}
$('#e-go').addEventListener('click',evaluate);

/* ---- enforcement map (policy compiler) ---- */
const lv=l=>`<span class="tag lv-${esc(l)}">${esc(l)}</span>`;
const hm=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const DAYS=['','Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
async function loadCompile(){
  const r=await api('/api/compile');
  if(!r.ok){$('#cm-rules').innerHTML=`<div class="empty">${esc(errText(r))}</div>`;$('#cm-kpis').innerHTML='';$('#cm-locks').innerHTML='';return;}
  const s=r.summary;
  $('#cm-kpis').innerHTML=`
    <div class="kpi"><div class="n ${s.fullyEnforcedPct>=80?'ok':s.fullyEnforcedPct>=50?'warn':'bad'}">${Number(s.fullyEnforcedPct)}%</div><div class="l">Rules enforced at the lock</div></div>
    <div class="kpi"><div class="n ${s.cloud?'bad':'ok'}">${Number(s.cloud)}</div><div class="l">Cloud-only rules</div></div>
    <div class="kpi"><div class="n ${(r.drift||[]).length?'bad':'ok'}">${(r.drift||[]).length}</div><div class="l">Credentials to revoke</div></div>`;
  const dn=id=>(DOORS.find(d=>Number(d.lockId)===Number(id))||{}).lockAlias||id;
  $('#cm-notices').innerHTML=(r.pendingRemoval||[]).map(c=>`<div class="res n" style="margin-top:6px"><b>Code still on ${esc(dn(c.lockId))}</b> (${esc(c.codeHint||c.id)}) — no gateway, remove it at the lock.
      <div class="meta">${esc(c.revokeReason||'')}</div>
      <div style="margin-top:8px"><button class="btn2 sm" type="button" data-confirm="${esc(c.id)}">Confirm removed on site</button></div></div>`).join('')+
    (r.notices||[]).map(n=>`<div class="res" style="margin-top:6px;border-left:3px solid var(--warn,#e5a50a)"><b>Clock change at ${esc(n.site)} on ${esc(n.date)}</b> (${Number(n.shiftMinutes)>0?'+':''}${Number(n.shiftMinutes)} min, ${esc(n.timeZone)})
      <div class="meta">${esc(n.advice)}${(n.offlineLocks||[]).length?' Offline: '+n.offlineLocks.map(dn).map(esc).join(', '):''}</div></div>`).join('');
  $('#cm-rules').innerHTML=`<table><tr><th>Rule</th><th>Level</th><th>Per door</th></tr>`+
    r.rules.map(x=>`<tr><td><b>${esc(x.who)}</b> → ${esc(x.doorGroup)}<div class="meta">${esc(x.schedule)} · ${Number(x.members)} people</div></td>
      <td>${lv(x.level)}</td>
      <td>${x.doors.map(d=>`<details><summary>${lv(d.level)} ${esc(d.name)}</summary><div class="meta">${d.reasons.map(q=>'· '+esc(q.text)).join('<br>')}</div></details>`).join('')}
      ${x.slots.length?`<details><summary>compiled lock slots (${x.slots.length})</summary><div class="meta">${x.slots.map(q=>esc(DAYS[q.weekDay])+' '+hm(q.startMin)+'–'+hm(q.endMin)).join(' · ')}</div></details>`:''}</td></tr>`).join('')+`</table>`;
  $('#cm-locks').innerHTML=`<table><tr><th>Lock</th><th>Worst level</th><th>Rules</th><th>Issues</th></tr>`+
    r.locks.map(l=>`<tr><td><b>${esc(l.name)}</b><div class="meta">${l.hasGateway?'gateway':'no gateway'} · ${l.cyclic?'weekly windows':'period only'}</div></td>
      <td>${lv(l.level)}</td><td>${Number(l.rules)}</td><td class="meta">${l.issues.map(esc).join('<br>')||'—'}</td></tr>`).join('')+`</table>`;
}

async function confirmRemoved(id,b){
  const r=await post('/api/credentials/'+encodeURIComponent(id)+'/confirm-removed',{});
  if(!r.ok){b.textContent=r._status===403?'No permission':r._status===401?'Sign in':'Failed';return;}
  loadCreds();loadAudit();loadCompile();
}
$('#cm-notices').addEventListener('click',e=>{const b=e.target.closest('[data-confirm]');if(b)confirmRemoved(b.dataset.confirm,b);});

/* ---- passcodes ---- */
async function issuePasscode(acknowledge=false){
  const end=$('#p-end').value;
  const body={userId:$('#p-user').value,lockId:Number($('#p-door').value),acknowledgeScheduleGap:acknowledge};
  if(end)body.endAt=new Date(end+'T23:59:00').toISOString();
  const r=await post('/api/passcode',body);
  const out=$('#p-res');
  if(r._status===409&&r.needs==='acknowledgeScheduleGap'){
    out.innerHTML=`<div class="res n"><b>Lock cannot enforce this schedule</b><div style="margin-top:5px">${esc(r.detail)}</div>
      <div style="margin-top:10px"><button class="btn2 sm" type="button" id="p-ack">Issue anyway (partial enforcement, audited)</button></div></div>`;
    $('#p-ack').addEventListener('click',()=>issuePasscode(true));
    return;
  }
  if(!r.ok){out.innerHTML=`<div class="res n">${esc(errText(r))}</div>`;return;}
  const c=r.credential;
  out.innerHTML=`<div class="res y"><div class="code">${esc(r.passcode.keyboardPwd)}</div>
    <div class="meta" style="margin-top:6px">Shown once — the system only keeps ${esc(c.codeHint)}.</div>
    <div style="margin-top:6px">${esc(c.startAt.slice(0,16).replace('T',' '))} → ${esc(c.endAt.slice(0,16).replace('T',' '))} UTC ·
      ${c.enforcement==='lock'?'<span class="tag g">lock-enforced</span>':'<span class="tag o">partial</span>'}</div>
    ${(r.warnings||[]).map(w=>`<div class="meta" style="margin-top:4px">⚠ ${esc(w)}</div>`).join('')}</div>`;
  loadCreds();loadAudit();loadCompile();
}
$('#p-issue').addEventListener('click',()=>issuePasscode(false));

async function loadCreds(){
  const r=await api('/api/credentials');
  if(!r.ok){$('#creds').innerHTML=`<tr><td class="empty">${esc(errText(r))}</td></tr>`;return;}
  const flags=Object.fromEntries((r.review||[]).map(f=>[f.id,f.reasons]));
  const uname=id=>(USERS.find(u=>u.id===id)||{}).name||id;
  const dname=id=>(DOORS.find(d=>Number(d.lockId)===Number(id))||{}).lockAlias||id;
  const list=(r.credentials||[]).slice().reverse();
  $('#creds').innerHTML=list.length?`<tr><th>Person</th><th>Door</th><th>Valid until</th><th>Enforcement</th><th>Status</th><th></th></tr>`+
    list.map(c=>`<tr><td>${esc(uname(c.userId))}<div class="meta">${esc(c.codeHint||'')}</div></td><td>${esc(dname(c.lockId))}</td>
      <td>${esc(String(c.endAt).slice(0,10))}</td>
      <td>${c.enforcement==='lock'?'<span class="tag g">lock</span>':'<span class="tag o">partial</span>'}</td>
      <td>${c.status==='pending_removal'?'<span class="tag o">remove on site</span>':c.status!=='active'?'<span class="tag">'+esc(c.status)+'</span>':flags[c.id]?'<span class="tag r">revoke</span><div class="meta">'+esc(flags[c.id].join('; '))+'</div>':'<span class="tag g">ok</span>'}</td>
      <td>${c.status==='active'?`<button class="btn2 sm" type="button" data-revoke="${esc(c.id)}">Revoke</button>`:c.status==='pending_removal'?`<button class="btn2 sm" type="button" data-confirm="${esc(c.id)}">Confirm removed</button>`:''}</td></tr>`).join('')
    :'<tr><td class="empty">No credentials issued yet</td></tr>';
}
$('#creds').addEventListener('click',async e=>{
  const cb=e.target.closest('[data-confirm]');if(cb)return confirmRemoved(cb.dataset.confirm,cb);
  const b=e.target.closest('[data-revoke]');if(!b)return;
  const r=await api('/api/credentials/'+encodeURIComponent(b.dataset.revoke),{method:'DELETE'});
  if(!r.ok)b.textContent=r._status===403?'No permission':'Failed';else{loadCreds();loadAudit();loadCompile();}
});

async function loadRecords(){
  const id=$('#r-door').value;if(!id)return;
  const r=await api('/api/records/'+encodeURIComponent(id));
  $('#recs').innerHTML=`<tr><th>When</th><th>Who</th><th>Method</th><th></th></tr>`+
    (r.records||[]).map(x=>`<tr><td>${esc(new Date(x.lockDate).toLocaleString())}</td>
    <td>${esc(x.username||'—')}</td><td>${esc(x.typeLabel)}</td>
    <td>${x.success?'<span class="tag g">ok</span>':'<span class="tag r">failed</span>'}</td></tr>`).join('');
}
$('#r-door').addEventListener('change',loadRecords);
async function loadAudit(){
  const r=await api('/api/audit?limit=25');
  if(!r.ok){$('#alog').innerHTML=`<tr><td class="empty">${esc(errText(r))}</td></tr>`;return;}
  $('#alog').innerHTML=`<tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr>`+
    (r.log||[]).map(x=>`<tr><td class="meta">${Number(x.seq)||''}</td><td>${esc(new Date(x.ts).toLocaleString())}</td>
    <td>${esc(x.actor)}</td><td><span class="chip">${esc(x.action)}</span></td>
    <td style="color:var(--txt3)">${esc((x.detail||'').slice(0,90))}</td></tr>`).join('');
}
$('#a-verify').addEventListener('click',async()=>{
  const r=await api('/api/audit/verify');
  const v=r.verification;
  $('#a-verify-res').textContent=!r.ok?errText(r):v.ok
    ?`✓ ${v.count} entries intact · head #${v.head.seq} ${v.head.hash.slice(0,12)}…`
    :`✗ chain broken at entry #${v.brokenAt}: ${v.problem}`;
});
/* ---- Copilot ---- */
function addBubble(t,me){
  const d=document.createElement('div');d.className='bubble'+(me?' me':'');
  if(me)d.textContent=t;else d.innerHTML=t; // copilot HTML is escaped server-side
  $('#chat').appendChild(d);d.scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function ask(text){
  const q=text||$('#ai-in').value.trim();if(!q)return;
  $('#ai-in').value='';addBubble(q,true);
  const r=await post('/api/ai',{q});
  if(!r.ok){const d=document.createElement('div');d.className='bubble';d.textContent=errText(r);$('#chat').appendChild(d);return;}
  addBubble(r.answer||'—',false);
}
$('#ai-sugg').addEventListener('click',e=>{if(e.target.tagName==='BUTTON')ask(e.target.textContent);});
$('#ai-send').addEventListener('click',()=>ask());
$('#ai-in').addEventListener('keydown',e=>{if(e.key==='Enter')ask();});
init();
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
