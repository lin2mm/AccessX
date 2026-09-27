/* All dynamic values go through esc() before touching innerHTML.
   Server-built HTML (copilot answers) is escaped server-side. */
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// No token is ever kept in the page. Signing in exchanges it for an
// HttpOnly session cookie; only the CSRF token lives in memory.
let csrf='', signedIn=false, ME=null;
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
  csrf=signedIn?s.csrf:'';ME=signedIn?(s.operator||null):null;
  $('#admin-logout').hidden=!signedIn;
  $('#admin-token').hidden=signedIn;$('#admin-submit').hidden=signedIn;
  $('#sso-btn').hidden=signedIn||!(s&&s.sso);
  // Self-service signup (R15): the link shows only when this server takes signups.
  if(signedIn)$('#signup-link').hidden=true;
  else fetch('/api/signup',{cache:'no-store'}).then(r=>r.json()).then(i=>{$('#signup-link').hidden=!i.enabled||signedIn;}).catch(()=>{});
  if(signedIn){
    const op=s.operator||{};
    const scope=(op.siteIds||['*']).includes('*')?'all sites':(op.siteNames||op.siteIds).join(', ');
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
      expired:'The sign-in took too long or was started in another browser. Please try again.',
      not_configured:'Single sign-on is not set up for this account.',
      provider_unavailable:'Your identity provider could not be reached. Try again or use a token.',
      denied:'Sign-in was cancelled at the identity provider.'}[err]||'Single sign-on failed.';
    setTimeout(()=>{$('#admin-status').textContent=msg;},0);
    history.replaceState(null,'',location.pathname);
  }
}

// Opening a view (or clicking it again) refreshes its data: another operator,
// a visitor or the directory may have changed it since sign-in.
const VIEW_LOADERS={doors:()=>[loadDoors(),loadHealth(),loadSetup(),loadBilling()],access:()=>[loadRules(),loadCompile(),loadCreds()],
  visitors:()=>[loadVisitors()],people:()=>[loadPeople(),loadRules(),loadAdmin(),loadBilling()],log:()=>[loadApprovals(),loadAudit(),loadRevocation()]};
let viewLoading=null;
$$('nav button').forEach(b=>b.onclick=()=>{
  $$('nav button').forEach(x=>x.classList.remove('on'));b.classList.add('on');
  $$('.view').forEach(v=>v.classList.remove('on'));$('#v-'+b.dataset.v).classList.add('on');
  const load=VIEW_LOADERS[b.dataset.v];
  if(load&&viewLoading!==b.dataset.v){viewLoading=b.dataset.v;Promise.allSettled(load()).finally(()=>{viewLoading=null;});}
});
const batClass=n=>n>50?'hi':n>25?'mid':'lo';
const errText=r=>r._status===401?'Sign in first':r.code==='sso_required'?r.error:r._status===403?`No permission${r.required?` (needs ${r.required})`:''}${r.detail?': '+r.detail:''}`:(r.error||'Request failed');

