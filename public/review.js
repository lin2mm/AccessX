'use strict';
// R18: access review (People), passcode sweep and data retention (Activity).
// Shares app.js helpers ($, $$, esc, api, post, errText). No inline handlers (CSP).

const day10=t=>t?String(t).slice(0,10):'—';
const putJson=(u,data)=>api(u,{method:'PUT',body:JSON.stringify(data||{})});
const ageText=t=>{if(!t)return 'never';const d=Math.floor((Date.now()-Date.parse(t))/864e5);return d<1?'today':d===1?'yesterday':`${d} days ago`;};

// ---- access review ------------------------------------------------------------
let REVIEW=null;
async function loadReview(){
  const box=$('#rv');if(!box)return;
  const r=await api('/api/access-reviews');
  if(!r.ok){$('#rv-card').hidden=r._status===403;box.innerHTML=`<div class="empty">${esc(errText(r))}</div>`;return;}
  $('#rv-card').hidden=false;REVIEW=r;
  const s=r.settings||{};
  const every={0:'off',30:'every month',90:'every quarter',180:'every 6 months',365:'every year'};
  let html='';
  if(r.open){
    const o=r.open,sm=o.summary;
    html+=`<div class="res ${o.overdue?'n':'y'}" style="margin-bottom:10px"><b>Review open</b> — started ${esc(day10(o.startedAt))}, due ${esc(day10(o.dueAt))}${o.overdue?' · <b>overdue</b>':''}
      <div class="meta" style="margin-top:4px">${sm.total} line(s) you can see: ${sm.kept} kept, ${sm.removed} removed, <b>${sm.undecided} waiting</b>. Removing takes effect at once — the person leaves this site's groups and their codes there are deleted.</div></div>`;
    const lines=o.items||[];
    const row=i=>{
      const who=`<b translate="no">${esc(i.name)}</b>${i.email?`<div class="meta">${esc(i.email)}</div>`:''}`;
      const what=i.kind==='door'
        ?`<span class="tag">${esc(i.siteName||i.siteId)}</span> ${i.directory?'<span class="tag" title="Group membership comes from your directory (SCIM)">directory</span>':''}<div class="meta">${esc((i.doors||[]).join(', ')||'no doors')}${i.codes?` · ${i.codes} code(s)`:''}</div><div class="meta">via ${esc((i.groups||[]).join(', ')||'—')}</div>`
        :`<span class="tag o">administrator</span> ${esc(i.role)}${i.breakGlass?' <span class="tag r">break-glass</span>':''}<div class="meta">sites: ${esc((i.sites||[]).join(', '))} · last sign-in ${esc(ageText(i.lastLoginAt))}</div>`;
      const dec=i.decision==='remove'?`<span class="tag r">removed</span><div class="meta">${esc(i.outcome||'')}</div>`
        :i.decision==='keep'?`<span class="tag g">kept</span>`:'<span class="meta">waiting</span>';
      const by=i.decidedBy?`<div class="meta">${esc(i.decidedBy)} · ${esc(day10(i.decidedAt))}${i.note?` · ${esc(i.note)}`:''}</div>`:'';
      const act=i.canDecide?`${i.decision==='keep'?'':`<button class="btn2 sm" type="button" data-rv="keep" data-item="${esc(i.id)}">Keep</button> `}<button class="btn2 sm" type="button" data-rv="remove" data-item="${esc(i.id)}">Remove</button>`
        :(!i.decision?'<span class="meta" title="Your own line, or not yours to decide">—</span>':'');
      return `<tr><td>${who}</td><td>${what}</td><td>${dec}${by}</td><td style="white-space:nowrap">${act}</td></tr>`;
    };
    html+=`<label class="checks" style="margin-bottom:6px"><input type="checkbox" id="rv-waiting"${$('#rv-waiting')&&!$('#rv-waiting').checked?'':' checked'}> Only lines still waiting</label>
      <div style="overflow-x:auto"><table id="rv-lines"><tr><th>Who</th><th>Access</th><th>Decision</th><th></th></tr>${lines.map(row).join('')||'<tr><td class="empty" colspan="4">Nothing for you to review.</td></tr>'}</table></div>`;
    if(r.canManage){
      html+=`<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">
        ${o.overdue?'<label class="checks"><input type="checkbox" id="rv-remove-undecided"> Remove door access nobody confirmed</label>':''}
        <button class="btn2 sm" type="button" id="rv-close">Close review</button><span class="meta" id="rv-close-res"></span></div>`;
    }
  }else if(r.canManage){
    html+=`<div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
      <div><label for="rv-due">Due in (days)</label><input id="rv-due" type="number" min="3" max="60" value="${esc(s.dueDays||14)}" style="width:90px"></div>
      <button class="btn" type="button" id="rv-start">Start a review now</button><span class="meta" id="rv-start-res"></span></div>`;
  }else html+='<div class="empty">No review is open.</div>';
  if(r.canManage){
    html+=`<details style="margin-top:12px"><summary>Schedule</summary><div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-top:8px">
      <div><label for="rv-every">Start a review automatically</label><select id="rv-every">${[0,30,90,180,365].map(d=>`<option value="${d}"${Number(s.everyDays)===d?' selected':''}>${every[d]}</option>`).join('')}</select></div>
      <div><label for="rv-due-set">Reviewers get (days)</label><input id="rv-due-set" type="number" min="3" max="60" value="${esc(s.dueDays||14)}" style="width:90px"></div>
      <button class="btn2 sm" type="button" id="rv-save">Save</button><span class="meta" id="rv-save-res"></span></div>
      <div class="meta" style="margin-top:6px">Reviewers with an email address are told when a review starts and reminded once before the due date; owners are told once if it is overdue.</div></details>`;
  }
  if((r.history||[]).length){
    html+=`<details style="margin-top:12px"><summary>Past reviews (${r.history.length})</summary><table style="margin-top:6px"><tr><th>Started</th><th>Closed</th><th>Kept</th><th>Removed</th><th>Not confirmed</th></tr>`+
      r.history.map(h=>`<tr><td>${esc(day10(h.startedAt))}</td><td>${esc(day10(h.closedAt))}${h.closedAt&&h.dueAt&&h.closedAt>h.dueAt?' <span class="tag o">late</span>':''}</td><td>${h.summary.kept}</td><td>${h.summary.removed}</td><td>${h.summary.undecided}</td></tr>`).join('')+'</table></details>';
  }
  box.innerHTML=html;
  filterReview();
}
function filterReview(){
  const only=$('#rv-waiting')&&$('#rv-waiting').checked;
  if(!REVIEW||!REVIEW.open)return;
  const rows=$$('#rv-lines tr').slice(1);
  REVIEW.open.items.forEach((i,n)=>{if(rows[n])rows[n].hidden=Boolean(only&&i.decision);});
}
if($('#rv'))$('#rv').addEventListener('change',e=>{if(e.target.id==='rv-waiting')filterReview();});
if($('#rv'))$('#rv').addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.rv){
    const item=REVIEW.open.items.find(i=>i.id===b.dataset.item);if(!item)return;
    let note;
    if(b.dataset.rv==='remove'){
      const what=item.kind==='door'?`${item.name}'s access at ${item.siteName||item.siteId} (groups there, and their codes on those doors)`:`${item.name}'s administrator access (their sessions end)`;
      note=prompt(`Remove ${what} now? This cannot be undone from the review.\n\nReason (optional):`,'');
      if(note===null)return;
    }
    b.disabled=true;
    const r=await post(`/api/access-reviews/${encodeURIComponent(REVIEW.open.id)}/items/${encodeURIComponent(item.id)}`,{decision:b.dataset.rv,note:note||undefined});
    if(!r.ok){b.disabled=false;alert(errText(r));return;}
    if(r.item&&r.item.outcome&&/STILL|directory/.test(r.item.outcome))alert(r.item.outcome);
    await loadReview();if(b.dataset.rv==='remove'){loadPeople();loadCreds();}
    loadAudit();return;
  }
  if(b.id==='rv-start'){
    if(!confirm('Start an access review? Every person with door access and every administrator becomes a line for their site managers to confirm.'))return;
    b.disabled=true;const r=await post('/api/access-reviews',{dueDays:Number($('#rv-due').value)});b.disabled=false;
    if(!r.ok){$('#rv-start-res').textContent=errText(r);return;}
    await loadReview();loadAudit();return;
  }
  if(b.id==='rv-close'){
    const rm=$('#rv-remove-undecided')&&$('#rv-remove-undecided').checked;
    if(!confirm(rm?'Remove door access for every line nobody confirmed, then close the review?':'Close the review? Lines still waiting stay as they are, recorded as not confirmed.'))return;
    b.disabled=true;
    let r;
    do{r=await post(`/api/access-reviews/${encodeURIComponent(REVIEW.open.id)}/close`,{removeUndecided:rm});
      if(r.ok&&!r.closed)$('#rv-close-res').textContent=`removed ${r.removed}, ${r.remaining} to go…`;}
    while(r.ok&&r.closed===false);
    b.disabled=false;
    if(!r.ok){$('#rv-close-res').textContent=errText(r);return;}
    await loadReview();loadPeople();loadCreds();loadAudit();return;
  }
  if(b.id==='rv-save'){
    const r=await putJson('/api/access-reviews/settings',{everyDays:Number($('#rv-every').value),dueDays:Number($('#rv-due-set').value)});
    $('#rv-save-res').textContent=r.ok?'Saved':errText(r);if(r.ok)loadAudit();
  }
});

