(function () {
  "use strict";
  var THUMBS="thumbs/";
  var NUMS=["001","002","003","004","005","006","007","008","009","010","011","012","013","014","015","016","017","018","019","020","021","022","023","024","025","026","027","028","029","030","031","032","033","034","035","036","037","038","039","040","041","042","043","044","045","046","047","048","049","050","051","052","053","054","055","056","057","058","059","060","061","062","063","064","065","066","067","068","069","070","071","072","073","074","075","076","078","079","080","081","082","083","084","085","086","087","088","089","090","091","092","093","094","095","096","097","098","099","100","101","102","103","104","105","106","107","108","109","110","111","112","113","114","115","116","117","118","119","120","121","122","123","124","125","126","127","129"];
  /* 背景层：127 张图片分散铺满整个屏幕，各自独立漂浮；没有碰撞、没有陀螺仪、没有自转。 */
  var oldWrap=document.getElementById("batiaoWrap");
  if(oldWrap)oldWrap.style.display="none";
  /* 注意：不隐藏 zzFeaturedLayer，让最上层 8 张主角图片保持原样。 */
  var canvas=document.getElementById("zzDynamicCanvas");
  if(!canvas){canvas=document.createElement("canvas");canvas.id="zzDynamicCanvas";document.body.insertBefore(canvas,document.body.firstChild);}
  canvas.style.cssText="position:fixed;inset:0;width:100vw;height:100vh;z-index:0;pointer-events:auto;touch-action:none;";
  var ctx=canvas.getContext("2d",{alpha:true}),dpr=1,W=0,H=0,bodies=[];
  var images=Object.create(null),loaded=0;
  function rand(a,b){return a+Math.random()*(b-a);}
  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
  function loadImage(id){
    if(images[id])return images[id];
    var im=new Image();im.decoding="async";im.onload=function(){loaded++;};im.onerror=function(){loaded++;};im.src=THUMBS+id+".jpg";images[id]=im;return im;
  }
  NUMS.forEach(loadImage);
  function radius(){return clamp(Math.min(W,H)*0.040,17,29);}
  function makeBody(id,i){
    /* 网格只负责均匀铺开初始位置，不代表碰撞体积。 */
    var cols=W<600?6:10,rows=Math.ceil(NUMS.length/cols),cw=W/cols,ch=H/rows,r=radius();
    var cx=(i%cols)*cw+cw*.5,cy=Math.floor(i/cols)*ch+ch*.5;
    var maxJitterX=Math.max(0,cw*.30-r*.45),maxJitterY=Math.max(0,ch*.30-r*.45);
    return {id:id,baseX:cx+rand(-maxJitterX,maxJitterX),baseY:cy+rand(-maxJitterY,maxJitterY),x:cx,y:cy,r:r*rand(.72,1.02),phase:rand(0,Math.PI*2),speed:rand(.65,1.05),driftX:rand(.75,1.25),driftY:rand(.75,1.25),ampX:rand(8,22),ampY:rand(7,19),alpha:rand(.13,.24)};
  }
  function build(){bodies=[];for(var i=0;i<NUMS.length;i++)bodies.push(makeBody(NUMS[i],i));}
  function resize(){
    W=innerWidth;H=innerHeight;dpr=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.max(1,Math.floor(W*dpr));canvas.height=Math.max(1,Math.floor(H*dpr));canvas.style.width=W+"px";canvas.style.height=H+"px";ctx.setTransform(dpr,0,0,dpr,0,0);
    var cols=W<600?6:10,rows=Math.ceil(NUMS.length/cols),cw=W/cols,ch=H/rows,r=radius();
    bodies.forEach(function(b,i){var maxJitterX=Math.max(0,cw*.30-r*.45),maxJitterY=Math.max(0,ch*.30-r*.45);b.baseX=(i%cols)*cw+cw*.5+clamp(b.baseX-(i%cols)*cw-cw*.5,-maxJitterX,maxJitterX);b.baseY=Math.floor(i/cols)*ch+ch*.5+clamp(b.baseY-Math.floor(i/cols)*ch-ch*.5,-maxJitterY,maxJitterY);b.r=clamp(b.r,17,29);});
  }
  addEventListener("resize",resize,{passive:true});
  function step(now){bodies.forEach(function(b){var t=now*.001*b.speed+b.phase;b.x=b.baseX+Math.sin(t*b.driftX)*b.ampX+Math.sin(t*.43+b.phase)*b.ampX*.35;b.y=b.baseY+Math.cos(t*b.driftY)*b.ampY+Math.sin(t*.51+b.phase)*b.ampY*.30;});}
  function draw(b){var im=images[b.id];if(!im||!im.complete||!im.naturalWidth)return;ctx.save();ctx.translate(b.x,b.y);ctx.globalAlpha=b.alpha;ctx.beginPath();ctx.arc(0,0,b.r,0,Math.PI*2);ctx.clip();ctx.drawImage(im,-b.r,-b.r,b.r*2,b.r*2);ctx.restore();}
  function frame(now){step(now);ctx.clearRect(0,0,W,H);bodies.forEach(draw);requestAnimationFrame(frame);}
  function pick(old){var id=old,n=0;while(id===old&&n++<20)id=NUMS[Math.floor(Math.random()*NUMS.length)];loadImage(id);return id;}
  function hit(x,y){var best=null,bd=Infinity;bodies.forEach(function(b){var d=Math.hypot(x-b.x,y-b.y);if(d<=b.r*1.35&&d<bd){bd=d;best=b;}});return best;}
  canvas.addEventListener("pointerdown",function(e){var b=hit(e.clientX,e.clientY);if(b)b.id=pick(b.id);},{passive:true});
  build();resize();requestAnimationFrame(frame);
  window.__ZZ_DYNAMIC_BACKGROUND__={count:bodies.length,loaded:function(){return loaded;}};
})();