async function loadMode(){
  const st=await api('/api/status');
  $('#mode').textContent=st.reason?'Reconnect TTLock':(st.mode||'').startsWith('DEMO')?'Demo data':'Live';
}
async function init(){
  const auth=await api('/api/auth/session');
  showSession(auth);
  if(!auth.openReads&&!signedIn){
    $('#mode').textContent=auth.tokenConfigured||auth.operatorsConfigured?'Sign-in required':'Setup required';
    $('#admin-status').textContent=auth.operatorsConfigured||auth.sso?'Sign in for live data':'Set ADMIN_TOKEN on server';
    return;
  }
  await loadMode();
  await loadDoors();refreshTzNotes(true);await loadHealth();await loadSetup();await loadPeople();await loadRules();await loadAudit();await loadCreds();await loadCompile();await loadAdmin();await loadRevocation();await loadAnchors();await loadApprovals();await loadAlerts();await loadVisitors();await loadBilling();
  if(typeof loadReview==='function'){loadReview();loadSweeps();loadRetention();}
  if(!$('#chat').children.length)addBubble('Copilot ready. I can explain access decisions, plan service visits, spot anomalies and draft rule changes for your approval.',false);
}
/* ---- door-local time: every time the operator types or reads is in the door's time zone ---- */
const BROWSER_TZ=(()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}})();
function doorTz(lockId){const d=DOORS.find(x=>Number(x.lockId)===Number(lockId));return (d&&d.timeZone)||'UTC';}
function tzParts(date,tz){
  const f=new Intl.DateTimeFormat('en-CA',{timeZone:tz,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  const p=Object.fromEntries(f.formatToParts(date).map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};
}
function tzAbbr(date,tz){try{return (new Intl.DateTimeFormat('en-GB',{timeZone:tz,timeZoneName:'short'}).formatToParts(date).find(x=>x.type==='timeZoneName')||{}).value||tz;}catch{return tz;}}
/** "5 Oct 2026, 23:59 BST" — an instant shown as wall-clock time at the door. */
function atDoor(iso,lockId,{dateOnly=false}={}){
  const d=new Date(iso);if(Number.isNaN(d.getTime()))return String(iso||'');
  const tz=doorTz(lockId);
  const opts=dateOnly?{timeZone:tz,dateStyle:'medium'}:{timeZone:tz,dateStyle:'medium',timeStyle:'short',hourCycle:'h23'};
  return new Intl.DateTimeFormat('en-GB',opts).format(d)+(dateOnly?'':' '+tzAbbr(d,tz));
}
function tzNote(lockId){
  const tz=doorTz(lockId),now=new Date();
  const same=tz===BROWSER_TZ||tzParts(now,tz).time===tzParts(now,BROWSER_TZ).time&&tzParts(now,tz).date===tzParts(now,BROWSER_TZ).date;
  return same?`Door time zone: ${tz} (same as yours).`
    :`<span class="tag o">different time zone</span> Door time zone: <b>${esc(tz)}</b> — now ${esc(tzParts(now,tz).time)} there, ${esc(tzParts(now,BROWSER_TZ).time)} where you are (${esc(BROWSER_TZ)}). Times you enter here are read at the door.`;
}
function refreshTzNotes(prefill=false){
  const e=$('#e-door').value,p=$('#p-door').value;
  if(e){$('#e-tz').innerHTML=tzNote(e);if(prefill){const n=tzParts(new Date(),doorTz(e));$('#e-when').value=`${n.date}T${n.time}`;}}
  if(p){const today=tzParts(new Date(),doorTz(p)).date;$('#p-tz').innerHTML=tzNote(p);$('#p-end').min=$('#p-start').value||today;$('#p-start').min=today;}
}
async function loadDoors(){
  const d=await api('/api/doors');DOORS=d.doors||[];
  if(d._status===503){$('#doors').innerHTML=`<div class="empty"><span class="tag r">lock vendor unavailable</span> ${esc(d.error)}</div>`;return;}
  $('#doors').innerHTML=DOORS.length?DOORS.map(l=>{
    const cls=!l.hasGateway?'off':(l.electricQuantity<=25?'warn':'');
    const bat=Number(l.electricQuantity)||0;
    return `<div class="door ${cls}">
      <div><b>${esc(l.lockAlias)}</b>
        <div class="meta">${esc(l.site||'—')} ${l.doorGroup?'· '+esc(l.doorGroup):''}</div>
        <div class="meta"><span class="bat ${batClass(bat)}">${bat}% battery</span><span class="bat-fc" data-fc="${Number(l.lockId)}"></span>
        ${l.hasGateway?'<span class="tag g" style="margin-left:6px">online</span>':'<span class="tag r" style="margin-left:6px">no gateway</span>'}</div>
      </div><button class="btn sm" type="button" data-unlock="${Number(l.lockId)}">Unlock</button></div>`}).join(''):'<div class="empty">No doors visible to you</div>';
  const opts=DOORS.map(l=>`<option value="${Number(l.lockId)}">${esc(l.lockAlias)}</option>`).join('');
  $('#e-door').innerHTML=opts;$('#r-door').innerHTML=opts;$('#p-door').innerHTML=opts;loadRecords();
}
/** Battery trend (lock-health-core): "~N days left" beside the level once there is enough history. */
async function loadForecasts(){
  const h=await api('/api/doors/health');if(!h.ok)return null;
  for(const l of h.locks){const el=$(`[data-fc="${Number(l.lockId)}"]`);if(!el)continue;
    el.innerHTML=l.daysLeft!==null&&l.daysLeft!==undefined?` <span class="meta" title="${esc(l.slopePerDay!==null?(-l.slopePerDay)+'%/day':'')}">· ~${Number(l.daysLeft)} days left${l.emptyOn?' ('+esc(l.emptyOn)+')':''}</span>`:'';}
  return h;
}
$('#doors').addEventListener('click',e=>{const b=e.target.closest('[data-unlock]');if(b)unlock(b.dataset.unlock,b);});
// Owner's "Get started": checklist + the office setup pack (onboarding-core).
async function loadSetup(){
  const r=await api('/api/onboarding/office');
  $('#setup-card').hidden=!r.ok||r.checklist.every(c=>c.done);
  if(!r.ok)return;
  $('#setup-list').innerHTML=`<ol style="margin:0;padding-left:20px">${r.checklist.map(c=>`<li style="margin:3px 0">${c.done?'<span class="tag g">done</span>':'<span class="tag">to do</span>'} <b>${esc(c.label)}</b>${c.done?'':` <span class="meta">— ${esc(c.hint)}</span>`}</li>`).join('')}</ol>`;
  const doors=r.checklist.find(c=>c.id==='doors');
  $('#setup-office').hidden=!(doors&&!doors.done)&&!$('#so-res').innerHTML; // keep a just-applied result visible
  if(!$('#so-tz').value)$('#so-tz').value=BROWSER_TZ;
}
const soBody=()=>{const w=(f,t)=>({days:[1,2,3,4,5],from:$(f).value,to:$(t).value});return {timeZone:$('#so-tz').value.trim(),officeHours:w('#so-of','#so-ot'),cleaningHours:w('#so-cf','#so-ct')};};
function renderPlan(p,created){
  const site=k=>(p.sites.find(s=>s.key===k)||{}).name||'';
  const dg=k=>(p.doorGroups.find(d=>d.key===k)||{}).name||k;
  const ug=k=>(p.userGroups.find(u=>u.key===k)||{}).name||k;
  const sch=k=>(p.schedules.find(s=>s.key===k)||{});
  return `${created?`<div class="res y">Created: ${esc(Object.entries(created).filter(([,n])=>n).map(([k,n])=>{const w={sites:'site',doorGroups:'door group',schedules:'schedule',userGroups:'people group',assignments:'rule'}[k]||k;return `${n} ${w}${n===1?'':'s'}`;}).join(', ')||'nothing')}. Next: add people to the Staff and Cleaners groups (or connect SCIM) and their codes are issued.</div>`:''}
    <table><tr><th>Site</th><th>Door group</th><th>Doors</th></tr>${p.doorGroups.map(d=>`<tr><td>${esc(site(d.siteKey))}</td><td>${esc(d.name)} ${d.sensitive?'<span class="tag r">sensitive</span>':''}</td><td>${esc(d.doors.join(', '))}</td></tr>`).join('')||'<tr><td colspan="3" class="meta">No ungrouped doors.</td></tr>'}</table>
    <table style="margin-top:8px"><tr><th>People group</th><th>Opens</th><th>When</th></tr>${p.assignments.map(a=>{const s=sch(a.scheduleKey);const w=(s.windows||[])[0]||{};return `<tr><td>${esc(ug(a.userGroupKey))}</td><td>${esc(dg(a.doorGroupKey))}</td><td>${esc(s.name||'')} <span class="meta">Mon–Fri ${esc(w.from||'')}–${esc(w.to||'')}</span></td></tr>`;}).join('')}</table>
    ${(p.notes||[]).map(n=>`<div class="meta" style="margin-top:4px">• ${esc(n)}</div>`).join('')}`;
}
$('#so-preview').addEventListener('click',async()=>{
  const b=soBody();
  const r=await api('/api/onboarding/office?timeZone='+encodeURIComponent(b.timeZone));
  if(!r.ok||!r.plan){$('#so-res').innerHTML=`<div class="res n">${esc(r.ok?'Enter a valid time zone, e.g. Europe/London':errText(r))}</div>`;$('#so-apply').disabled=true;return;}
  // The preview uses default hours; the server applies the hours entered here.
  $('#so-res').innerHTML=renderPlan({...r.plan,schedules:r.plan.schedules.map(s=>({...s,windows:[s.key==='office'?b.officeHours:b.cleaningHours]}))});
  $('#so-apply').disabled=!r.plan.doorGroups.length;
});
$('#so-apply').addEventListener('click',async()=>{
  if(!confirm('Create these sites, door groups, schedules and rules? Every change is audited.'))return;
  $('#so-apply').disabled=true;
  const r=await post('/api/onboarding/office',soBody());
  if(!r.ok){$('#so-res').innerHTML=`<div class="res n">${esc(errText(r))}</div>`;$('#so-apply').disabled=false;return;}
  $('#so-res').innerHTML=r.message?`<div class="res y">${esc(r.message)}</div>`:renderPlan(r.plan,r.created);
  loadDoors();loadRules();loadAudit();loadSetup();
});
async function loadHealth(){
  const [h,f]=await Promise.all([api('/api/health'),loadForecasts()]);
  const low=(h.lowBattery||[]).length, off=(h.offline||[]).length;
  const soon=f?f.locks.filter(l=>l.band==='forecast').length:0;
  const silent=f&&f.callback&&f.callback.silent;
  $('#kpis').innerHTML=`
    <div class="kpi"><div class="n">${Number(h.total)||0}</div><div class="l">Doors</div></div>
    <div class="kpi"><div class="n ${low?'warn':'ok'}">${low}</div><div class="l">Low battery</div></div>
    <div class="kpi"><div class="n ${off?'bad':'ok'}">${off}</div><div class="l">No gateway</div></div>${soon?`
    <div class="kpi"><div class="n warn">${soon}</div><div class="l">Battery due in 3 weeks</div></div>`:''}${silent?`
    <div class="kpi" title="TTLock has records it never sent: check the callback URL in the TTLock developer console"><div class="n bad">!</div><div class="l">TTLock callback silent since ${esc(new Date(f.callback.lastAt).toLocaleString())}</div></div>`:''}`;
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
    USERS.map(p=>`<tr><td><b>${esc(p.name)}</b>${p.source==='scim'?' <span class="tag" title="Managed by your directory (SCIM)">directory</span>':''}<div class="meta">${esc(p.email||'')}</div></td>
    <td>${(p.groupIds||[]).map(i=>'<span class="chip">'+esc(gname(i))+'</span>').join('')}</td>
    <td>${p.suspended?`<span class="tag r">${p.suspendedBy==='directory'?'deactivated in directory':'suspended'}</span>`:'<span class="tag g">active</span>'}
    ${p.validTo?'<div class="meta">until '+esc(String(p.validTo).slice(0,10))+'</div>':''}</td>
    <td>${p.suspendedBy==='directory'?'':`<button class="btn2 sm" type="button" data-suspend="${esc(p.id)}" data-to="${p.suspended?'unsuspend':'suspend'}">${p.suspended?'Reinstate':'Suspend'}</button>`}</td></tr>`).join('')+`</table><div id="people-msg" class="meta" style="margin-top:8px"></div>`;
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
  if(r._status===202){
    $('#people-msg').textContent=`Sent for approval: reinstating reaches a sensitive door, so a second operator must approve (request ${r.approval.id}, expires ${new Date(r.approval.expiresAt).toLocaleString()}).`;
    loadApprovals();loadAudit();return;
  }
  const rc=r.reconcile;
  if(rc&&!rc.error)$('#people-msg').textContent=`Suspended. Credentials revoked remotely: ${Number(rc.revoked)} · awaiting on-site removal: ${Number(rc.pendingRemoval)}${rc.failed?' · failed (will retry): '+Number(rc.failed):''}`;
  loadCreds();loadAudit();loadCompile();loadRevocation();
});
/* ---- operators & single sign-on (shown only with role.manage / owner) ---- */
const when=t=>t?esc(String(t).replace('T',' ').slice(0,16))+' UTC':'never';
async function loadAdmin(){
  const [o,sso,sites]=await Promise.all([api('/api/operators'),api('/api/sso'),api('/api/sites')]);
  $('#admin-card').hidden=!o.ok;
  if(!o.ok)return;
  const siteName=id=>((sites.sites||[]).find(x=>x.id===id)||{}).name||id;
  const live=(o.operators||[]).filter(x=>!x.revokedAt);
  $('#ops').innerHTML=`<table><tr><th>Operator</th><th>Role</th><th>Sites</th><th>Sign-in</th><th>Last login</th><th></th></tr>`+
    live.map(x=>`<tr><td><b>${esc(x.name)}</b><div class="meta">${esc(x.email||'')}</div></td><td>${esc(x.role)}</td>
    <td>${(x.siteIds||[]).length?x.siteIds.map(i=>'<span class="chip">'+esc(siteName(i))+'</span>').join(''):'all'}</td>
    <td>${x.ssoLinked?'<span class="tag g">SSO</span>':x.email?'<span class="tag o">SSO invited</span>':'<span class="tag">token</span>'}${x.breakGlass?' <span class="tag r">break-glass</span>':''}</td>
    <td class="meta">${when(x.lastLoginAt)}</td>
    <td><button class="btn2 sm" type="button" data-revoke-op="${esc(x.id)}">Revoke</button></td></tr>`).join('')+
    (o.bootstrap||[]).map(x=>`<tr><td><b>${esc(x.name)}</b><div class="meta">server configuration</div></td><td>${esc(x.role)}</td><td>${(x.siteIds||[]).length?x.siteIds.map(i=>'<span class="chip">'+esc(siteName(i))+'</span>').join(''):'all'}</td><td><span class="tag">env token</span></td><td></td><td></td></tr>`).join('')+'</table>';
  $('#i-site').innerHTML='<option value="*">All sites</option>'+(sites.sites||[]).map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  const [dir,ug]=await Promise.all([api('/api/directory'),api('/api/userGroups')]);
  $('#dir-box').hidden=!dir.ok;
  if(dir.ok){
    $('#dir-state').textContent=`SCIM base URL: ${dir.scimBaseUrl} · people from directory: ${Number(dir.users.total)} (${Number(dir.users.inactive)} deactivated) · connections: ${(dir.provisioners||[]).length}`;
    const opts=sel=>'<option value="">— no door access —</option>'+(ug.userGroups||[]).map(x=>`<option value="${esc(x.id)}"${x.id===sel?' selected':''}>${esc(x.name)}</option>`).join('');
    $('#dir-groups').innerHTML=(dir.groups||[]).length?`<table><tr><th>Directory group</th><th>Members</th><th>Grants access as</th></tr>`+
      dir.groups.map(g=>`<tr><td><b>${esc(g.displayName)}</b></td><td>${Number(g.members)}</td>
      <td><select data-map-group="${esc(g.id)}" aria-label="Map ${esc(g.displayName)}">${opts(g.userGroupId)}</select></td></tr>`).join('')+'</table><div id="map-msg" class="meta"></div>'
      :'<div class="meta">No groups pushed yet. Assign groups to the AccessX app in your directory.</div>';
  }
  $('#sso-box').hidden=!sso.ok;
  if(sso.ok){
    const c=sso.sso;
    $('#sso-state').textContent=c?`Active · ${c.issuer} · domains: ${(c.domains||[]).join(', ')||'any'} · secret: ${c.hasClientSecret?'stored (encrypted)':'none (PKCE public client)'} · redirect URI: ${sso.redirectUri}`
      :`Not configured. Register this redirect URI at your identity provider: ${sso.redirectUri}`;
    if(c){$('#s-issuer').value=c.issuer;$('#s-client').value=c.clientId;$('#s-domains').value=(c.domains||[]).join(', ');}
    $('#sso-remove').hidden=!c;
    $('#sso-domains').innerHTML=c&&(c.domainStatus||[]).length?`<table><tr><th>Domain</th><th>Status</th><th>DNS record to add</th><th></th></tr>`+
      c.domainStatus.map(d=>`<tr><td><b>${esc(d.domain)}</b></td>
      <td>${d.verified?'<span class="tag g">verified</span>':'<span class="tag o">not verified</span>'}</td>
      <td class="meta">${d.verified?esc(when(d.verifiedAt)):d.record?`TXT <code>${esc(d.record.name)}</code> = <code>${esc(d.record.value)}</code>`:'save again to get a record'}</td>
      <td>${d.verified?'':`<button class="btn2 sm" type="button" data-verify-domain="${esc(d.domain)}">Check DNS</button>`}</td></tr>`).join('')+
      '</table><div class="hint">Only verified domains route sign-ins by email and let directory sync adopt existing people.</div>':'';
    $('#sso-enforce-box').hidden=!c;
    if(c){
      $('#sso-enforce').textContent=c.enforced?'Stop requiring single sign-on':'Require single sign-on';
      $('#sso-enforce').dataset.on=c.enforced?'1':'';
      if(!$('#sso-enforce-msg').dataset.keep)$('#sso-enforce-msg').textContent=c.enforced?'Single sign-on is required for people.':'';
      $('#sso-enforce-msg').dataset.keep='';
    }
  }
  const va=await api('/api/vendor-account');
  $('#vendor-box').hidden=!va.ok;
  if(va.ok){
    const a=va.account;
    const vname=a.kind==='nuki'?'Nuki':'TTLock';
    $('#vendor-state').innerHTML=a.connected
      ?`${a.status==='connected'?'<span class="tag g">connected</span>':'<span class="tag r">reconnect required</span>'} ${vname} · ${esc(a.account)} · ${a.kind==='nuki'?'API token (does not expire; changing the Nuki Web password destroys it)':`${esc(a.region)} · ${a.usesPlatformApp?'platform app':'own app'} · token valid until ${esc(String(a.tokenExpiresAt).slice(0,10))}`} · ${Number(a.lockCount)||0} locks${a.lastError?' · '+esc(a.lastError):''}`
      :`Not connected — this account uses ${DOORS.length?'the demo fleet':'no locks'}.${a.secretsKeyConfigured?'':' <span class="tag o">server has no SECRETS_KEY</span>'}${a.platformAppConfigured?'':' <span class="tag o">no platform TTLock app: enter your own client ID/secret</span>'}`;
    if(a.connected){$('#v-kind').value=a.kind||'ttlock';if(a.kind!=='nuki'){$('#v-user').value=a.account;$('#v-region').value=a.region;}}
    showVendorKind();
    $('#vendor-remove').hidden=!a.connected;
    // What this vendor cannot do, in words, so nobody expects a feature it lacks.
    const vi=await api('/api/vendor');
    const limits=vi.ok&&Array.isArray(vi.limits)?vi.limits:[];
    $('#vendor-limits').hidden=!limits.length;
    $('#vendor-limits').innerHTML=limits.length?`<b>Limits of ${vi.active==='nuki'?'Nuki':vi.active==='ttlock'?'TTLock':esc(vi.active)}</b><ul style="margin:4px 0 0 18px;padding:0">${limits.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:'';
  }
}
function showVendorKind(){
  const nuki=$('#v-kind').value==='nuki';
  $$('#vendor-form .v-ttlock').forEach(x=>{x.hidden=nuki;});
  $$('#vendor-form .v-nuki').forEach(x=>{x.hidden=!nuki;});
  $('#v-user').required=!nuki;$('#v-pass').required=!nuki;$('#v-nuki-token').required=nuki;
}
$('#v-kind').addEventListener('change',showVendorKind);
$('#vendor-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const nuki=$('#v-kind').value==='nuki';
  const body=nuki?{kind:'nuki',apiToken:$('#v-nuki-token').value.trim()}:{kind:'ttlock',region:$('#v-region').value,username:$('#v-user').value.trim(),password:$('#v-pass').value};
  if(!nuki&&($('#v-cid').value||$('#v-csec').value)){body.clientId=$('#v-cid').value.trim();body.clientSecret=$('#v-csec').value;}
  $('#vendor-msg').textContent=nuki?'Connecting to Nuki…':'Connecting to TTLock…';
  const r=await api('/api/vendor-account',{method:'PUT',body:JSON.stringify(body)});
  $('#v-pass').value='';$('#v-csec').value='';$('#v-nuki-token').value='';
  $('#vendor-msg').textContent=r.ok?`Connected: ${Number(r.account.lockCount)} locks. ${nuki?'The API token is stored encrypted.':'The password was used once and discarded.'}${r.account.switchedAccount?' A different account than before: codes issued on the old locks are being reconciled.':''}`:errText(r);
  if(r.ok){loadMode();loadDoors();loadHealth();loadAdmin();loadAudit();}
});
$('#vendor-remove').addEventListener('click',async()=>{
  if(!confirm('Disconnect the lock vendor account? Doors from that account disappear from AccessX; codes already on the locks keep working until removed.'))return;
  const r=await api('/api/vendor-account',{method:'DELETE'});
  $('#vendor-msg').textContent=r.ok?'Disconnected.':errText(r);
  loadMode();loadDoors();loadHealth();loadAdmin();loadAudit();
});
$('#ops').addEventListener('click',async e=>{
  const b=e.target.closest('[data-revoke-op]');if(!b)return;
  if(!confirm('Revoke this operator? Their sessions end immediately.'))return;
  const r=await api('/api/operators/'+encodeURIComponent(b.dataset.revokeOp),{method:'DELETE'});
  if(!r.ok){b.textContent=errText(r);return;}
  loadAdmin();loadAudit();
});
$('#dir-groups').addEventListener('change',async e=>{
  const sel=e.target.closest('[data-map-group]');if(!sel)return;
  const r=await api('/api/directory/groups/'+encodeURIComponent(sel.dataset.mapGroup),{method:'PUT',body:JSON.stringify({userGroupId:sel.value||null})});
  const msg=r.ok?`Mapped. ${Number(r.usersChanged)} people updated${r.usersLostAccess?` · ${Number(r.usersLostAccess)} lost access (credentials revoked: ${Number((r.reconcile||{}).revoked||0)})`:''}.`:errText(r);
  await loadAdmin();if($('#map-msg'))$('#map-msg').textContent=msg;loadPeople();loadCreds();loadAudit();
});
$('#scim-token-btn').addEventListener('click',async()=>{
  const r=await post('/api/operators',{name:'Directory sync',role:'r_provisioner'});
  $('#scim-token-out').textContent=r.ok?`Secret token (shown once — paste into your directory's provisioning settings): ${r.token}`:errText(r);
  if(r.ok)loadAdmin();
});
$('#invite-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const site=$('#i-site').value;
  const r=await post('/api/operators',{name:$('#i-name').value,email:$('#i-email').value,role:$('#i-role').value,siteIds:site==='*'?[]:[site],auth:'sso'});
  $('#invite-msg').textContent=r.ok?`Invited ${r.operator.email}. They sign in with "Sign in with SSO".`:errText(r);
  if(r.ok){$('#i-name').value='';$('#i-email').value='';loadAdmin();loadAudit();}
});
$('#sso-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const body={issuer:$('#s-issuer').value.trim(),clientId:$('#s-client').value.trim(),domains:$('#s-domains').value.split(/[\s,]+/).filter(Boolean)};
  if($('#s-secret').value)body.clientSecret=$('#s-secret').value;
  const r=await api('/api/sso',{method:'PUT',body:JSON.stringify(body)});
  $('#s-secret').value='';
  $('#sso-msg').textContent=r.ok?'Saved. Discovery document verified.':errText(r);
  if(r.ok){loadAdmin();loadAudit();}
});
$('#sso-domains').addEventListener('click',async e=>{
  const b=e.target.closest('[data-verify-domain]');if(!b)return;
  b.disabled=true;
  const r=await post('/api/sso/domains/verify',{domain:b.dataset.verifyDomain});
  $('#sso-msg').textContent=r.ok?`${b.dataset.verifyDomain} verified.`:errText(r);
  if(r.ok)loadAdmin();else b.disabled=false;
});
$('#sso-enforce').addEventListener('click',async()=>{
  const on=!$('#sso-enforce').dataset.on;
  if(on&&!confirm('Require single sign-on? Token sign-ins of people end now. Keep the break-glass token somewhere safe.'))return;
  const r=await api('/api/sso/enforcement',{method:'PUT',body:JSON.stringify({enforced:on})});
  $('#sso-enforce-msg').textContent=r.ok?(on?`Single sign-on is now required · ${Number(r.tokenSessionsEnded)} token session(s) ended.`:'Token sign-in allowed again.'):errText(r);
  $('#sso-enforce-msg').dataset.keep='1';
  loadAdmin();loadAudit();
});
$('#glass-create').addEventListener('click',async()=>{
  const r=await post('/api/operators',{name:'Break-glass owner',role:'r_owner',breakGlass:true});
  $('#sso-enforce-msg').textContent=r.ok?`Break-glass token (shown once — store it offline, e.g. in a safe or a sealed password-manager entry): ${r.token}`:errText(r);
  $('#sso-enforce-msg').dataset.keep='1';
  loadAdmin();loadAudit();
});
$('#sso-remove').addEventListener('click',async()=>{
  if(!confirm('Remove single sign-on? Everyone signed in via SSO is signed out.'))return;
  const r=await api('/api/sso',{method:'DELETE'});
  $('#sso-msg').textContent=r.ok?'Single sign-on removed.':errText(r);
  loadAdmin();loadAudit();
});

