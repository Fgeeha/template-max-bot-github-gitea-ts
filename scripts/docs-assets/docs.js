(()=>{
const root=document.documentElement,store={get(k){try{return localStorage.getItem(k)}catch(e){return null}},
set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
const saved=store.get('docs-theme');if(saved)root.dataset.theme=saved;
const tb=document.getElementById('theme');
if(tb){const dark=()=>root.dataset.theme?root.dataset.theme==='dark':matchMedia('(prefers-color-scheme:dark)').matches;
const label=()=>{tb.textContent=dark()?'☀ Светлая':'☾ Тёмная'};label();
tb.onclick=()=>{root.dataset.theme=dark()?'light':'dark';store.set('docs-theme',root.dataset.theme);label()}}
const q=document.getElementById('q'),hitsEl=document.getElementById('hits');let marks=[],cur=-1;
function clearMarks(){document.querySelectorAll('article mark').forEach(m=>m.replaceWith(...m.childNodes));
document.querySelector('article').normalize();marks=[];cur=-1}
function go(i){if(!marks.length)return;if(cur>=0)marks[cur].classList.remove('current');cur=(i+marks.length)%marks.length;
marks[cur].classList.add('current');marks[cur].scrollIntoView({block:'center'});
hitsEl.textContent=(cur+1)+' из '+marks.length+' · Enter — дальше'}
if(q){q.addEventListener('input',()=>{clearMarks();const v=q.value.trim().toLowerCase();hitsEl.textContent='';
if(v.length<2)return;const w=document.createTreeWalker(document.querySelector('article'),NodeFilter.SHOW_TEXT);
const nodes=[];let n;while(n=w.nextNode()){if(n.parentElement.closest('pre .copy'))continue;
if(n.nodeValue.toLowerCase().includes(v))nodes.push(n)}
nodes.slice(0,300).forEach(t=>{let node=t;let i;while(node&&(i=node.nodeValue.toLowerCase().indexOf(v))>-1){
const r=document.createRange();r.setStart(node,i);r.setEnd(node,i+v.length);const m=document.createElement('mark');
r.surroundContents(m);marks.push(m);node=m.nextSibling&&m.nextSibling.nodeType===3?m.nextSibling:null}});
if(marks.length)go(0);else hitsEl.textContent='Не найдено'});
q.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();go(cur+(e.shiftKey?-1:1))}
if(e.key==='Escape'){q.value='';clearMarks();hitsEl.textContent=''}})}
document.addEventListener('keydown',e=>{if(e.key==='/'&&document.activeElement!==q&&q){e.preventDefault();q.focus()}});
document.querySelectorAll('article pre').forEach(pre=>{const b=document.createElement('button');
b.className='btn copy';b.type='button';b.textContent='Копировать';b.onclick=()=>{
const t=pre.querySelector('code').innerText;const done=()=>{b.textContent='Скопировано';setTimeout(()=>b.textContent='Копировать',1500)};
if(navigator.clipboard)navigator.clipboard.writeText(t).then(done,()=>{});};pre.appendChild(b)});
const links=[...document.querySelectorAll('.otp a')],heads=links.map(a=>document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
if(heads.length&&'IntersectionObserver' in window){const io=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){
links.forEach(a=>a.classList.toggle('on',decodeURIComponent(a.hash.slice(1))===e.target.id))}})},{rootMargin:'0px 0px -70% 0px'});heads.forEach(h=>io.observe(h))}
const side=document.querySelector('.side'),mb=document.querySelector('.menu-btn');
if(mb){mb.onclick=e=>{e.stopPropagation();side.classList.toggle('open')};
document.addEventListener('click',e=>{if(side.classList.contains('open')&&!side.contains(e.target))side.classList.remove('open')})}
const up=document.querySelector('.top');if(up){addEventListener('scroll',()=>up.classList.toggle('show',scrollY>900),{passive:true});
up.onclick=()=>scrollTo({top:0,behavior:'smooth'})}
})();
