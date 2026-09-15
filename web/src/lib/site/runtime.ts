/**
 * The only JavaScript the public page ships. Inlined, under 2KB, no framework.
 *
 * Three jobs, and each one is here because it cannot be done on the server
 * without breaking the cache:
 *
 *   1. In-app browser escape. Depends on the user-agent, and UA is not in the
 *      cache key. Detecting it server-side would mean adding it, which would
 *      fragment every cached page by browser build string.
 *   2. Click beacons. Fire-and-forget on pointerdown so navigation is never
 *      waiting on us.
 *   3. Countdown. Computed from a target instant in the markup rather than a
 *      pre-rendered duration, so a page served from cache five minutes later
 *      still shows the right number.
 */

export function runtimeScript(beaconUrl: string): string {
  return `(function(){
var UA=navigator.userAgent||"";
var IN_APP=/Instagram|FBAN|FBAV|FB_IAB|Line\\/|TikTok|BytedanceWebview|musical_ly|Snapchat|Twitter|LinkedInApp|Pinterest/i;
var d=document;

if(IN_APP.test(UA)){
  var bar=d.getElementById("escape");
  if(bar){
    var url=location.href;
    var ios=/iPhone|iPad|iPod/i.test(UA);
    var btn=bar.querySelector("button");
    bar.querySelector("[data-browser]").textContent=ios?"Safari":"Chrome";
    bar.style.display="flex";
    btn.addEventListener("click",function(){
      if(ios){location.href="x-safari-"+url;}
      else{location.href="intent://"+url.replace(/^https?:\\/\\//,"")+"#Intent;scheme=https;package=com.android.chrome;end";}
      setTimeout(function(){
        if(d.visibilityState!=="visible")return;
        if(navigator.clipboard)navigator.clipboard.writeText(url).catch(function(){});
        btn.textContent="Link copied";
      },1200);
    });
  }
}

var page=d.body.dataset;
function beacon(el){
  if(page.preview)return;
  var payload=JSON.stringify({
    h:page.handle,
    b:el.dataset.block,
    s:el.dataset.slug||null,
    v:page.variant||null,
    t:Date.now(),
    r:d.referrer?d.referrer.slice(0,256):null,
    e:(page.handle||"")+":"+el.dataset.block+":"+Date.now()+":"+Math.random().toString(36).slice(2,8)
  });
  if(navigator.sendBeacon){navigator.sendBeacon(${JSON.stringify(beaconUrl)},new Blob([payload],{type:"text/plain"}));return}
  fetch(${JSON.stringify(beaconUrl)},{method:"POST",body:payload,keepalive:true,mode:"no-cors"}).catch(function(){})
}
d.addEventListener("pointerdown",function(ev){
  var el=ev.target.closest?ev.target.closest("[data-block]"):null;
  if(el&&el.dataset.block)beacon(el)
},{passive:true,capture:true});

var cd=d.getElementById("countdown");
if(cd){
  var target=Date.parse(cd.dataset.at||"");
  var out=cd.querySelector("b");
  var label=cd.querySelector("span");
  var tick=function(){
    var ms=target-Date.now();
    if(ms<=0){out.textContent="Live";label.textContent="";return}
    var s=Math.floor(ms/1000),dd=Math.floor(s/86400),hh=Math.floor(s%86400/3600),mm=Math.floor(s%3600/60);
    out.textContent=dd>0?dd+"d "+hh+"h":hh>0?hh+"h "+mm+"m":mm+"m "+(s%60)+"s";
    setTimeout(tick,ms<3600000?1000:60000)
  };
  tick()
}
})();`;
}