const dur=s=>s===null||s===undefined?'—':s<90?`${Math.round(s)} s`:s<5400?`${Math.round(s/60)} min`:s<172800?`${(s/3600).toFixed(1)} h`:`${Math.round(s/86400)} d`;
async function loadRevocation(){
  const r=await api('/api/reports/revocation?days=30');
  if(!r.ok){$('#ttr-kpis').innerHTML=`<div class="empty">${esc(errText(r))}</div>`;$('#ttr-open').innerHTML='';return;}
  const o=r.open||{};
  const SLA_H=Number(r.slaHours)||48;
  $('#ttr-kpis').innerHTML=`
    <div class="kpi"><div class="n ${r.remote.p95Sec>300?'warn':'ok'}">${dur(r.remote.p95Sec)}</div><div class="l">Remote revoke p95 (${Number(r.remote.count)})</div></div>
    <div class="kpi"><div class="n ${r.onsite.p95Sec>SLA_H*3600?'warn':''}">${dur(r.onsite.p95Sec)}</div><div class="l">On-site removal p95 (${Number(r.onsite.count)})</div></div>
    <div class="kpi"><div class="n ${o.stillActive?'bad':o.count?'warn':'ok'}">${Number(o.count)||0}</div><div class="l">Still open${o.oldestSec?' · oldest '+dur(o.oldestSec):''}</div></div>`;
  const door=id=>(DOORS.find(d=>Number(d.lockId)===Number(id))||{}).lockAlias||`Lock ${Number(id)}`;
  $('#ttr-open').innerHTML=(o.items||[]).length?`<table><tr><th>Door</th><th>Why</th><th>Status</th><th>Open for</th></tr>`+
    o.items.map(i=>`<tr><td>${esc(door(i.lockId))}</td><td>${esc(i.trigger)}</td>
    <td>${i.outcome==='open_remote'?'<span class="tag r">code still works — revoke failing</span>':'<span class="tag o">remove at the lock</span>'}${i.ageSec>=SLA_H*3600?` <span class="tag r">over ${SLA_H} h</span>`:''}</td>
    <td>${dur(i.ageSec)}</td></tr>`).join('')+'</table>'
    :`<div class="meta">Nothing open. ${Number(r.credentials)||0} credentials of ${r.triggers??'—'} leavers were removed in this window.</div>`;
}

