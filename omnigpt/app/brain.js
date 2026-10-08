// OmniGPT page: the brain graph. Loaded as a classic script after the inline token script in index.html;
// top-level names are shared between brain.js and app.js.
// BRAIN-START
// A small layered diagram of the agents taking part in this conversation. Only agents that are used or planned are shown.
// Rows: you, memories and skills, models, parallel workers, checks and tools, answer, files the answer embeds. Signals travel along the links that were actually used.
// Nodes fly in from the node that called them and their link draws itself; nodes that will very likely not be needed
// again (memories and skills the current request does not use, idle workers, tools and models unused for a few turns)
// drift off and fade away.
// Normal activity uses the theme's text colour; green means a check passed or something worked; red means an error or a failed check.
const Brain=(()=>{
  const cv=document.getElementById("brain"), cx=cv.getContext("2d");
  const LABEL={user:"you",output:"answer",guard:"safety check",tools:"pc tools",sandbox:"code sandbox",browser:"web browser"};
  const ROWOF={user:0,guard:4,tools:4,sandbox:4,browser:4,output:5}, ORDER={guard:0,tools:1,sandbox:2,browser:3};
  const hubs={}, LB={}; let seq=0, dirty=true, turnNo=0; // LB: labels of memory and skill nodes (their keys are ids)
  const ctxKey=k=>/^(mem|skill):/.test(k), toolKey=k=>/^t:/.test(k), fileKey=k=>/^file:/.test(k);
  function hub(key,label){
    if(hubs[key]){if(label&&hubs[key].label!==label){hubs[key].label=LB[key]=label}return hubs[key]}
    if(label)LB[key]=label;
    const wk=/^W(\d)$/.exec(key);
    const name=LB[key]||LABEL[key]||(toolKey(key)?key.slice(2).replace(/_/g," "):fileKey(key)?key.split(/[\\/]/).pop():ctxKey(key)?key.replace(/^\w+:/,""):wk?"worker "+wk[1]:String(key).split("/").pop().replace(/-\d{4}.*$/,"").replace(/^gemini-/,"gemini ").replace(/-/g," "));
    return hubs[key]={key,label:name,row:ROWOF[key]!==undefined?ROWOF[key]:ctxKey(key)?1:toolKey(key)?4:fileKey(key)?6:wk?3:2,ord:ORDER[key]!==undefined?ORDER[key]:wk?+wk[1]:100+seq++,vis:key==="user",fade:key==="user"?1:0,sc:1,x:0,y:0,tx:0,ty:0,placed:false,busy:0,act:0,mark:null,glow:0,gc:0,leaving:false,vx:0,vy:0,from:null,lastTurn:turnNo};
  }
  hub("user");
  const touch=(k,label,from)=>{const h=hub(k,label);h.lastTurn=turnNo;
    if(h.leaving){h.leaving=false;h.vx=h.vy=0;dirty=true} // needed again after all: it comes back
    if(!h.vis){h.vis=true;h.fade=0;h.sc=.3;h.placed=false;h.from=from||null;dirty=true}
    return h};
  // fly off: drift sideways away from the centre, rise a little, grow slightly and fade out
  function drop(k){
    const h=hubs[k];if(!h||!h.vis||h.leaving||k==="user"||k==="output"||h.busy)return;
    const dir=h.x<W/2-4?-1:h.x>W/2+4?1:(Math.random()<.5?-1:1);
    h.leaving=true;h.vx=dir*(120+Math.random()*90);h.vy=-30-Math.random()*50;dirty=true;
  }
  const links={}, pulses=[];
  const GREEN=[[22,150,80],[70,230,130]], RED=[[210,40,40],[255,80,80]];
  let ink=[255,255,255], dark=false, inkAt=0;
  function theme(now){
    if(inkAt&&now-inkAt<1)return;inkAt=now||1e-6;
    const v=getComputedStyle(document.documentElement).getPropertyValue("--fg").trim().replace("#","");
    if(/^[0-9a-f]{6}$/i.test(v)){ink=[0,2,4].map(i=>parseInt(v.slice(i,i+2),16));dark=(ink[0]+ink[1]+ink[2])/3<128}
  }
  const color=c=>c===1?GREEN[dark?0:1]:c===2?RED[dark?0:1]:ink;
  let W=0,H=0,dpr=1,last=0;
  function size(){dpr=window.devicePixelRatio||1;const r=cv.getBoundingClientRect();W=r.width;H=r.height;cv.width=Math.max(1,Math.round(W*dpr));cv.height=Math.max(1,Math.round(H*dpr));dirty=true}
  new ResizeObserver(size).observe(cv.parentElement);
  // organised placement: rows top to bottom, evenly spaced, at most three per row, centred as one compact block
  function layout(){
    dirty=false;
    const vis=Object.values(hubs).filter(h=>h.vis&&!h.leaving);
    const rows=[];
    const per=Math.max(1,Math.min(3,Math.floor((W-20)/96))); // labels need about 96 px each, so a narrow pane gets fewer per row
    for(let r=0;r<=6;r++){const L=vis.filter(h=>h.row===r).sort((a,b)=>a.ord-b.ord);for(let i=0;i<L.length;i+=per)rows.push(L.slice(i,i+per))}
    const gap=Math.max(70,Math.min(84,(H-90)/Math.max(1,rows.length-1))), total=(rows.length-1)*gap, top=Math.max(34,(H-total)/2-18);
    rows.forEach((L,ri)=>{const step=Math.min(100,(W-20)/Math.max(1,L.length)),w=(L.length-1)*step;L.forEach((h,i)=>{h.tx=W/2-w/2+i*step;h.ty=top+ri*gap;if(!h.placed){const f=h.from&&hubs[h.from];if(f&&f.placed&&f.vis){h.x=f.x;h.y=f.y}else{h.x=h.tx+(Math.random()-.5)*60;h.y=h.ty-40}h.placed=true}})});
  }
  // a path between two neurons: an S-curve between rows, an arc inside a row
  function curve(a,b){
    const dx=b.x-a.x,dy=b.y-a.y;
    if(Math.abs(dy)<12){const m=-30,mx=(a.x+b.x)/2,my=a.y+m;return{at:t=>[(1-t)*(1-t)*a.x+2*(1-t)*t*mx+t*t*b.x,(1-t)*(1-t)*a.y+2*(1-t)*t*my+t*t*b.y],draw:c=>c.quadraticCurveTo(mx,my,b.x,b.y)}}
    const c1x=a.x,c1y=a.y+dy*.5,c2x=b.x,c2y=b.y-dy*.5;
    return{at:t=>{const u=1-t;return[u*u*u*a.x+3*u*u*t*c1x+3*u*t*t*c2x+t*t*t*b.x,u*u*u*a.y+3*u*u*t*c1y+3*u*t*t*c2y+t*t*t*b.y]},draw:c=>c.bezierCurveTo(c1x,c1y,c2x,c2y,b.x,b.y)};
  }
  function msg(a,b,c=0){
    if(a===b)return;touch(a);touch(b,undefined,a);
    const k=a+">"+b;(links[k]||(links[k]={a,b,t:0,grow:0}));links[k].t=performance.now();links[k].keep=false;
    pulses.push({a,b,pos:0,sp:1.1+Math.random()*.4,c});
  }
  const mark=(key,c)=>{const h=touch(key);h.mark={c,t:performance.now()};h.glow=1;h.gc=c;h.act=1};
  function draw(now,dt){
    theme(now);if(dirty)layout();
    cx.setTransform(dpr,0,0,dpr,0,0);cx.clearRect(0,0,W,H);
    const R=7,rgb=(c,a)=>`rgba(${c[0]},${c[1]},${c[2]},${a})`;
    for(const k in hubs){const h=hubs[k];if(!h.vis)continue;
      if(h.leaving){h.x+=h.vx*dt;h.y+=h.vy*dt;h.vy+=60*dt;h.sc+=dt*.5;h.fade-=dt*1.4;
        if(h.fade<=0){h.vis=false;h.leaving=false;h.placed=false;h.fade=0;h.sc=1;h.mark=null;h.glow=0;for(const l in links)if(links[l].a===k||links[l].b===k)delete links[l]}
        continue}
      h.x+=(h.tx-h.x)*Math.min(1,dt*5);h.y+=(h.ty-h.y)*Math.min(1,dt*5);h.fade=Math.min(1,h.fade+dt*2.2);h.sc+=(1-h.sc)*Math.min(1,dt*6)}
    // links that have carried a signal, fading over time
    for(const k in links){const l=links[k],age=l.keep?0:(performance.now()-l.t)/1000;if(age>40){delete links[k];continue}
      const A=hubs[l.a],B=hubs[l.b];if(!A.vis||!B.vis)continue;const g=curve(A,B),fa=Math.min(A.fade,B.fade);
      l.grow=Math.min(1,(l.grow===undefined?1:l.grow)+dt*2.2);
      cx.strokeStyle=rgb(ink,(l.keep?.3:.4*(1-age/40))*fa);cx.lineWidth=1.5;cx.beginPath();cx.moveTo(A.x,A.y);
      if(l.grow<1){ // a new connection draws itself from the caller to the new node, with a bright tip
        const e=1-Math.pow(1-l.grow,3);for(let s=1;s<=20;s++){const q=g.at(e*s/20);cx.lineTo(q[0],q[1])}cx.stroke();
        const q=g.at(e);cx.fillStyle=rgb(ink,.9*fa);cx.beginPath();cx.arc(q[0],q[1],2.6,0,6.3);cx.fill();
      }else{g.draw(cx);cx.stroke()}}
    // signals
    for(let k=pulses.length-1;k>=0;k--){
      const p=pulses[k];p.pos+=p.sp*dt;const A=hubs[p.a],B=hubs[p.b];
      if(!A.vis||!B.vis||A.leaving||B.leaving){pulses.splice(k,1);continue}
      if(p.pos>=1){B.glow=1;B.gc=p.c;B.act=1;pulses.splice(k,1);continue}
      const g=curve(A,B),c=color(p.c);
      cx.strokeStyle=rgb(c,.9);cx.lineWidth=2.6;cx.lineCap="round";cx.beginPath();
      for(let s=0;s<=10;s++){const t=Math.max(0,p.pos-.2*(1-s/10)),q=g.at(t);s?cx.lineTo(q[0],q[1]):cx.moveTo(q[0],q[1])}cx.stroke();
      const q=g.at(p.pos),gr=cx.createRadialGradient(q[0],q[1],0,q[0],q[1],R*2);gr.addColorStop(0,rgb(c,.6));gr.addColorStop(1,rgb(c,0));cx.fillStyle=gr;cx.beginPath();cx.arc(q[0],q[1],R*2,0,6.3);cx.fill();
      cx.fillStyle=rgb(c,1);cx.beginPath();cx.arc(q[0],q[1],3,0,6.3);cx.fill();
    }
    // neurons
    for(const key in hubs){
      const h=hubs[key];if(!h.vis)continue;h.glow=Math.max(0,h.glow-dt*.8);h.act=Math.max(0,h.act-dt*.3);
      const x=h.x,y=h.y,al=Math.max(0,h.fade),active=h.busy||h.act>.05||h.mark,c=h.glow>.02?color(h.gc):ink,R=7*h.sc;
      cx.globalAlpha=al;
      if(h.glow>.02){const rr=R*(2.4+2*h.glow),gr=cx.createRadialGradient(x,y,0,x,y,rr);gr.addColorStop(0,rgb(c,.5*h.glow));gr.addColorStop(1,rgb(c,0));cx.fillStyle=gr;cx.beginPath();cx.arc(x,y,rr,0,6.3);cx.fill()}
      if(h.mark){const age=(performance.now()-h.mark.t)/1000;if(age>1.8)h.mark=null;else{const mc=color(h.mark.c);cx.strokeStyle=rgb(mc,Math.max(0,1-age/1.8)*.9);cx.lineWidth=2.2;cx.beginPath();cx.arc(x,y,R*(1.3+age*3),0,6.3);cx.stroke()}}
      cx.strokeStyle=rgb(c,active?1:.7);cx.lineWidth=active?2.2:1.7;cx.beginPath();cx.arc(x,y,R,0,6.3);cx.stroke();
      cx.fillStyle=rgb(c,active?1:.85);cx.beginPath();cx.arc(x,y,R*.5,0,6.3);cx.fill();
      if(h.busy){const a=now*5;cx.fillStyle=rgb(ink,1);cx.beginPath();cx.arc(x+Math.cos(a)*R*1.7,y+Math.sin(a)*R*1.7,2.4,0,6.3);cx.fill()}
      cx.font=`${active?600:500} 12.5px 'Segoe UI Variable Text','Segoe UI',sans-serif`;cx.textAlign="center";cx.textBaseline="top";cx.fillStyle=rgb(ink,active?1:.82);
      const words=h.label.split(" "),lines=[];let cur="";for(const w of words){if((cur+" "+w).trim().length>13&&cur){lines.push(cur);cur=w}else cur=(cur+" "+w).trim()}if(cur)lines.push(cur);
      lines.forEach((ln,i)=>cx.fillText(ln,x,y+R+7+i*15));
      cx.globalAlpha=1;
    }
  }
  function frame(t){requestAnimationFrame(frame);if(!cv.offsetParent||t-last<32)return;const dt=Math.min(.1,(t-last)/1000);last=t;draw(t/1000,dt)}
  requestAnimationFrame(frame);
  const fed=new Set(), pending=new Set(); let ctxPruned=true, ctxReady=false; // ctxReady: this turn's memories and skills have been chosen // memories and skills shown this turn, and the ones waiting for the next model to start
  return{
    last:"user",
    turn(){try{fed.clear();pending.clear();ctxPruned=false;ctxReady=false;turnNo++;this.last="user";
      for(const k in hubs){const h=hubs[k];if(!h.vis||h.leaving||ctxKey(k))continue;
        const idle=turnNo-h.lastTurn, lim=/^W\d$/.test(k)?1:toolKey(k)||["guard","sandbox","tools","browser"].includes(k)?3:2;
        if(idle>=lim)drop(k)}}catch(e){}},
    // a memory or skill that was given to the agents: it lights up and feeds the next model that starts
    ctx(key,label){try{touch(key,label);if(!fed.has(key)){fed.add(key);pending.add(key);msg("user",key,0)}}catch(e){}},
    ready(){ctxReady=true},
    // files embedded in the answer: they come out of the answer node
    files(paths){try{(paths||[]).slice(0,8).forEach(p=>{const k="file:"+String(p).toLowerCase();touch(k,String(p).split(/[\\/]/).pop(),"output");msg("output",k,0);mark(k,1)})}catch(e){}},
    feed(model){try{
      if(!ctxPruned&&ctxReady){ctxPruned=true;for(const k in hubs)if(ctxKey(k)&&hubs[k].vis&&!fed.has(k))drop(k)} // memories and skills this request does not use
      for(const k of pending)msg(k,model,0);pending.clear()}catch(e){}},
    msg(a,b){try{msg(a,b,0)}catch(e){}},
    ok(k){try{mark(k,1)}catch(e){}},
    fail(k){try{mark(k,2)}catch(e){}},
    busy(k,on){try{const h=touch(k);h.busy=on?1:0;if(on)h.act=1}catch(e){}},
    plan(keys){try{keys.filter(Boolean).forEach(touch)}catch(e){}},
    register(){},
    snapshot(){try{const n=Object.values(hubs).filter(h=>h.vis&&!h.leaving&&h.key!=="user").sort((a,b)=>a.ord-b.ord).map(h=>h.key);return{n,l:Object.values(links).map(l=>[l.a,l.b]),lb:Object.fromEntries(n.filter(k=>LB[k]).map(k=>[k,LB[k]]))}}catch(e){return null}},
    restore(g){try{if(!g||!Array.isArray(g.n))return;g.n.forEach(k=>touch(k,g.lb&&g.lb[k]));(g.l||[]).forEach(([a,b])=>{if(hubs[a]&&hubs[b])links[a+">"+b]={a,b,t:0,keep:true,grow:0}});dirty=true}catch(e){}},
    reset(){pulses.length=0;fed.clear();pending.clear();for(const k in links)delete links[k];for(const k in hubs){const h=hubs[k];h.busy=0;h.mark=null;h.glow=0;if(k!=="user"){h.vis=false;h.fade=0;h.placed=false;h.leaving=false;h.sc=1}}ctxPruned=true;dirty=true;this.last="user"}
  };
})();
// BRAIN-END