// ---- passcode sweep --------------------------------------------------------------
const SWEEP_TEXT={registered:'issued by AccessX',should_be_gone:'revoked in AccessX, still on the lock',unknown:'not from AccessX',expired_unknown:'not from AccessX (expired)'};
let SWEEP=null;
async function loadSweeps(){
  const box=$('#sw-past');if(!box)return;
  const [r,s]=await Promise.all([api('/api/passcode-sweep'),api('/api/sites')]);
  if(!r.ok){$('#sw-card').hidden=r._status===403;return;}
  $('#sw-card').hidden=false;
  const sites=(s.sites||[]);
  const sel=$('#sw-site');const cur=sel.value;
  sel.innerHTML=(sites.length>1?'<option value="">All my doors</option>':'')+sites.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  if(cur)sel.value=cur;
  const name=id=>((sites.find(x=>x.id===id))||{}).name||id;
  box.innerHTML=(r.sweeps||[]).length?`<details><summary>Earlier sweeps (${r.sweeps.length})</summary><table style="margin-top:6px"><tr><th>When</th><th>Where</th><th>Doors</th><th>Not from AccessX</th><th>Should be gone</th><th>Missing</th></tr>`+
    r.sweeps.map(w=>`<tr><td>${esc(day10(w.createdAt))}</td><td>${esc(w.summary.siteId?name(w.summary.siteId):'all')}</td><td>${w.locks}</td><td>${(w.summary.unknown||0)+(w.summary.expired_unknown||0)}</td><td>${w.summary.should_be_gone||0}</td><td>${w.summary.missing||0}</td></tr>`).join('')+'</table></details>':'';
}
function renderSweep(){
  const out=$('#sw-res');const r=SWEEP;if(!r){out.innerHTML='';return;}
  const s=r.summary;
  const odd=(s.unknown||0)+(s.expired_unknown||0)+(s.should_be_gone||0)+(s.missing||0)+(s.unreadable||0);
  let html=(r.note?`<div class="res y" style="margin-bottom:8px">${esc(r.note)}</div>`:'')+`<div class="res ${odd?'n':'y'}"><b>${r.locks.length} door(s) checked</b> — ${s.registered} code(s) issued by AccessX${odd?`; <b>${(s.unknown||0)+(s.expired_unknown||0)}</b> not from AccessX, <b>${s.should_be_gone||0}</b> revoked but still on the lock, <b>${s.missing||0}</b> missing from the lock${s.unreadable?`, ${s.unreadable} door(s) unreadable`:''}`:' and nothing else'}.${r.truncated?`<div class="meta">${esc(r.truncated)}</div>`:''}</div>`;
  for(const l of r.locks){
    if(l.error){html+=`<div class="meta" style="margin-top:8px"><b translate="no">${esc(l.name)}</b>: could not read the codes — ${esc(l.error)}</div>`;continue;}
    const extra=(l.codes||[]).filter(c=>c.class!=='registered');
    if(!extra.length&&!(l.missing||[]).length)continue;
    html+=`<div style="margin-top:12px"><b translate="no">${esc(l.name)}</b>${l.hasGateway?'':' <span class="tag o" title="Codes can only be removed at the lock (TTLock app over Bluetooth)">no gateway</span>'}`;
    if(extra.length){
      html+=`<table style="margin-top:6px"><tr>${l.hasGateway?'<th></th>':''}<th>Code</th><th>What</th><th>Valid</th><th>Set by</th></tr>`+extra.map(c=>`<tr>${l.hasGateway?`<td><input type="checkbox" data-sw-lock="${esc(l.lockId)}" value="${esc(c.ref)}"${c.class==='expired_unknown'?'':' checked'}></td>`:''}
        <td>${esc(c.name||c.ref)}<div class="meta">${esc(c.type||'')}</div></td><td><span class="tag ${c.class==='should_be_gone'?'r':'o'}">${esc(SWEEP_TEXT[c.class])}</span>${c.holder?`<div class="meta">${esc(c.holder)}</div>`:''}</td>
        <td class="meta">${c.type==='permanent'?'permanent':`${esc(day10(c.startAt))} → ${esc(day10(c.endAt))}`}</td><td class="meta">${esc(c.createdBy||'—')}</td></tr>`).join('')+'</table>';
      if(l.hasGateway)html+=`<button class="btn2 sm" type="button" data-sw-remove="${esc(l.lockId)}" style="margin-top:6px">Remove ticked codes from this lock</button> <span class="meta" data-sw-res="${esc(l.lockId)}"></span>`;
    }
    if((l.missing||[]).length){
      html+=`<div class="meta" style="margin-top:6px">In AccessX but not on the lock (deleted in the TTLock app, or lost in a lock reset):</div><table>`+
        l.missing.map(m=>`<tr><td>${esc(m.holder)}</td><td class="meta">until ${esc(day10(m.endAt))}</td><td><button class="btn2 sm" type="button" data-sw-forget="${esc(m.credentialId)}">Record as gone</button></td></tr>`).join('')+'</table>';
    }
    html+='</div>';
  }
  out.innerHTML=html;
}
if($('#sw-run'))$('#sw-run').addEventListener('click',async()=>{
  const b=$('#sw-run');b.disabled=true;$('#sw-res').innerHTML='<div class="meta">Reading the codes on each lock…</div>';
  const siteId=$('#sw-site').value||undefined;
  const r=await post('/api/passcode-sweep',{siteId});b.disabled=false;
  if(!r.ok){$('#sw-res').innerHTML=`<div class="res n">${esc(errText(r))}</div>`;return;}
  SWEEP={...r,note:null};renderSweep();loadSweeps();loadAudit();
});
if($('#sw-res'))$('#sw-res').addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.swRemove){
    const lockId=Number(b.dataset.swRemove);
    const refs=$$(`#sw-res input[data-sw-lock="${lockId}"]:checked`).map(i=>i.value);
    if(!refs.length)return;
    if(!confirm(`Delete ${refs.length} code(s) from this lock through the gateway? Whoever holds them can no longer open the door.`))return;
    b.disabled=true;
    const r=await post('/api/passcode-sweep/remove',{lockId,refs});
    const res=$(`#sw-res [data-sw-res="${lockId}"]`);
    if(!r.ok){b.disabled=false;res.textContent=errText(r);return;}
    const bad=r.results.filter(x=>!x.ok);
    const lock=SWEEP.locks.find(l=>Number(l.lockId)===lockId);
    const gone=new Set(r.results.filter(x=>x.ok).map(x=>x.ref));
    lock.codes=lock.codes.filter(c=>!gone.has(c.ref));
    SWEEP.note=`${lock.name}: ${gone.size} code(s) removed from the lock${bad.length?`; not removed: ${bad.map(x=>`${x.ref} (${x.error})`).join('; ')}`:''}`;
    renderSweep();
    loadAudit();loadCreds();return;
  }
  if(b.dataset.swForget){
    if(!confirm('Record this code as gone? AccessX checks the lock once more first; the person keeps their access rule, so the next reconcile issues them a new code.'))return;
    b.disabled=true;
    const r=await post('/api/passcode-sweep/forget',{credentialIds:[b.dataset.swForget]});
    if(!r.ok){b.disabled=false;alert(errText(r));return;}
    const x=r.results[0];
    if(!x.ok){b.disabled=false;alert(x.error);return;}
    for(const l of SWEEP.locks)l.missing=(l.missing||[]).filter(m=>m.credentialId!==x.credentialId);
    SWEEP.note='Recorded as gone: the person keeps their rule, so the next reconcile issues a new code.';
    renderSweep();loadAudit();loadCreds();
  }
});