/* ---- billing (owner) ---- */
async function loadBilling(){
  const r=await api('/api/billing');
  const b=r.ok&&r.billing&&r.billing.enabled?r.billing:null;
  $('#billing-card').hidden=!b;
  const st=b?b.standing:null;
  const warn=st&&(st.restricted||st.restrictsInDays!==null&&st.restrictsInDays!==undefined);
  $('#billing-banner').hidden=!warn;
  if(!b)return;
  if(warn)$('#billing-banner').innerHTML=b.stage==='closure'
    ?`<span class="tag r">billing</span> <b>The account is due for closure.</b> Doors keep working until then; closure comes with 30 days' written notice. Keep what you need now (Activity → Audit export, Evidence pack) and <a href="#" data-goto-billing>sort out billing</a>.`
    :st.restricted
    ?`<span class="tag r">billing</span> <b>Adding people, visitors, codes and rules is paused</b> until the subscription is paid. Doors keep opening; removing access works. <a href="#" data-goto-billing>Billing</a>`
    :`<span class="tag o">billing</span> The last payment failed. Adding people and visitors pauses in <b>${Number(st.restrictsInDays)} day(s)</b> unless the card is updated. <a href="#" data-goto-billing>Billing</a>`;
  const label={none:'No subscription yet',active:'Active',trialing:'Trial',past_due:'Payment failed',unpaid:'Unpaid',canceled:'Cancelled',incomplete:'Waiting for payment',incomplete_expired:'Checkout expired',paused:'Paused'}[st.status]||st.status;
  const tag=st.restricted?'r':st.status==='active'||st.status==='trialing'?'g':st.status==='none'?'':'o';
  $('#billing-state').innerHTML=`<div><span class="tag ${tag}">${esc(label)}</span>${b.testMode?' <span class="tag">Stripe test mode</span>':''}</div>
    <div class="meta" style="margin-top:6px">This month (${esc(b.period)}): <b>${Number(b.usage.doorDays)}</b> door-days${b.smsBilled?` · <b>${Number(b.usage.smsSegments)}</b> text segments`:''}${b.unsentReports?` · ${Number(b.unsentReports)} usage report(s) waiting to reach Stripe`:''}</div>
    ${b.estimate?`<div class="meta">Estimated so far: <b>${esc(b.estimate.currency.toUpperCase())} ${Number(b.estimate.amount).toFixed(2)}</b> before tax (${esc(b.estimate.currency.toUpperCase())} ${Number(b.estimate.perDoorMonth).toFixed(2)} per door per month${b.estimate.perSmsSegment!==null?`, ${Number(b.estimate.perSmsSegment).toFixed(3)} per text segment`:''}). The invoice from Stripe is what counts.</div>`:''}`;
  $('#bill-start').hidden=b.subscribed;
  $('#bill-manage').hidden=st.status==='none';
}
const billGo=async(url,btn)=>{
  btn.disabled=true;
  const r=await post(url,{});
  btn.disabled=false;
  if(r.ok&&r.url&&/^https:\/\//.test(r.url)){location.href=r.url;return;}
  $('#bill-msg').innerHTML=`<span class="tag r">not started</span> ${esc(errText(r))}`;
};
$('#bill-start').addEventListener('click',e=>billGo('/api/billing/checkout',e.currentTarget));
$('#bill-manage').addEventListener('click',e=>billGo('/api/billing/portal',e.currentTarget));
document.addEventListener('click',e=>{
  const a=e.target.closest&&e.target.closest('[data-goto-billing]');
  if(!a)return;
  e.preventDefault();
  $('nav button[data-v="people"]').click();
  $('#billing-card').scrollIntoView({behavior:'smooth'});
});
if(location.hash==='#billing-done')$('#bill-msg').innerHTML='<span class="tag g">thank you</span> The subscription shows as active once Stripe confirms the payment (usually a few seconds).';

/* ---- rules editor: rules, door groups, holidays, people groups, schedules ---- */
const canRules=()=>Boolean(ME&&(ME.perms||[]).some(p=>p==='*'||p==='rule.manage'));
const allScope=()=>Boolean(ME&&(ME.siteIds||[]).includes('*'));
const patch=(u,data)=>api(u,{method:'PATCH',body:JSON.stringify(data||{})});
const del=u=>api(u,{method:'DELETE'});
const waiting=r=>r._status===202;
const outcome=(r,done)=>waiting(r)?`<span class="tag o">waiting for approval</span> ${esc(r.message||'A second operator must approve this.')} See Activity → Waiting for a second person.`
  :r.ok?`<span class="tag g">saved</span> ${esc(done)}`
  :`<span class="tag r">not saved</span> ${esc(r.referencedBy?`still used by ${r.referencedBy.length} rule(s) or people: remove those first`:errText(r))}`;
const WEEKDAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
let RULES={a:[],ug:[],dg:[],s:[],sites:[],h:[]};
const nameIn=(arr,id,fallback)=>(arr.find(x=>x.id===id)||{}).name||fallback;
const doorName=id=>(DOORS.find(d=>Number(d.lockId)===Number(id))||{}).lockAlias||`Lock ${Number(id)}`;
const afterRuleChange=()=>Promise.all([loadRules(),loadPeople(),loadCompile(),loadSetup()]).catch(()=>{});

async function loadRules(){
  const [a,ug,dg,s,st,h]=await Promise.all([api('/api/assignments'),api('/api/userGroups'),api('/api/doorGroups'),api('/api/schedules'),api('/api/sites'),api('/api/holidays')]);
  RULES={a:a.assignments||[],ug:ug.userGroups||[],dg:dg.doorGroups||[],s:s.schedules||[],sites:st.sites||[],h:h.holidays||[]};
  const m=canRules(), all=allScope(), R=RULES;
  const siteName=id=>id?nameIn(R.sites,id,id):'All sites';
  // Rules
  $('#rules').innerHTML=`<table><tr><th>Who</th><th>Can open</th><th>When</th>${m?'<th></th>':''}</tr>`+
    R.a.map(r=>{const g=R.dg.find(x=>x.id===r.doorGroupId)||{};return `<tr><td>${esc(nameIn(R.ug,r.userGroupId,r.userGroupId))}</td>
    <td>${esc(g.name||r.doorGroupId)}${g.sensitive?' <span class="tag r">sensitive · 4-eyes</span>':''}</td><td>${esc(nameIn(R.s,r.scheduleId,'24/7'))}</td>
    ${m?`<td><button class="btn2 sm" type="button" data-del-rule="${esc(r.id)}">Remove</button></td>`:''}</tr>`;}).join('')+
    (R.a.length?'':`<tr><td colspan="4" class="meta">No rules yet: nobody can open anything.</td></tr>`)+`</table>`;
  const opt=(arr,label=x=>x.name)=>arr.map(x=>`<option value="${esc(x.id)}">${esc(label(x))}</option>`).join('');
  $('#rule-add').hidden=!m;
  if(m){
    $('#ra-ug').innerHTML=opt(R.ug,x=>x.siteId?`${x.name} (${siteName(x.siteId)})`:x.name);
    $('#ra-dg').innerHTML=opt(R.dg,x=>`${x.name} (${siteName(x.siteId)})${x.sensitive?' · sensitive':''}`);
    $('#ra-sch').innerHTML='<option value="">24/7</option>'+opt(R.s);
  }
  // Door groups (grouped by site); doors not in any group listed last.
  const grouped=new Set(R.dg.flatMap(g=>g.lockIds||[]).map(Number));
  const ungrouped=DOORS.map(d=>Number(d.lockId)).filter(id=>!grouped.has(id));
  const moveSel=(lock,from,siteId)=>{
    const targets=R.dg.filter(g=>g.id!==from&&(!from||g.siteId===siteId||all)&&!(g.lockIds||[]).map(Number).includes(lock));
    return `<select class="sm" data-move="${lock}" data-from="${esc(from||'')}" aria-label="Move ${esc(doorName(lock))}"><option value="">${from?'Move…':'Add to…'}</option>${
      targets.map(g=>`<option value="${esc(g.id)}">${from?'to ':''}${esc(g.name)}${g.siteId!==siteId?` (${esc(siteName(g.siteId))})`:''}</option>`).join('')}${from?'<option value="-">Take out of this group</option>':''}</select>`;
  };
  const chip=(lock,from,siteId)=>`<span class="chip" style="display:inline-flex;gap:6px;align-items:center;margin:2px">${esc(doorName(lock))}${m?moveSel(lock,from,siteId):''}</span>`;
  const rows=[...R.dg].sort((x,y)=>siteName(x.siteId).localeCompare(siteName(y.siteId))||x.name.localeCompare(y.name));
  $('#dgroups').innerHTML=`<table><tr><th>Site</th><th>Door group</th><th>Doors</th></tr>`+rows.map(g=>`<tr>
    <td>${esc(siteName(g.siteId))}</td>
    <td><b>${esc(g.name)}</b> ${g.sensitive?'<span class="tag r">sensitive</span>':''}
      ${m?`<div style="margin-top:4px"><button class="btn2 sm" type="button" data-dg-rename="${esc(g.id)}">Rename</button>
      <button class="btn2 sm" type="button" data-dg-sens="${esc(g.id)}">${g.sensitive?'Unmark sensitive':'Mark sensitive'}</button>
      <button class="btn2 sm" type="button" data-dg-del="${esc(g.id)}">Delete</button></div>`:''}</td>
    <td>${(g.lockIds||[]).map(l=>chip(Number(l),g.id,g.siteId)).join('')||'<span class="meta">no doors</span>'}</td></tr>`).join('')+
    (ungrouped.length?`<tr><td class="meta">—</td><td><b>Not in any group</b><div class="meta">Nobody can open these through a rule.</div></td><td>${ungrouped.map(l=>chip(l,'',null)).join('')}</td></tr>`:'')+`</table>`;
  $('#dg-add').hidden=!m;
  const siteOpts=(allowAll)=>(allowAll?'<option value="">All sites</option>':'')+opt(R.sites.filter(x=>all||(ME.siteIds||[]).includes(x.id)));
  if(m)$('#dg-site').innerHTML=siteOpts(false);
  // Holidays
  const hs=[...R.h].sort((x,y)=>String(x.date).localeCompare(String(y.date)));
  const today=new Date().toISOString().slice(0,10);
  $('#holidays').innerHTML=hs.length?`<table><tr><th>Date</th><th>Name</th><th>Where</th>${m?'<th></th>':''}</tr>${hs.map(x=>`<tr${x.date<today?' class="meta"':''}>
    <td>${esc(x.date)}</td><td>${esc(x.name||'')}</td><td>${esc(siteName(x.siteId))}</td>${m?`<td><button class="btn2 sm" type="button" data-hol-del="${esc(x.id)}">Remove</button></td>`:''}</tr>`).join('')}</table>`
    :'<div class="meta">No holidays yet.</div>';
  $('#hol-add').hidden=!m;
  if(m)$('#hol-site').innerHTML=siteOpts(all);
  // People groups and schedules (People view)
  $('#ug-add').hidden=!m;
  if(m)$('#ug-site').innerHTML=siteOpts(all);
  $('#sch-add').hidden=!(m&&all);
  if(m&&all&&!$('#sch-days').innerHTML)$('#sch-days').innerHTML=WEEKDAYS.map((d,i)=>`<label><input type="checkbox" value="${i+1}"${i<5?' checked':''}> ${d}</label>`).join('');
}
async function moveDoor(lock,from,to){
  const g=id=>RULES.dg.find(x=>x.id===id);
  const say=h=>{$('#dg-msg').innerHTML=h;};
  if(to){
    const t=g(to);
    const r=await patch('/api/doorGroups/'+encodeURIComponent(to),{lockIds:[...(t.lockIds||[]),lock]});
    if(!r.ok||waiting(r)){say(outcome(r,'')+(waiting(r)&&from?` ${esc(doorName(lock))} stays in “${esc(g(from).name)}” until then; take it out afterwards.`:''));await afterRuleChange();return;}
  }
  if(from){
    const f=g(from);
    const r=await patch('/api/doorGroups/'+encodeURIComponent(from),{lockIds:(f.lockIds||[]).map(Number).filter(x=>x!==lock)});
    if(!r.ok||waiting(r)){say((to?`<span class="tag g">added</span> to “${esc(g(to).name)}”. `:'')+outcome(r,''));await afterRuleChange();return;}
  }
  say(outcome({ok:true},to&&from?`${doorName(lock)} moved from “${g(from).name}” to “${g(to).name}”.`:to?`${doorName(lock)} added to “${g(to).name}”.`:`${doorName(lock)} taken out of “${g(from).name}”.`));
  await afterRuleChange();
}
document.addEventListener('change',e=>{
  const sel=e.target.closest&&e.target.closest('select[data-move]');
  if(!sel||!sel.value)return;
  const to=sel.value==='-'?'':sel.value;
  sel.disabled=true;
  moveDoor(Number(sel.dataset.move),sel.dataset.from||'',to);
});
document.addEventListener('click',async e=>{
  const b=e.target.closest&&e.target.closest('button[data-del-rule],button[data-dg-rename],button[data-dg-sens],button[data-dg-del],button[data-hol-del]');
  if(!b)return;
  const g=id=>RULES.dg.find(x=>x.id===id)||{};
  let r,msg,box;
  if(b.dataset.delRule){
    const a=RULES.a.find(x=>x.id===b.dataset.delRule)||{};
    if(!confirm(`Remove: ${nameIn(RULES.ug,a.userGroupId,'?')} can open ${g(a.doorGroupId).name||'?'}? Their codes for those doors are removed.`))return;
    r=await del('/api/assignments/'+encodeURIComponent(b.dataset.delRule));msg='Rule removed; codes are being taken off the doors.';box='#rules-msg';
  }else if(b.dataset.dgRename){
    const name=prompt('New name for the door group',g(b.dataset.dgRename).name||'');
    if(!name||!name.trim())return;
    r=await patch('/api/doorGroups/'+encodeURIComponent(b.dataset.dgRename),{name:name.trim()});msg='Renamed.';box='#dg-msg';
  }else if(b.dataset.dgSens){
    const x=g(b.dataset.dgSens);
    if(x.sensitive&&!confirm(`Remove the four-eyes protection from “${x.name}”? A second operator must approve.`))return;
    r=await patch('/api/doorGroups/'+encodeURIComponent(x.id),{sensitive:!x.sensitive});msg=x.sensitive?'No longer sensitive.':'Marked sensitive: new access to these doors now needs a second operator.';box='#dg-msg';
  }else if(b.dataset.dgDel){
    if(!confirm(`Delete the door group “${g(b.dataset.dgDel).name}”?`))return;
    r=await del('/api/doorGroups/'+encodeURIComponent(b.dataset.dgDel));msg='Door group deleted.';box='#dg-msg';
  }else{
    const h=RULES.h.find(x=>x.id===b.dataset.holDel)||{};
    if(!confirm(`Remove the holiday ${h.date}${h.name?` (${h.name})`:''}? Doors on “closed on holidays” schedules open that day.`))return;
    r=await del('/api/holidays/'+encodeURIComponent(b.dataset.holDel));msg='Holiday removed.';box='#hol-msg';
  }
  $(box).innerHTML=outcome(r,msg);
  await afterRuleChange();
});
const onCreate=(form,box,build,url,done)=>$(form).addEventListener('submit',async e=>{
  e.preventDefault();
  const body=build();if(!body)return;
  const r=await post(url,body);
  $(box).innerHTML=outcome(r,done(body));
  if(r.ok&&!waiting(r))e.target.reset();
  await afterRuleChange();
});
onCreate('#rule-add','#rules-msg',()=>({userGroupId:$('#ra-ug').value,doorGroupId:$('#ra-dg').value,...($('#ra-sch').value?{scheduleId:$('#ra-sch').value}:{})}),'/api/assignments',
  b=>`${nameIn(RULES.ug,b.userGroupId,'')} can open ${nameIn(RULES.dg,b.doorGroupId,'')} (${nameIn(RULES.s,b.scheduleId,'24/7')}). Codes follow for people in the group.`);
onCreate('#dg-add','#dg-msg',()=>({name:$('#dg-name').value.trim(),siteId:$('#dg-site').value,sensitive:$('#dg-sens').checked}),'/api/doorGroups',b=>`“${b.name}” created. Add doors with “Add to…” or “Move…”.`);
onCreate('#hol-add','#hol-msg',()=>({date:$('#hol-date').value,...($('#hol-name').value.trim()?{name:$('#hol-name').value.trim()}:{}),...($('#hol-site').value?{siteId:$('#hol-site').value}:{})}),'/api/holidays',b=>`${b.date} added.`);
onCreate('#ug-add','#ug-msg',()=>({name:$('#ug-name').value.trim(),...($('#ug-site').value?{siteId:$('#ug-site').value}:{})}),'/api/userGroups',b=>`“${b.name}” created. Give it doors under Access → Access rules.`);
onCreate('#sch-add','#sch-msg',()=>{
  const days=$$('#sch-days input:checked').map(i=>Number(i.value));
  if(!days.length){$('#sch-msg').innerHTML='<span class="tag r">not saved</span> Pick at least one day.';return null;}
  return {name:$('#sch-name').value.trim(),denyOnHolidays:$('#sch-hol').checked,windows:[{days,from:$('#sch-from').value,to:$('#sch-to').value}]};
},'/api/schedules',b=>`“${b.name}” created.`);
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
// Switching door: re-anchor the time to "now at that door" so a London slot is not tested with a Sydney clock.
$('#e-door').addEventListener('change',()=>refreshTzNotes(true));
$('#p-door').addEventListener('change',()=>refreshTzNotes(false));

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

/* ---- four-eyes approvals ---- */
async function loadApprovals(){
  const r=await api('/api/approvals');
  const list=r.ok?(r.approvals||[]):[];
  const ready=r.ok?(r.ready||[]):[];
  $('#appr-card').hidden=!list.length&&!ready.length&&!$('#appr-msg').textContent;
  const who=id=>((USERS||[]).find(u=>u.id===id)||{}).name;
  const pretty=t=>esc(t).replace(/\buser (\w+)/g,(m,id)=>who(id)?`user ${esc(who(id))}`:m);
  $('#appr-list').innerHTML=list.length?`<table><tr><th>Request</th><th>Requested by</th><th>Expires</th><th></th></tr>`+
    list.map(a=>`<tr><td>${pretty(a.summary)}<div class="meta">doors ${a.locks.map(Number).join(', ')}</div></td>
    <td>${esc(a.requestedBy)}<div class="meta">${esc(new Date(a.requestedAt).toLocaleString())}</div></td>
    <td class="meta">${esc(new Date(a.expiresAt).toLocaleString())}</td>
    <td>${a.canDecide?`<button class="btn sm" type="button" data-appr="approve" data-id="${esc(a.id)}">Approve</button> <button class="btn2 sm" type="button" data-appr="reject" data-id="${esc(a.id)}">Reject</button>`:''}
    ${a.canCancel?`<button class="btn2 sm" type="button" data-appr="cancel" data-id="${esc(a.id)}">Cancel</button>`:''}
    ${!a.canDecide&&!a.canCancel?'<span class="meta">needs someone else</span>':''}</td></tr>`).join('')+'</table>'
    :'<div class="meta">Nothing waiting.</div>';
  $('#appr-ready').innerHTML=ready.length?`<div class="meta" style="margin:12px 0 6px"><b>Codes approved for you</b> — only you can see them, once. Uncollected codes are discarded 72 h after approval.</div><table>`+
    ready.map(a=>`<tr><td>${pretty(a.summary)}<div class="meta">approved by ${esc(a.decidedBy)} · ${esc(new Date(a.decidedAt).toLocaleString())}</div></td>
    <td><button class="btn sm" type="button" data-collect="${esc(a.id)}">Show code (once)</button></td></tr>`).join('')+'</table>':'';
}
$('#appr-ready').addEventListener('click',async e=>{
  const b=e.target.closest('[data-collect]');if(!b)return;
  if(!confirm('The code is shown once and then deleted from the server. Ready to write it down or hand it over?'))return;
  b.disabled=true;
  const r=await post(`/api/approvals/${encodeURIComponent(b.dataset.collect)}/collect`,{});
  const msg=$('#appr-msg');
  if(!r.ok)msg.textContent=errText(r);
  else msg.innerHTML=`Passcode (shown once): <b class="code" style="font-size:18px">${esc(r.passcode.keyboardPwd)}</b>${r.credential?` <span class="meta">door ${esc(r.credential.lockId)} · until ${esc(atDoor(r.credential.endAt,r.credential.lockId))} (door time)</span>`:''}`;
  loadApprovals();loadAudit();
});
$('#appr-list').addEventListener('click',async e=>{
  const b=e.target.closest('[data-appr]');if(!b)return;
  const verb=b.dataset.appr;
  const note=verb==='reject'?(prompt('Reason (optional)')||''):'';
  b.disabled=true;
  const r=await post(`/api/approvals/${encodeURIComponent(b.dataset.id)}/${verb}`,{note});
  const msg=$('#appr-msg');
  if(!r.ok)msg.textContent=errText(r);
  else if(verb==='approve'&&r.result&&r.result.codeHeldFor)msg.textContent=`Approved. The passcode was issued and is waiting for ${r.result.codeHeldFor} (the requester) — you never see it.`;
  else msg.textContent=`Request ${verb==='approve'?'approved and applied':verb==='reject'?'rejected':'cancelled'}.`;
  loadApprovals();loadAudit();loadCreds();loadRules();
});

/* ---- passcodes ---- */
async function issuePasscode(acknowledge=false){
  const end=$('#p-end').value,start=$('#p-start').value;
  const body={userId:$('#p-user').value,lockId:Number($('#p-door').value),acknowledgeScheduleGap:acknowledge};
  // End of that day = 00:00 the next day at the door (TTLock codes run on whole hours).
  if(end)body.endLocal=nextDay(end)+'T00:00'; // converted in the door's time zone on the server
  if(start)body.startLocal=`${start}T${$('#p-start-h').value||'08:00'}`;
  const r=await post('/api/passcode',body);
  const out=$('#p-res');
  if(r._status===409&&r.needs==='acknowledgeScheduleGap'){
    out.innerHTML=`<div class="res n"><b>Lock cannot enforce this schedule</b><div style="margin-top:5px">${esc(r.detail)}</div>
      <div style="margin-top:10px"><button class="btn2 sm" type="button" id="p-ack">Issue anyway (partial enforcement, audited)</button></div></div>`;
    $('#p-ack').addEventListener('click',()=>issuePasscode(true));
    return;
  }
  if(!r.ok){out.innerHTML=`<div class="res n">${esc(errText(r))}</div>`;return;}
  if(r._status===202){
    out.innerHTML=`<div class="res n"><b>Sent for approval</b><div style="margin-top:5px">${esc(r.message)}</div><div class="meta" style="margin-top:4px">Request ${esc(r.approval.id)} · expires ${esc(new Date(r.approval.expiresAt).toLocaleString())}</div></div>`;
    loadApprovals();loadAudit();return;
  }
  const c=r.credential;
  out.innerHTML=`<div class="res y"><div class="code">${esc(r.passcode.keyboardPwd)}</div>
    <div class="meta" style="margin-top:6px">Shown once — the system only keeps ${esc(c.codeHint)}.</div>
    <div style="margin-top:6px">${esc(atDoor(c.startAt,c.lockId))} → ${esc(atDoor(c.endAt,c.lockId))} <span class="meta">(door time)</span> ·
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
      <td title="${esc(atDoor(c.endAt,c.lockId))}">${esc(atDoor(c.endAt,c.lockId,{dateOnly:true}))}</td>
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
const ALERT_LABELS={approval_requested:'Approval requests',removal_overdue:'Codes past the removal target',revoke_failed:'Failed revocations',break_glass:'Break-glass sign-ins',vendor_needs_reconnect:'TTLock account must be reconnected',visitor_arrived:'Visitor arrivals (names the visitor)',lock_alarm:'Lock alarms (tamper, forced, keypad locked)',door_left_open:'Door left open',battery_low:'Lock batteries (low or running out)',callback_silent:'TTLock callback stopped',billing_problem:'Billing (payment failed, adding paused, closure notice)'};
async function loadAlerts(){
  const r=await api('/api/alerts');
  $('#alerts-box').hidden=!r.ok;
  if(!r.ok)return;
  const a=r.alerts;
  const when=d=>`${new Date(d.at).toLocaleString()}: ${d.status}`;
  $('#alerts-state').textContent=(a.host?`Webhook: ${a.host} as ${a.format}`:'No webhook.')+
    (a.emails.length?` · email to ${a.emails.length} recipient${a.emails.length>1?'s':''} (${a.emailProvider})`:'')+
    ` · removal target ${a.slaHours} h`+(a.lastDelivery?` · last webhook delivery ${when(a.lastDelivery)}`:'')+
    (a.lastEmailDelivery?` · last email ${when(a.lastEmailDelivery)}`:'')+
    (a.retrying&&a.retrying.count?` · ${a.retrying.count} waiting for retry (next ${new Date(a.retrying.nextAt).toLocaleTimeString()})`:'')+
    (a.secretsKeyConfigured?'':' · SECRETS_KEY is not set on the server, so a webhook cannot be stored');
  $('#al-sla').value=a.slaHours;
  $('#al-format').value=a.format||'';
  $('#al-emails-wrap').hidden=!a.emailAvailable;
  $('#al-emails').value=a.emails.join(', ');
  $('#al-remove').hidden=!a.host;$('#al-test').hidden=!a.configured;
  const dg=a.digest||{events:[],hour:8,timeZone:(DOORS[0]&&DOORS[0].timeZone)||BROWSER_TZ};
  $('#al-dg-events').innerHTML=(a.digestEvents||[]).map(e=>`<label style="display:inline-flex;gap:6px;align-items:center;margin-right:14px;font-weight:normal"><input type="checkbox" data-aldg="${esc(e)}" ${dg.events.includes(e)?'checked':''}>${esc(ALERT_LABELS[e]||e)}</label>`).join('');
  $('#al-dg-hour').innerHTML=Array.from({length:24},(_,h)=>`<option value="${h}" ${h===dg.hour?'selected':''}>${String(h).padStart(2,'0')}:00</option>`).join('');
  $('#al-dg-tz').value=dg.timeZone;
  const dp=a.digestPending||{};
  $('#al-dg-state').textContent=a.digest?`${dp.count||0} waiting · next summary ${dp.nextAt?(()=>{try{return new Date(dp.nextAt).toLocaleString('en-GB',{timeZone:a.digest.timeZone,dateStyle:'medium',timeStyle:'short'})+' '+tzAbbr(new Date(dp.nextAt),a.digest.timeZone);}catch{return dp.nextAt;}})():'—'}. Break-glass, failed revocations and TTLock disconnections are always sent at once.`
    :'Off: every alert is sent as it happens. Break-glass, failed revocations and TTLock disconnections are always sent at once.';
  $('#al-events').innerHTML=a.availableEvents.map(e=>`<label style="display:inline-flex;gap:6px;align-items:center;margin-right:14px;font-weight:normal"><input type="checkbox" data-alev="${esc(e)}" ${a.events.includes(e)?'checked':''}>${esc(ALERT_LABELS[e]||e)}</label>`).join('');
}
$('#alerts-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const body={slaHours:Number($('#al-sla').value),events:[...document.querySelectorAll('[data-alev]')].filter(x=>x.checked).map(x=>x.dataset.alev)};
  const dge=[...document.querySelectorAll('[data-aldg]')].filter(x=>x.checked).map(x=>x.dataset.aldg);
  body.digest=dge.length?{events:dge,hour:Number($('#al-dg-hour').value),timeZone:$('#al-dg-tz').value.trim()}:null;
  if($('#al-format').value)body.format=$('#al-format').value;
  if($('#al-url').value.trim())body.webhookUrl=$('#al-url').value.trim();
  if(!$('#al-emails-wrap').hidden)body.emails=$('#al-emails').value.split(/[\s,;]+/).filter(Boolean);
  const r=await api('/api/alerts',{method:'PUT',body:JSON.stringify(body)});
  $('#al-url').value='';
  $('#alerts-msg').textContent=r.ok?'Saved.':errText(r);
  loadAlerts();loadRevocation();
});
$('#al-test').addEventListener('click',async()=>{
  const r=await post('/api/alerts/test',{});
  $('#alerts-msg').textContent=r.ok?`Test: ${r.delivery}`:errText(r);
  loadAlerts();
});
$('#al-remove').addEventListener('click',async()=>{
  if(!confirm('Stop sending alerts?'))return;
  const r=await api('/api/alerts',{method:'PUT',body:JSON.stringify({webhookUrl:null})});
  $('#alerts-msg').textContent=r.ok?'Webhook removed.':errText(r);
  loadAlerts();
});
async function loadAnchors(){
  const r=await api('/api/audit/anchors?limit=1');
  const el=$('#a-anchor-state');
  if(!r.ok){el.textContent=r._status===403?'Anchors need all-site audit access.':errText(r);return;}
  const a=(r.anchors||[])[0], st=r.settings||{};
  const parts=[a?`Last anchor #${a.seq} · ${new Date(a.createdAt).toLocaleString()} · ${a.signature?'signed':'unsigned'} · ${a.deliveredTo?`${a.deliveredTo}: ${a.deliveryStatus}`:'kept in AccessX only'}`:'No anchor yet.'];
  parts.push(st.retentionDays?`Retention ${st.retentionDays} days (purged only below an anchor delivered outside AccessX).`:'Retention: keep everything.');
  if(r.checkpoint)parts.push(`Entries up to #${r.checkpoint.seq} purged by policy.`);
  if(!st.anchorWebhookHost)parts.push('Tip: send anchors to a webhook you control, so a rewrite of history can be proven.');
  el.textContent=parts.join(' ');
}
$('#a-anchor').addEventListener('click',async()=>{
  const r=await post('/api/audit/anchor',{});
  $('#a-anchor-res').textContent=!r.ok?errText(r):r.skipped?r.skipped:`Anchored #${r.anchor.seq}${r.anchor.deliveredTo?` · ${r.anchor.deliveryStatus}`:''}`;
  loadAnchors();loadAudit();
});
$('#a-export').addEventListener('click',async()=>{
  const r=await api('/api/audit/export?limit=10000');
  if(!r.ok){$('#a-anchor-res').textContent=errText(r);return;}
  delete r._status;delete r.ok;delete r.demo;
  const url=URL.createObjectURL(new Blob([JSON.stringify(r,null,1)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`accessx-audit-${r.tenant.id}-${(r.range||{}).fromSeq||0}-${(r.range||{}).toSeq||0}.json`;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  $('#a-anchor-res').textContent=`Exported ${r.entries.length} entries${r.nextFromSeq?` (more from #${r.nextFromSeq})`:''} · verify with: npm run audit:verify -- file.json`;
  loadAudit();
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
/* ---- visitors: a code per door, valid only for the visit ---- */
function nextDay(ymd){const d=new Date(ymd+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);}
const hh=h=>String(h).padStart(2,'0')+':00';
$('#p-start-h').innerHTML=Array.from({length:24},(_,h)=>`<option value="${hh(h)}"${h===8?' selected':''}>${hh(h)}</option>`).join('');
$('#p-start').addEventListener('change',()=>{refreshTzNotes();if($('#p-end').value&&$('#p-end').value<$('#p-start').value)$('#p-end').value='';});
let VIS={hosts:[],settings:null,walkinId:null};
function visDoors(){return DOORS.filter(d=>d.siteId);}
/** Doors of one site per visit: once a door is ticked, other sites' doors are disabled. */
function renderVisDoors(checked=$$('#vi-doors input:checked').map(i=>i.value)){
  const first=DOORS.find(d=>checked.includes(String(d.lockId)));
  const site=first?first.siteId:null;
  $('#vi-doors').innerHTML=visDoors().map(d=>{
    const off=d.sensitive||(site&&d.siteId!==site);
    const why=d.sensitive?' — sensitive, needs a rule + approval':(site&&d.siteId!==site?' — other site':'');
    const on=!off&&checked.includes(String(d.lockId));
    return `<label class="${off?'off':''}"><input type="checkbox" value="${esc(d.lockId)}" ${off?'disabled':''} ${on?'checked':''}> ${esc(d.lockAlias||d.lockId)} <span class="meta">${esc(d.site)}${esc(why)}</span></label>`;
  }).join('')||'<span class="meta">No doors at a site you can see.</span>';
}
function visTz(){const c=$('#vi-doors input:checked');return c?doorTz(c.value):(visDoors()[0]?doorTz(visDoors()[0].lockId):BROWSER_TZ);}
function renderVisTimes(){
  const tz=visTz(),now=tzParts(new Date(),tz);
  if(!$('#vi-date').value||$('#vi-date').value<now.date)$('#vi-date').value=now.date;
  $('#vi-date').min=now.date;
  const today=$('#vi-date').value===now.date,curH=Number(now.time.slice(0,2));
  const from=$('#vi-from').value,until=$('#vi-until').value;
  $('#vi-from').innerHTML=(today?'<option value="">Now</option>':'')+Array.from({length:24},(_,h)=>h).filter(h=>!today||h>curH).map(h=>`<option value="${hh(h)}">${hh(h)}</option>`).join('');
  if([...$('#vi-from').options].some(o=>o.value===from))$('#vi-from').value=from;
  const startH=$('#vi-from').value?Number($('#vi-from').value.slice(0,2)):curH;
  $('#vi-until').innerHTML=Array.from({length:24},(_,i)=>i+1).filter(h=>h>startH).map(h=>`<option value="${h===24?'24:00':hh(h)}">${h===24?'Midnight':hh(h)}</option>`).join('');
  const dflt=Math.min(24,Math.max(startH+1,17));
  $('#vi-until').value=[...$('#vi-until').options].some(o=>o.value===until)?until:(dflt===24?'24:00':hh(dflt));
  const c=$('#vi-doors input:checked');
  $('#vi-tz').innerHTML=c?tzNote(c.value):'';
}
async function loadVisitors(){
  const r=await api('/api/visits?range='+encodeURIComponent($('#vis-range').value));
  const nav=$('nav button[data-v="visitors"]');
  nav.hidden=!r.ok;
  if(!r.ok){$('#vis-list').innerHTML=`<div class="meta">${esc(errText(r))}</div>`;return;}
  VIS.settings=r.settings;
  if(!VIS.hosts.length){const h=await api('/api/visits/hosts');VIS.hosts=h.hosts||[];
    $('#vi-host').innerHTML='<option value="">Choose…</option>'+VIS.hosts.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');}
  if(!$('#vi-doors').children.length)renderVisDoors();
  renderVisTimes();
  $('#vi-send').disabled=!r.settings.emailAvailable;
  $('#vi-send-l').classList.toggle('off',!r.settings.emailAvailable);
  $('#vi-send-l').title=r.settings.emailAvailable?'':'Email is not configured on this server';
  $('#vi-sms').disabled=!r.settings.smsAvailable;
  $('#vi-sms-l').classList.toggle('off',!r.settings.smsAvailable);
  $('#vi-sms-l').title=r.settings.smsAvailable?'':'SMS is not configured on this server';
  const s=await api('/api/visits/settings');
  // Owner-only (also enforced by the server).
  $('#vis-settings').hidden=!(s.ok&&ME&&ME.role==='r_owner');
  if(s.ok){$('#vs-max').value=s.maxHours;$('#vs-ret').value=s.retentionDays;$('#vs-notify').checked=s.notifyHost;if(document.activeElement!==$('#vs-notice'))$('#vs-notice').value=s.notice||'';
    const a=s.arrivals||{};
    $('#vs-arrivals').textContent=!a.enabled?'Arrival detection is off: SECRETS_KEY is not set on the server.'
      :a.callback?'Arrivals: reported by TTLock within seconds (record callback), doors with a gateway.'
      :'Arrivals: checked every scheduled run (about 15 min) on doors with a gateway. Set TTLOCK_NOTIFY_SECRET and the TTLock callback URL for instant notice.';
    if(a.callback)$('#vs-arrivals').textContent+=a.lastCallbackAt?` Last message from TTLock: ${new Date(a.lastCallbackAt).toLocaleString()}.`:' No message from TTLock yet: check the callback URL in the TTLock developer console.';
    $('#vs-arrivals').textContent+=s.checkoutLinks?' Visitors get a self check-out link with their code.':' Set PUBLIC_URL to send visitors a self check-out link.';
    $('#vs-sms').hidden=!s.smsAvailable;
    if(s.smsUsage)$('#vs-sms-usage').textContent=`Text messages this month (${s.smsUsage.period}): ${s.smsUsage.sent}${s.smsUsage.cap?` of ${s.smsUsage.cap}`:''} · ${s.smsUsage.segments} billed segment${s.smsUsage.segments===1?'':'s'}`;}
  loadInvites();loadWalkins();loadKiosks();loadCalendar();
  const DELIVERY={emailed:'code emailed',email_failed:'email failed',texted:'code texted',sms_failed:'text failed'};
  const stateTag={scheduled:'<span class="tag">scheduled</span>',active:'<span class="tag g">visit window</span>',ended:'<span class="tag">ended</span>',checked_out:'<span class="tag">checked out</span>',cancelled:'<span class="tag">cancelled</span>'};
  const codeTag=c=>c.status==='active'?'<span class="tag g">active</span>':c.status==='pending_removal'?'<span class="tag o">remove at lock</span>':`<span class="tag">${esc(c.status)}</span>`;
  const rows=r.visits.map(v=>{
    const lock=v.lockIds[0];
    const open=v.status==='scheduled'&&v.state!=='ended';
    const who=v.erased?'<span class="meta">details erased</span>':`<b>${esc(v.visitorName)}</b><div class="meta">${esc([v.company,v.visitorEmail,v.visitorPhone].filter(Boolean).join(' · '))}</div>`;
    const doors=v.codes.map(c=>{const d=DOORS.find(x=>Number(x.lockId)===Number(c.lockId));return `<div>${esc(d?d.lockAlias:c.lockId)} ${codeTag(c)}</div>`;}).join('');
    return `<tr><td>${who}</td><td>${esc(v.hostName||v.hostUserId)}</td><td>${doors}</td>
      <td>${esc(atDoor(v.startAt,lock))}<div class="meta">→ ${esc(atDoor(v.endAt,lock))}</div></td><td>${stateTag[v.state]||esc(v.state)}${v.arrivedAt?`<div class="meta">arrived ${esc(atDoor(v.arrivedAt,v.arrivedLock||lock))}${(()=>{const d=DOORS.find(x=>Number(x.lockId)===Number(v.arrivedLock));return d?' · '+esc(d.lockAlias):'';})()}</div>`:''}${v.checkedInAt?`<div class="meta">signed in ${esc(atDoor(v.checkedInAt,lock))}${v.noticeAccepted?' · notice accepted':''}</div>`:''}${v.delivery&&v.delivery!=='shown'?`<div class="meta">${esc(v.delivery.split('+').map(d=>DELIVERY[d]||d).join(' · '))}</div>`:''}</td>
      <td style="white-space:nowrap">${open?`<button class="btn2 sm" data-vact="${v.state==='scheduled'?'cancel':'checkout'}" data-vid="${esc(v.id)}">${v.state==='scheduled'?'Cancel':'Check out'}</button> `:''}${v.erased?'':`<button class="btn2 sm" data-vact="erase" data-vid="${esc(v.id)}" title="Erase this visitor's personal details now">Erase details</button>`}</td></tr>`;
  }).join('');
  $('#vis-list').innerHTML=rows?`<table><tr><th>Visitor</th><th>Host</th><th>Doors</th><th>When (door time)</th><th>State</th><th></th></tr>${rows}</table>`:'<div class="meta">No visitors in this period.</div>';
}
const INV_TAG={open:'<span class="tag">waiting for visitor</span>',submitted:'<span class="tag o">needs approval</span>',used:'<span class="tag g">registered</span>',revoked:'<span class="tag">revoked</span>',expired:'<span class="tag">expired</span>',rejected:'<span class="tag">rejected</span>'};
async function loadInvites(){
  const r=await api('/api/visit-invites');
  $('#inv-card').hidden=!(r.ok&&r.invites.length);
  $('#vi-invite-l').hidden=!(r.ok&&r.available&&r.available.links);
  if(!r.ok)return;
  $('#inv-list').innerHTML=`<table><tr><th>Visitor</th><th>Sends to</th><th>Host</th><th>Doors</th><th>Window (door time)</th><th>State</th><th></th></tr>${r.invites.map(i=>{
    const lock=i.lockIds[0];
    const who=i.erased?'<span class="meta">details erased</span>':i.submittedName?`<b>${esc(i.submittedName)}</b><div class="meta">${esc(i.submittedCompany||'')}</div>`:'<span class="meta">—</span>';
    const doors=i.lockIds.map(l=>{const d=DOORS.find(x=>Number(x.lockId)===Number(l));return esc(d?d.lockAlias:l);}).join(', ');
    const acts=(i.status==='submitted'?`<button class="btn sm" data-iact="approve" data-iid="${esc(i.id)}">Approve</button> <button class="btn2 sm" data-iact="reject" data-iid="${esc(i.id)}">Reject</button> `:'')
      +(['open','submitted'].includes(i.status)?`<button class="btn2 sm" data-iact="revoke" data-iid="${esc(i.id)}">Revoke</button>`:'');
    return `<tr><td>${who}</td><td>${esc(i.contact||'')}</td><td>${esc(i.hostName||i.hostUserId)}</td><td>${doors}</td><td>${esc(atDoor(i.startAt,lock))}<div class="meta">→ ${esc(atDoor(i.endAt,lock))}${i.submittedStart?' · arriving '+esc(i.submittedStart.slice(11)):''}</div></td><td>${INV_TAG[i.status]||esc(i.status)}${i.requireApproval&&i.status==='open'?'<div class="meta">approval required</div>':''}</td><td style="white-space:nowrap">${acts}</td></tr>`;
  }).join('')}</table>`;
}
$('#inv-list').addEventListener('click',async e=>{
  const b=e.target.closest('button[data-iact]');if(!b)return;
  const act=b.dataset.iact;
  const q={approve:'Approve this registration? The code is sent to the invited address.',reject:'Reject this registration? The visitor gets no code.',revoke:'Revoke this invitation? The link stops working.'}[act];
  if(!confirm(q))return;
  b.disabled=true;
  const r=await post(`/api/visit-invites/${encodeURIComponent(b.dataset.iid)}/${act}`,{});
  if(!r.ok)alert(errText(r));
  loadVisitors();loadAudit();
});
function renderInviteMode(){
  const on=$('#vi-invite').checked;
  $('#vi-name').required=!on;
  $('#vi-name').closest('div').hidden=on;$('#vi-company').closest('div').hidden=on;
  $('#vi-direct').hidden=on;$('#vi-invite-note').hidden=!on;$('#vi-bulk-w').hidden=!on;
  $('#vi-submit').textContent=on?'Send invitation':'Register & create code';
}
$('#vi-invite').addEventListener('change',renderInviteMode);
$('#vi-doors').addEventListener('change',()=>{renderVisDoors();renderVisTimes();});
$('#vi-date').addEventListener('change',renderVisTimes);
$('#vi-from').addEventListener('change',renderVisTimes);
$('#vis-range').addEventListener('change',loadVisitors);
$('#vi-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const lockIds=$$('#vi-doors input:checked').map(i=>Number(i.value));
  const out=$('#vi-res');
  if(!lockIds.length){out.innerHTML='<div class="res n">Choose at least one door.</div>';return;}
  const date=$('#vi-date').value,from=$('#vi-from').value,until=$('#vi-until').value;
  const body={visitorName:$('#vi-name').value,visitorEmail:$('#vi-email').value,visitorPhone:$('#vi-phone').value,sendSms:$('#vi-sms').checked&&!$('#vi-sms').disabled,company:$('#vi-company').value,hostUserId:$('#vi-host').value,lockIds,
    endLocal:until==='24:00'?nextDay(date)+'T00:00':`${date}T${until}`,sendCode:$('#vi-send').checked&&!$('#vi-send').disabled};
  if(from)body.startLocal=`${date}T${from}`;
  const bulk=$('#vi-invite').checked?[...new Set($('#vi-bulk').value.split(/[\s,;]+/).map(x=>x.trim()).filter(Boolean))]:[];
  if(bulk.length){
    const bb={rows:bulk.map(email=>({email})),hostUserId:body.hostUserId,lockIds,endLocal:body.endLocal,
      startLocal:body.startLocal||`${date}T${tzParts(new Date(),visTz()).time.slice(0,2)}:00`};
    if(!confirm(`Send ${bulk.length} invitation(s)? Each address gets its own link.`))return;
    $('#vi-submit').disabled=true;
    const r=await post('/api/visit-invites/bulk',bb);
    $('#vi-submit').disabled=false;
    if(!r.ok){out.innerHTML=`<div class="res n">${esc(errText(r))} — nothing was sent.</div>`;return;}
    const bad=r.results.filter(x=>!x.ok);
    out.innerHTML=`<div class="res ${bad.length?'n':'y'}"><b>${r.sent} invitation(s) ${r.results.some(x=>x.ok&&x.delivery==='delivered')?'sent':'created'}</b>${bad.length?`, ${bad.length} not sent:`:''}
      ${bad.map(x=>`<div class="meta" style="margin-top:4px">${esc(x.email||'(empty)')}: ${esc(x.error)}</div>`).join('')}</div>`;
    $('#vi-bulk').value=bad.map(x=>x.email).filter(Boolean).join('\n');
    loadVisitors();loadAudit();return;
  }
  if($('#vi-invite').checked){
    const ib={visitorEmail:$('#vi-email').value||undefined,visitorPhone:$('#vi-phone').value||undefined,hostUserId:body.hostUserId,lockIds,endLocal:body.endLocal,
      startLocal:body.startLocal||`${date}T${tzParts(new Date(),visTz()).time.slice(0,2)}:00`};
    $('#vi-submit').disabled=true;
    const r=await post('/api/visit-invites',ib);
    $('#vi-submit').disabled=false;
    if(!r.ok){out.innerHTML=`<div class="res n">${esc(errText(r))}</div>`;return;}
    const i=r.invite;
    out.innerHTML=`<div class="res y"><b>Invitation ${r.delivery==='delivered'?'sent to '+esc(i.contact):'created'}</b>${i.requireApproval?' — you approve the registration before the code goes out':''}
      <div class="meta" style="margin-top:6px">Link (works once${r.delivery==='delivered'?', already sent':' — send it yourself'}): <span style="word-break:break-all">${esc(r.inviteUrl)}</span></div>
      ${(r.warnings||[]).map(w=>`<div class="meta" style="margin-top:4px">⚠ ${esc(w)}</div>`).join('')}</div>`;
    $('#vi-email').value='';$('#vi-phone').value='';
    loadVisitors();loadAudit();return;
  }
  if(VIS.walkinId)body.walkinId=VIS.walkinId;
  $('#vi-submit').disabled=true;
  const r=await post('/api/visits',body);
  $('#vi-submit').disabled=false;
  if(r.ok)VIS.walkinId=null;
  if(!r.ok){out.innerHTML=`<div class="res n">${esc(errText(r))}</div>`;return;}
  const v=r.visit,lock=v.lockIds[0];
  const co=r.checkoutUrl?`<div class="meta" style="margin-top:6px">Self check-out link${/emailed|texted/.test(r.delivery)?' (sent to the visitor)':' — give it to the visitor'}: <span style="word-break:break-all">${esc(r.checkoutUrl)}</span></div>`:'';
  out.innerHTML=`<div class="res y"><b>${esc(v.visitorName)}</b> — ${/emailed|texted/.test(r.delivery)?'code sent to the visitor ('+esc(r.delivery.split('+').filter(d=>d==='emailed'||d==='texted').join(' and '))+')':'give the visitor '+(r.codes.length>1?'these codes':'this code')}
    ${r.codes.map(c=>`<div style="margin-top:8px"><span class="meta">${esc(c.door)}</span><div class="code">${esc(c.code)}</div></div>`).join('')}
    <div class="meta" style="margin-top:6px">Shown once — the system keeps only the last two digits.</div>${co}
    <div style="margin-top:6px">${esc(atDoor(v.startAt,lock))} → ${esc(atDoor(v.endAt,lock))} <span class="meta">(door time)</span> · <span class="tag g">lock-enforced</span></div>
    ${(r.warnings||[]).map(w=>`<div class="meta" style="margin-top:4px">⚠ ${esc(w)}</div>`).join('')}</div>`;
  $('#vi-name').value='';$('#vi-email').value='';$('#vi-phone').value='';$('#vi-company').value='';
  loadVisitors();loadAudit();
});
$('#vis-list').addEventListener('click',async e=>{
  const b=e.target.closest('button[data-vact]');if(!b)return;
  const act=b.dataset.vact,id=b.dataset.vid;
  const q={cancel:'Cancel this visit? Its codes stop working now where the door has a gateway.',checkout:'Check this visitor out? Their codes stop working now where the door has a gateway.',erase:"Erase this visitor's name, email, mobile and company now? The visit record (host, doors, times) stays."}[act];
  if(!confirm(q))return;
  b.disabled=true;
  const r=await post(`/api/visits/${encodeURIComponent(id)}/${act}`,{});
  if(!r.ok)alert(errText(r));
  else if((r.warnings||[]).length)alert(r.warnings.join('\n'));
  loadVisitors();loadCreds();loadAudit();
});
$('#vs-sms-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const r=await post('/api/visits/sms-test',{to:$('#vs-sms-to').value});
  $('#vs-msg').textContent=r.ok?(r.delivery==='delivered'?'Test text sent.':`Test text not sent: ${r.delivery}`):errText(r);
  loadVisitors();
});
$('#vs-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const r=await api('/api/visits/settings',{method:'PUT',body:JSON.stringify({maxHours:Number($('#vs-max').value),retentionDays:Number($('#vs-ret').value),notifyHost:$('#vs-notify').checked,notice:$('#vs-notice').value})});
  $('#vs-msg').textContent=r.ok?`Saved: visits up to ${r.maxHours} h, details kept ${r.retentionDays} days after the visit.`:errText(r);
});
// --- Front-desk kiosk (R16) ---
async function loadWalkins(){
  const r=await api('/api/walkins');
  if(!r.ok)return; // a failed poll changes nothing (otherwise every waiting walk-in would look new next time)
  const list=r.walkins||[];
  $('#walk-card').hidden=!list.length;
  // New since the last look: highlight them, and count them in a background tab's title.
  const seen=VIS.walkinsSeen;VIS.walkinsSeen=new Set(list.map(w=>w.id));
  const fresh=seen?list.filter(w=>!seen.has(w.id)).map(w=>w.id):[];
  if(fresh.length&&document.visibilityState!=='visible'){VIS.walkinsUnseen=(VIS.walkinsUnseen||0)+fresh.length;document.title=`(${VIS.walkinsUnseen}) walk-in · ${BASE_TITLE}`;}
  if(!list.length)return;
  $('#walk-list').innerHTML=`<table><tr><th>Visitor</th><th>Asked for</th><th>Signed in</th><th></th></tr>${list.map(w=>`<tr>
    <td><b>${esc(w.name)}</b>${fresh.includes(w.id)?' <span class="tag o">new</span>':''}<div class="meta">${esc([w.company,w.email].filter(Boolean).join(' · '))}</div></td>
    <td>${w.hostName?esc(w.hostName)+(w.hostNotified==='delivered'?' <span class="tag g">told by email</span>':''):'<span class="meta">not matched: ask the visitor</span>'}</td>
    <td>${esc(new Date(w.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))}<div class="meta">${esc(w.siteName||'')}${w.noticeAccepted?' · notice accepted':''}</div></td>
    <td style="white-space:nowrap"><button class="btn sm" data-wact="issue" data-wid="${esc(w.id)}">Issue code</button> <button class="btn2 sm" data-wact="dismiss" data-wid="${esc(w.id)}">Dismiss</button></td></tr>`).join('')}</table>`;
  VIS.walkins=list;
}
$('#walk-list').addEventListener('click',async e=>{
  const b=e.target.closest('button[data-wact]');if(!b)return;
  const w=(VIS.walkins||[]).find(x=>x.id===b.dataset.wid);if(!w)return;
  if(b.dataset.wact==='dismiss'){
    if(!confirm(`Dismiss ${w.name}? They get no code.`))return;
    b.disabled=true;
    const r=await post(`/api/walkins/${encodeURIComponent(w.id)}/dismiss`,{});
    if(!r.ok)alert(errText(r));
    loadWalkins();loadAudit();return;
  }
  // Fill the register form; the server links the visit to the walk-in.
  VIS.walkinId=w.id;
  $('#vi-invite').checked=false;renderInviteMode();
  $('#vi-name').value=w.name||'';$('#vi-company').value=w.company||'';$('#vi-email').value=w.email||'';
  if(w.hostUserId&&[...$('#vi-host').options].some(o=>o.value===w.hostUserId))$('#vi-host').value=w.hostUserId;
  $('#vi-res').innerHTML=`<div class="res y">Issuing a code for walk-in <b>${esc(w.name)}</b>${w.siteName?' at '+esc(w.siteName):''}: choose the doors and the end time, then <b>Register &amp; create code</b>. <button class="btn2 sm" type="button" id="walk-cancel">Not now</button></div>`;
  $('#walk-cancel').addEventListener('click',()=>{VIS.walkinId=null;$('#vi-res').innerHTML='';});
  $('#vi-form').scrollIntoView({behavior:'smooth',block:'start'});
});
async function loadKiosks(){
  const r=await api('/api/kiosks');
  $('#kiosk-card').hidden=!r.ok;
  if(!r.ok)return;
  if(!$('#kiosk-site').options.length)$('#kiosk-site').innerHTML=r.sites.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  const act=r.kiosks.filter(k=>!k.revokedAt);
  $('#kiosk-list').innerHTML=act.length?`<table><tr><th>Kiosk</th><th>Site</th><th>Last seen</th><th></th></tr>${act.map(k=>`<tr><td><b>${esc(k.name)}</b></td><td>${esc(k.siteName||k.siteId)}</td>
    <td>${k.lastSeenAt?esc(new Date(k.lastSeenAt).toLocaleString()):'<span class="meta">not opened yet</span>'}</td>
    <td><button class="btn2 sm" data-kact="revoke" data-kid="${esc(k.id)}">Switch off</button></td></tr>`).join('')}</table>`:'<div class="meta">No kiosks yet.</div>';
}
$('#kiosk-list').addEventListener('click',async e=>{
  const b=e.target.closest('button[data-kact]');if(!b)return;
  if(!confirm('Switch off this kiosk? The tablet stops working at once, and codes shown on it for phones stop working too.'))return;
  b.disabled=true;
  const r=await post(`/api/kiosks/${encodeURIComponent(b.dataset.kid)}/revoke`,{});
  if(!r.ok)alert(errText(r));
  loadKiosks();loadAudit();
});
$('#kiosk-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const r=await post('/api/kiosks',{siteId:$('#kiosk-site').value,name:$('#kiosk-name').value});
  if(!r.ok){$('#kiosk-res').innerHTML=`<div class="res n">${esc(errText(r))}</div>`;return;}
  const url=r.pairUrl.startsWith('/')?location.origin+r.pairUrl:r.pairUrl;
  let qr='';try{qr=window.AccessQR.svg(url,{size:200});}catch{qr='';}
  $('#kiosk-res').innerHTML=`<div class="res y"><b>${esc(r.kiosk.name)}</b> is ready. On the reception tablet, scan this code with the camera or open the link. <b>Shown once</b>: anyone with the link can use this kiosk until you switch it off.
    <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:8px"><div>${qr}</div><div class="meta" style="word-break:break-all;max-width:420px">${esc(url)}</div></div>
    <button class="btn2 sm" type="button" id="kiosk-hide" style="margin-top:8px">Done: hide the link</button></div>`;
  $('#kiosk-hide').addEventListener('click',()=>{$('#kiosk-res').innerHTML='';});
  $('#kiosk-name').value='';
  loadKiosks();loadAudit();
});
// --- R17: calendar invitations (docs/23-CALENDAR.md) ---
const CAL_STATUS={pending:['waiting for the host','o'],confirmed:['invitations sent','g'],declined:['host said not needed',''],cancelled:['meeting cancelled',''],superseded:['replaced by a newer version',''],expired:['not confirmed in time',''],unusable:['not used','r']};
async function loadCalendar(){
  const r=await api('/api/calendar');
  $('#cal-card').hidden=!r.ok;
  if(!r.ok)return;
  const owner=ME&&ME.role==='r_owner';
  if(!r.available){$('#cal-state').innerHTML=`<div class="meta">Not available on this server: set ${esc(r.missing.join(', '))} (see docs/23-CALENDAR.md).</div>`;$('#cal-form').hidden=true;}
  else{
    $('#cal-state').innerHTML=r.inbox?`<div class="res ${r.inbox.enabled?'y':'n'}">Calendar address: <b id="cal-addr">${esc(r.inbox.address)}</b> <button class="btn2 sm" type="button" id="cal-copy">Copy</button>${r.inbox.enabled?'':' · <b>switched off</b>'}</div>`
      :`<div class="meta">${owner?'Choose the visitor doors for each office, then save to get the address.':'An owner can switch this on.'}</div>`;
    const copy=$('#cal-copy');if(copy)copy.onclick=()=>navigator.clipboard&&navigator.clipboard.writeText(r.inbox.address).then(()=>{copy.textContent='Copied';});
    $('#cal-form').hidden=!owner;
    $('#cal-rotate').hidden=!r.inbox;
    if(owner&&!$('#cal-form').contains(document.activeElement)){
      const chosen=Object.fromEntries(((r.inbox&&r.inbox.doorSets)||[]).map(d=>[d.siteId,d.lockIds.map(String)]));
      $('#cal-on').checked=!r.inbox||r.inbox.enabled;
      $('#cal-sets').innerHTML=r.sites.map(s=>{
        const doors=visDoors().filter(d=>d.siteId===s.id);
        return `<div style="margin-top:6px"><b>${esc(s.name)}</b><div class="checks">${doors.map(d=>`<label class="${d.sensitive?'off':''}"><input type="checkbox" data-cal-site="${esc(s.id)}" value="${esc(d.lockId)}" ${d.sensitive?'disabled':''} ${!d.sensitive&&(chosen[s.id]||[]).includes(String(d.lockId))?'checked':''}> ${esc(d.lockAlias||d.lockId)}${d.sensitive?' <span class="meta">sensitive</span>':''}</label>`).join('')||'<span class="meta">no doors</span>'}</div></div>`;
      }).join('');
    }
  }
  $('#cal-drafts').innerHTML=r.drafts.length?`<table><tr><th>Received</th><th>Meeting</th><th>Host</th><th>Guests</th><th>State</th></tr>${r.drafts.map(d=>{const st=CAL_STATUS[d.status]||[d.status,''];return `<tr>
    <td>${esc(new Date(d.createdAt).toLocaleString([], {dateStyle:'short',timeStyle:'short'}))}</td>
    <td>${d.startAt?`<b>${esc(d.summary||'untitled')}</b><div class="meta">${esc(new Date(d.startAt).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}))}${d.recurring?' · recurring (first only)':''}${d.tzAssumed?' · time zone assumed':''}</div>`:'<span class="meta">—</span>'}</td>
    <td>${esc(d.hostName||'—')}</td>
    <td>${d.erased?'<span class="meta">erased</span>':esc(d.guests.map(g=>g.name||g.email).join(', ')||'—')}</td>
    <td><span class="tag ${st[1]}">${esc(st[0])}</span>${d.reason?`<div class="meta">${esc(d.reason)}</div>`:''}${d.status==='pending'&&d.hostNotified&&d.hostNotified!=='delivered'?'<div class="meta">host email not sent</div>':''}</td></tr>`;}).join('')}</table>`:'<div class="meta">No invitations received yet.</div>';
}
$('#cal-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const sets={};
  $$('#cal-sets input[data-cal-site]:checked').forEach(i=>{(sets[i.dataset.calSite]||=[]).push(Number(i.value));});
  const body={enabled:$('#cal-on').checked,doorSets:Object.entries(sets).map(([siteId,lockIds])=>({siteId,lockIds}))};
  const r=await api('/api/calendar',{method:'PUT',body:JSON.stringify(body)});
  $('#cal-res').innerHTML=r.ok?'<div class="res y">Saved. Invitations use your approval: if you stop being an owner, an owner needs to save this again.</div>':`<div class="res n">${esc(errText(r))}</div>`;
  loadCalendar();loadAudit();
});
$('#cal-rotate').addEventListener('click',async()=>{
  if(!confirm('Make a new calendar address? The old one stops working at once: hosts must use the new one.'))return;
  const r=await post('/api/calendar/rotate',{});
  if(!r.ok)alert(errText(r));
  loadCalendar();loadAudit();
});
// Reception: new walk-ins appear without a reload (every 20 s while the Visitors page is open);
// a background tab shows the count in its title.
const BASE_TITLE=document.title;
setInterval(()=>{if(document.visibilityState==='visible'||VIS.walkinsSeen){if($('#v-visitors').classList.contains('on'))loadWalkins().catch(e=>console.warn('walk-in refresh failed',e));}},20000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){document.title=BASE_TITLE;VIS.walkinsUnseen=0;}});
init();
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
