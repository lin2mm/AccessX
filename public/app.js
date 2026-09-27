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

$$('nav button').forEach(b=>b.onclick=()=>{
  $$('nav button').forEach(x=>x.classList.remove('on'));b.classList.add('on');
  $$('.view').forEach(v=>v.classList.remove('on'));$('#v-'+b.dataset.v).classList.add('on');
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
  const now=new Date();now.setMinutes(now.getMinutes()-now.getTimezoneOffset());
  $('#e-when').value=now.toISOString().slice(0,16);
  await loadDoors();await loadHealth();await loadPeople();await loadRules();await loadAudit();await loadCreds();await loadCompile();await loadAdmin();await loadRevocation();await loadAnchors();await loadApprovals();await loadAlerts();
  if(!$('#chat').children.length)addBubble('Copilot ready. I can explain access decisions, plan service visits, spot anomalies and draft rule changes for your approval.',false);
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
    $('#vendor-state').innerHTML=a.connected
      ?`${a.status==='connected'?'<span class="tag g">connected</span>':'<span class="tag r">reconnect required</span>'} ${esc(a.account)} · ${esc(a.region)} · ${Number(a.lockCount)||0} locks · ${a.usesPlatformApp?'platform app':'own app'} · token valid until ${esc(String(a.tokenExpiresAt).slice(0,10))}${a.lastError?' · '+esc(a.lastError):''}`
      :`Not connected — this account uses ${DOORS.length?'the demo fleet':'no locks'}.${a.secretsKeyConfigured?'':' <span class="tag o">server has no SECRETS_KEY</span>'}${a.platformAppConfigured?'':' <span class="tag o">no platform TTLock app: enter your own client ID/secret</span>'}`;
    if(a.connected){$('#v-user').value=a.account;$('#v-region').value=a.region;}
    $('#vendor-remove').hidden=!a.connected;
  }
}
$('#vendor-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const body={region:$('#v-region').value,username:$('#v-user').value.trim(),password:$('#v-pass').value};
  if($('#v-cid').value||$('#v-csec').value){body.clientId=$('#v-cid').value.trim();body.clientSecret=$('#v-csec').value;}
  $('#vendor-msg').textContent='Connecting to TTLock…';
  const r=await api('/api/vendor-account',{method:'PUT',body:JSON.stringify(body)});
  $('#v-pass').value='';$('#v-csec').value='';
  $('#vendor-msg').textContent=r.ok?`Connected: ${Number(r.account.lockCount)} locks. The password was used once and discarded.`:errText(r);
  if(r.ok){loadMode();loadDoors();loadHealth();loadAdmin();loadAudit();}
});
$('#vendor-remove').addEventListener('click',async()=>{
  if(!confirm('Disconnect the TTLock account? Doors from that account disappear from AccessX; codes already on the locks keep working until removed.'))return;
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

async function loadRules(){
  const [a,ug,dg,s]=await Promise.all([api('/api/assignments'),api('/api/userGroups'),api('/api/doorGroups'),api('/api/schedules')]);
  const n=(arr,id)=>((arr||[]).find(x=>x.id===id)||{}).name||'24/7';
  $('#rules').innerHTML=`<table><tr><th>Who</th><th>Can open</th><th>When</th></tr>`+
    (a.assignments||[]).map(r=>`<tr><td>${esc(n(ug.userGroups,r.userGroupId))}</td>
    <td>${esc(n(dg.doorGroups,r.doorGroupId))}${((dg.doorGroups||[]).find(x=>x.id===r.doorGroupId)||{}).sensitive?' <span class="tag r">sensitive · 4-eyes</span>':''}</td><td>${esc(n(s.schedules,r.scheduleId))}</td></tr>`).join('')+`</table>`;
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
  else msg.innerHTML=`Passcode (shown once): <b class="code" style="font-size:18px">${esc(r.passcode.keyboardPwd)}</b>${r.credential?` <span class="meta">door ${esc(r.credential.lockId)} · until ${esc(new Date(r.credential.endAt).toLocaleString())}</span>`:''}`;
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
  const end=$('#p-end').value;
  const body={userId:$('#p-user').value,lockId:Number($('#p-door').value),acknowledgeScheduleGap:acknowledge};
  if(end)body.endLocal=end+'T23:59'; // converted in the door's time zone on the server
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
const ALERT_LABELS={approval_requested:'Approval requests',removal_overdue:'Codes past the removal target',revoke_failed:'Failed revocations',break_glass:'Break-glass sign-ins',vendor_needs_reconnect:'TTLock account must be reconnected'};
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
  $('#al-events').innerHTML=a.availableEvents.map(e=>`<label style="display:inline-flex;gap:6px;align-items:center;margin-right:14px;font-weight:normal"><input type="checkbox" data-alev="${esc(e)}" ${a.events.includes(e)?'checked':''}>${esc(ALERT_LABELS[e]||e)}</label>`).join('');
}
$('#alerts-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const body={slaHours:Number($('#al-sla').value),events:[...document.querySelectorAll('[data-alev]')].filter(x=>x.checked).map(x=>x.dataset.alev)};
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
init();
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