// ---- data retention -----------------------------------------------------------------
async function loadRetention(){
  const box=$('#rt');if(!box)return;
  const r=await api('/api/retention');
  if(!r.ok){$('#rt-card').hidden=true;return;}
  $('#rt-card').hidden=false;
  const audit=r.items.find(i=>i.id==='audit');
  box.innerHTML=`<table><tr><th>What</th><th>Kept</th><th>Change it</th></tr>`+r.items.map(i=>`<tr><td>${esc(i.what)}${i.note?`<div class="meta">${esc(i.note)}</div>`:''}</td><td style="white-space:nowrap">${esc(i.keep)}</td><td class="meta">${i.id==='audit'&&r.canChangeAudit?'below':esc(i.change||'fixed')}</td></tr>`).join('')+'</table>'+
    (r.canChangeAudit?`<div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-top:10px">
      <div><label for="rt-audit">Audit trail: keep (days, 365–3650, empty = everything)</label><input id="rt-audit" type="number" min="365" max="3650" value="${esc(audit.days||'')}" style="width:120px"></div>
      <button class="btn2 sm" type="button" id="rt-save">Save</button><span class="meta" id="rt-res"></span></div>`:'');
}
if($('#rt'))$('#rt').addEventListener('click',async e=>{
  if(!e.target.closest('#rt-save'))return;
  const v=$('#rt-audit').value.trim();
  const r=await putJson('/api/audit/settings',{retentionDays:v?Number(v):null});
  if(!r.ok){$('#rt-res').textContent=errText(r);return;}
  await loadRetention();loadAudit();
  if($('#rt-res'))$('#rt-res').textContent='Saved';
});

// Opening People / Activity refreshes these too.
{
  const people=VIEW_LOADERS.people,log=VIEW_LOADERS.log;
  VIEW_LOADERS.people=()=>[...people(),loadReview()];
  VIEW_LOADERS.log=()=>[...log(),loadSweeps(),loadRetention()];
}
