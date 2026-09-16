(function(){
  "use strict";
  function install(){
    if(document.getElementById("zzUiEnhancementStyle"))return;
    var style=document.createElement("style");style.id="zzUiEnhancementStyle";
    style.textContent=`
      #addSongModal .add-song-content{width:85%;max-width:360px;max-height:70vh;border-radius:24px;background:rgba(255,247,249,.98);box-shadow:0 22px 70px rgba(190,100,135,.28);}
      #addSongModal .add-song-header{padding:18px 20px 14px;font-size:18px;color:#d46f98;border-bottom:1px solid #f5dce4;}
      #addSongModal .add-song-list{padding:8px 0 12px;}
      #addSongModal .add-song-item{display:flex;align-items:center;min-height:68px;padding:12px 18px;gap:12px;border-bottom:1px solid rgba(245,220,228,.55);background:transparent;transition:background .18s,transform .12s;}
      #addSongModal .add-song-item:active{background:rgba(247,174,196,.08);transform:scale(.995);}
      #addSongModal .add-item-name{flex:1;min-width:0;font-size:16px;line-height:1.45;color:#a88491;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      #addSongModal .add-item-status{flex:0 0 auto;min-width:74px;text-align:center;padding:8px 12px;border-radius:18px;font-size:13px;font-weight:600;line-height:1;}
      #addSongModal .add-song-item:not(.disabled) .add-item-status{background:linear-gradient(135deg,#f5a6bd,#e889a8);color:#fff;box-shadow:0 5px 13px rgba(225,120,155,.22);}
      #addSongModal .add-song-item.disabled .add-item-status{background:transparent;color:#d8c4cb;}
      #addSongModal .add-song-item.disabled .add-item-name{color:#cdb8c1;}
      #addSongModal .add-song-item:not(.disabled){cursor:pointer;}
      #addSongModal .add-song-item.disabled{cursor:default;}
    `;
    document.head.appendChild(style);
  }
  function mark(){
    var list=document.getElementById("addSongList");if(!list)return;
    list.querySelectorAll(".add-song-item").forEach(function(item){
      var s=item.querySelector(".add-item-status");if(!s)return;
      var text=(s.textContent||"").trim();
      if(text==="已在列表"){item.classList.add("disabled");item.classList.remove("available");}
      else if(text.indexOf("添加")!==-1){item.classList.add("available");item.classList.remove("disabled");}
    });
  }
  function start(){install();mark();var list=document.getElementById("addSongList");if(list&&window.MutationObserver)new MutationObserver(mark).observe(list,{childList:true,subtree:true});}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();
})();
