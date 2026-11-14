(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),t.credentials=e.crossOrigin===`use-credentials`?`include`:e.crossOrigin===`anonymous`?`omit`:`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e=`#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }
`,t=`#version 300 es
precision highp float;
out vec4 outColor;

#define MAX_SHAPES 8

uniform sampler2D uTex;
uniform vec2  uView;        // viewport size, pt
uniform float uScale;       // device pixels per pt
uniform vec2  uTexOffset;   // where the backdrop's top-left sits, pt (cover fit)
uniform vec2  uTexSize;     // backdrop's drawn size, pt
uniform float uTexelsPerPt; // backdrop texels per pt (for mip selection)
uniform vec2  uScroll;      // backdrop scroll, pt

uniform int   uCount;
uniform vec4  uShapeA[MAX_SHAPES]; // centre x, centre y, half width, half height
uniform vec4  uShapeB[MAX_SHAPES]; // corner radius, appearance (0 light, 1 dark), -, -

uniform float uRefraction, uBezel, uMagnify, uDispersion;
uniform float uBlur, uFrost, uVibrancy, uBrightness, uDim, uPickup;
uniform float uSpecular, uRimWidth, uLightAngle, uShadow, uMerge, uSmoothing;
uniform float uIor;         // index of refraction of the glass

// ---- Backdrop ---------------------------------------------------------------------------------
vec2 uvOf(vec2 p) { return (p + uScroll - uTexOffset) / uTexSize; }

vec3 backdrop(vec2 p, float lod) { return textureLod(uTex, uvOf(p), lod).rgb; }

// Gaussian blur, sigma = radius (pt). 16 taps on a golden-angle spiral out to 2 sigma, read from a
// mip level that pre-averages the gaps between taps.
float blurLod(float radius) { return max(log2(radius * uTexelsPerPt * 0.5), 0.0); }

vec3 backdropBlur(vec2 p, float radius) {
  if (radius < 0.5) return backdrop(p, 0.0);
  float lod = blurLod(radius);
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = 0; i < 16; i++) {
    float f = (float(i) + 0.5) / 16.0;
    float rr = sqrt(f) * 2.0 * radius;
    float a = float(i) * 2.39996323;
    float w = exp(-0.5 * (rr * rr) / (radius * radius));
    acc += backdrop(p + vec2(cos(a), sin(a)) * rr, lod) * w;
    wsum += w;
  }
  return acc / wsum;
}

// ---- Shape ------------------------------------------------------------------------------------
// Rounded box with continuous corners. smoothing 0 = circular corners; 0.6 ≈ Figma "iOS" smoothing.
// The corner grows to r·(1+s) and becomes a superellipse, so the 45° inset stays close to a circle's.
float sdSmoothBox(vec2 p, vec2 b, float r, float s) {
  float m = min(b.x, b.y);
  r = min(r, m);
  float R = min(r * (1.0 + s), m);
  vec2 q = abs(p) - b + R;
  if (R < 0.01) return min(max(q.x, q.y), 0.0) + length(max(q, 0.0));
  float n = 2.0 + 3.0 * (R / max(r, 0.01) - 1.0);
  vec2 k = max(q, 0.0) / R;
  float c = (k.x + k.y > 0.0) ? pow(pow(k.x, n) + pow(k.y, n), 1.0 / n) * R : 0.0;
  return c + min(max(q.x, q.y), 0.0) - R;
}

float smin(float a, float b, float k) {
  if (k <= 0.0) return min(a, b);
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float shapeDist(vec2 p, int i) {
  return sdSmoothBox(p - uShapeA[i].xy, uShapeA[i].zw, uShapeB[i].x, uSmoothing);
}

float field(vec2 p) {
  float d = 1e5;
  for (int i = 0; i < MAX_SHAPES; i++) {
    if (i >= uCount) break;
    d = smin(d, shapeDist(p, i), uMerge);
  }
  return d;
}

// Distance plus a blended centre and appearance (so merged shapes share one lens smoothly).
float fieldFull(vec2 p, out vec2 centre, out float appearance, out float inscribed) {
  float ds[MAX_SHAPES];
  float d = 1e5, dmin = 1e5;
  for (int i = 0; i < MAX_SHAPES; i++) {
    if (i >= uCount) break;
    ds[i] = shapeDist(p, i);
    d = smin(d, ds[i], uMerge);
    dmin = min(dmin, ds[i]);
  }
  float temp = max(uMerge * 0.35, 1.0);
  vec2 c = vec2(0.0); float a = 0.0, r = 0.0, wsum = 0.0;
  for (int i = 0; i < MAX_SHAPES; i++) {
    if (i >= uCount) break;
    float w = exp(-(ds[i] - dmin) / temp);
    c += uShapeA[i].xy * w; a += uShapeB[i].y * w; r += min(uShapeA[i].z, uShapeA[i].w) * w; wsum += w;
  }
  centre = c / max(wsum, 1e-5);
  appearance = a / max(wsum, 1e-5);
  inscribed = r / max(wsum, 1e-5);
  return d;
}

// Thick-lens refraction across the rim (Snell's law on a convex squircle rim, after kube.io's
// write-up on Apple's glass). Rim height h(x) = (1 − (1 − x)⁴)^¼, x = 0 at the edge → 1 inside.
// A vertical ray meets the tilted surface at θ = atan(h′) and refracts to θᵣ = asin(sin θ / IOR);
// the shift is tan(θ − θᵣ), normalised to the grazing edge, so "refraction" is the shift at the edge.
// Calibrated against the Good Machines "Thick lens": ~26 pt at 2 pt depth, ~6 pt at 12 pt (refraction 46).
float refractionProfile(float x) {
  float u = 1.0 - x;
  float base = max(1.0 - u * u * u * u, 1e-6);
  float slope = u * u * u * pow(base, -0.75);
  float theta = atan(slope);
  float thetaR = asin(sin(theta) / uIor);
  float edge = 1.5707963 - asin(1.0 / uIor);
  return tan(theta - thetaR) / tan(edge);
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec2 p = vec2(gl_FragCoord.x, uView.y * uScale - gl_FragCoord.y) / uScale;
  vec3 bg = backdrop(p, 0.0);
  if (uCount == 0) { outColor = vec4(bg, 1.0); return; }

  vec2 centre; float appearance, inscribed;
  float d0 = fieldFull(p, centre, appearance, inscribed);

  // Normal from the field's gradient; dividing by its length turns the field into a true distance.
  const float e = 0.75;
  vec2 g = vec2(field(p + vec2(e, 0.0)) - field(p - vec2(e, 0.0)),
                field(p + vec2(0.0, e)) - field(p - vec2(0.0, e))) / (2.0 * e);
  float gl = max(length(g), 1e-4);
  vec2 n = g / gl;              // outward normal
  float d = d0 / gl;            // signed distance, pt (negative inside)

  // ---- Outside: contact shadow and the readability scrim -------------------------------------
  float ds = field(p - vec2(0.0, 5.0));
  float shadow = uShadow * 0.32 * (1.0 - smoothstep(-4.0, 18.0, ds));
  float scrim = uDim * (1.0 - smoothstep(0.0, 90.0, d));
  vec3 outside = bg * (1.0 - shadow) * (1.0 - scrim);

  float coverage = clamp(0.5 - d * uScale, 0.0, 1.0);
  if (coverage <= 0.0) { outColor = vec4(outside, 1.0); return; }

  // ---- Lens ------------------------------------------------------------------------------------
  // The rim bends what is behind it inward, towards the middle; the middle is magnified.
  // When the rim is wider than the shape is thick, it meets itself in the middle (no tear at the centre).
  float depth = max(-d, 0.0);
  float bezel = max(min(uBezel, inscribed), 0.001);
  float x = clamp(depth / bezel, 0.0, 1.0);
  float shift = uRefraction * refractionProfile(x);
  vec2 base = centre + (p - centre) / max(uMagnify, 0.01);

  // Dispersion: blue bends more than red. Blur once at the green position; red and blue add only
  // their offset from it, read from the same mip level.
  vec2 pg = base - n * shift;
  vec3 col = backdropBlur(pg, uBlur);
  if (uDispersion > 0.0 && shift > 0.01) {
    float lod = uBlur < 0.5 ? 0.0 : blurLod(uBlur);
    vec3 g0 = backdrop(pg, lod);
    col.r += backdrop(base - n * shift * (1.0 - uDispersion), lod).r - g0.r;
    col.b += backdrop(base - n * shift * (1.0 + uDispersion), lod).b - g0.b;
  }

  // ---- Surface ---------------------------------------------------------------------------------
  col = mix(vec3(luma(col)), col, uVibrancy);
  col += uBrightness;
  if (uPickup > 0.0) {
    float lod = log2(max(uView.x, 1.0) * 0.25 * uTexelsPerPt);
    vec3 under = backdrop(centre, lod);
    col = mix(col, under, uPickup * 0.6);
  }
  vec3 haze = appearance > 0.5 ? vec3(0.14) : vec3(0.97);
  col = mix(col, haze, uFrost * 0.75);

  // ---- Light -----------------------------------------------------------------------------------
  // Key light on the side facing the light, a weaker internal reflection on the opposite side.
  float a = radians(uLightAngle);
  vec2 L = vec2(cos(a), sin(a));
  float rim = 1.0 - smoothstep(0.0, uRimWidth, depth);
  float key = pow(max(dot(n, L), 0.0), 1.5);
  float back = 0.55 * pow(max(dot(n, -L), 0.0), 1.5);
  float hl = uSpecular * rim * (0.08 + key + back);
  col += hl * (1.0 - 0.35 * col);

  outColor = vec4(mix(outside, clamp(col, 0.0, 1.0), coverage), 1.0);
}
`,n=`uTex.uView.uScale.uTexOffset.uTexSize.uTexelsPerPt.uScroll.uCount.uShapeA.uShapeB.uRefraction.uBezel.uMagnify.uDispersion.uBlur.uFrost.uVibrancy.uBrightness.uDim.uPickup.uSpecular.uRimWidth.uLightAngle.uShadow.uMerge.uSmoothing.uIor`.split(`.`),r=1.5;function i(e){let t=e.w,n=e.kind===`circle`?e.w:e.h,r=e.kind===`rect`?e.r??0:Math.min(t,n)/2;return{hw:t/2,hh:n/2,r}}var a=class{canvas;gl;program;loc={};tex;source=null;sourceSize=[1,1];anchorY=.5;view=[1,1];scale=1;shapeA=new Float32Array(32);shapeB=new Float32Array(32);constructor(r){this.canvas=r;let i=r.getContext(`webgl2`,{antialias:!1,premultipliedAlpha:!1,preserveDrawingBuffer:!0});if(!i)throw Error(`WebGL2 is not available in this browser.`);this.gl=i,this.program=this.link(e,t);for(let e of n)this.loc[e]=i.getUniformLocation(this.program,e);this.tex=i.createTexture(),i.bindTexture(i.TEXTURE_2D,this.tex),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_S,i.REPEAT),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_T,i.REPEAT),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.LINEAR_MIPMAP_LINEAR),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAG_FILTER,i.LINEAR),i.texImage2D(i.TEXTURE_2D,0,i.RGBA,1,1,0,i.RGBA,i.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]))}setViewport(e,t,n){this.view=[e,t],this.scale=n;let r=Math.round(e*n),i=Math.round(t*n);(this.canvas.width!==r||this.canvas.height!==i)&&(this.canvas.width=r,this.canvas.height=i)}setBackdrop(e,t,n,r=.5){this.source=e,this.sourceSize=[t,n],this.anchorY=r,this.updateBackdrop()}updateBackdrop(){if(!this.source)return;let e=this.gl;e.bindTexture(e.TEXTURE_2D,this.tex),e.pixelStorei(e.UNPACK_FLIP_Y_WEBGL,!1),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,this.source),e.generateMipmap(e.TEXTURE_2D)}backdropRect(){let[e,t]=this.view,[n,r]=this.sourceSize,i=Math.max(e/n,t/r),a=n*i,o=r*i;return{x:(e-a)/2,y:(t-o)*this.anchorY,w:a,h:o,texelsPerPt:1/i}}render(e){let t=this.gl,n=this.loc,a=e.params,o=Math.min(e.shapes.length,8);for(let t=0;t<o;t++){let n=e.shapes[t],r=i(n);this.shapeA.set([n.x,n.y,r.hw,r.hh],t*4),this.shapeB.set([r.r,+(e.appearances[t]===`dark`),0,0],t*4)}let s=this.backdropRect();t.viewport(0,0,this.canvas.width,this.canvas.height),t.useProgram(this.program),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,this.tex),t.uniform1i(n.uTex,0),t.uniform2f(n.uView,this.view[0],this.view[1]),t.uniform1f(n.uScale,this.scale),t.uniform2f(n.uTexOffset,s.x,s.y),t.uniform2f(n.uTexSize,s.w,s.h),t.uniform1f(n.uTexelsPerPt,s.texelsPerPt),t.uniform2f(n.uScroll,e.scroll[0],e.scroll[1]),t.uniform1i(n.uCount,o),t.uniform4fv(n.uShapeA,this.shapeA),t.uniform4fv(n.uShapeB,this.shapeB),t.uniform1f(n.uRefraction,a.refraction),t.uniform1f(n.uBezel,a.bezel),t.uniform1f(n.uMagnify,a.magnify),t.uniform1f(n.uDispersion,a.dispersion),t.uniform1f(n.uBlur,a.blur),t.uniform1f(n.uFrost,a.frost),t.uniform1f(n.uVibrancy,a.vibrancy),t.uniform1f(n.uBrightness,a.brightness),t.uniform1f(n.uDim,a.dim),t.uniform1f(n.uPickup,a.pickup),t.uniform1f(n.uSpecular,a.specular),t.uniform1f(n.uRimWidth,a.rimWidth),t.uniform1f(n.uLightAngle,a.lightAngle),t.uniform1f(n.uShadow,a.shadow),t.uniform1f(n.uMerge,a.merge),t.uniform1f(n.uSmoothing,a.smoothing),t.uniform1f(n.uIor,r),t.drawArrays(t.TRIANGLES,0,3)}link(e,t){let n=this.gl,r=(e,t)=>{let r=n.createShader(e);if(n.shaderSource(r,t),n.compileShader(r),!n.getShaderParameter(r,n.COMPILE_STATUS))throw Error(n.getShaderInfoLog(r)??`shader compile failed`);return r},i=n.createProgram();if(n.attachShader(i,r(n.VERTEX_SHADER,e)),n.attachShader(i,r(n.FRAGMENT_SHADER,t)),n.linkProgram(i),!n.getProgramParameter(i,n.LINK_STATUS))throw Error(n.getProgramInfoLog(i)??`link failed`);return i}},o=`./assets/`;async function s(e){try{let t=await fetch(`./config/${e}.json`,{cache:`no-store`});return t.ok?await t.json():null}catch{return null}}var c=class{s;constructor(e){this.s=BigInt.asUintN(64,e)}next(){this.s=BigInt.asUintN(64,this.s+11400714819323198485n);let e=this.s;return e=BigInt.asUintN(64,(e^e>>30n)*13787848793156543929n),e=BigInt.asUintN(64,(e^e>>27n)*10723151780598845931n),e^e>>31n}unit(){return Number(this.next()>>11n)/2**53}signed(){return this.unit()*2-1}};function l(e,t=12){let n=[],r=t=>e[Math.min(e.length-1,Math.max(0,t))];for(let i=0;i<e.length-1;i++)for(let e=0;e<t;e++){let a=e/t,o=r(i-1),s=r(i),c=r(i+1),l=r(i+2);n.push(.5*(2*s+(-o+c)*a+(2*o-5*s+4*c-l)*a*a+(-o+3*s-3*c+l)*a*a*a))}return n.push(e[e.length-1]),n}function u(e,t,n,r=1){let i=e,a=i/2,o=i*.06,s=[];for(let e=0;e<n;e++){let o=new c(BigInt(t)*2654435769n+BigInt(e)*1663821211n),l=1+o.unit(),u=3.6+o.unit()*2.8,d={x:a+o.signed()*i*.8*r,y:a+i*.1+o.unit()*i*.4*r},f=i*(1+o.unit()*.6)*r,p=o.signed()*i*r,m=i*.16*(o.unit()>.5?1:-1),h=[0,1,2,3,4].map(e=>d.x+e/4*p+m*Math.sin(e/4*Math.PI*2)),g=[0,1,2,3,4].map(e=>d.y-e/4*f),_=.35+o.unit()*.45,v=u*(e/Math.max(1,n)+o.unit()*.15);s.push({size:l*2,seconds:u,offset:v,peak:_,xs:h,ys:g})}return{size:e,begin:t%7*.37,loops:[{name:`bob`,property:`y`,unit:`pt`,values:[0,-o,0,o*.6,0],seconds:3.4},{name:`sway`,property:`x`,unit:`pt`,values:[0,o*.5,0,-o*.5,0],seconds:4.7},{name:`tilt`,property:`rotation`,unit:`rad`,values:[0,.09,0,-.07,0],seconds:5.9},{name:`breathe`,property:`scale`,unit:`×`,values:[1,1.05,1,.98,1],seconds:2.9}],motes:s,moteOpacity:{at:[0,.3,.65,1],ofPeak:[0,1,.8,0]},moteScale:[.5,1,.9,.4]}}var d=(e,t,n,r)=>e.animate(t,{duration:n*1e3,iterations:1/0,delay:-r*1e3,easing:`linear`});function f(e,t,n,r,i,a=1){if(e.classList.add(`fy-star`),e.style.width=e.style.height=`${n}px`,e.innerHTML=`<span class="fy-bob"><span class="fy-sway"><img class="ico fy-tilt" src="${t}" width="${n}" height="${n}" alt=""></span></span>`,window.matchMedia(`(prefers-reduced-motion: reduce)`).matches)return;let o=u(n,r,i,a),s={y:e.querySelector(`.fy-bob`),x:e.querySelector(`.fy-sway`),rotation:e.querySelector(`.fy-tilt`),scale:e.querySelector(`.fy-tilt`)},c={y:e=>({transform:`translateY(${e}px)`}),x:e=>({transform:`translateX(${e}px)`}),rotation:e=>({rotate:`${e}rad`}),scale:e=>({scale:String(e)})};for(let e of o.loops)d(s[e.property],l(e.values).map(c[e.property]),e.seconds,o.begin);for(let t of o.motes){let n=document.createElement(`i`);n.className=`fy-mote`,n.style.width=n.style.height=`${t.size}px`,n.style.margin=`${-t.size/2}px 0 0 ${-t.size/2}px`;let r=document.createElement(`i`);n.appendChild(r),e.prepend(n);let i=l(t.xs),a=l(t.ys);d(n,i.map((e,t)=>({transform:`translate(${e}px, ${a[t]}px)`})),t.seconds,t.offset),d(r,o.moteOpacity.at.map((e,n)=>({opacity:t.peak*o.moteOpacity.ofPeak[n],offset:e})),t.seconds,t.offset),d(r,o.moteScale.map(e=>({scale:String(e)})),t.seconds,t.offset)}}var p={table:[[0,24,.95],[1.2,20.6,.8],[2.4,17.4,.5],[3.4,14.7,.2],[4.4,12.2,0],[24,0,0]],gain:[.55,1],depth:[.75,1],blur:.3};function m(e,t,n,r,i,a,o){let s=Math.round(n*a),c=Math.round(r*a);e.width=s,e.height=c;let l=t.getContext(`2d`).getImageData(0,0,s,c).data,u=e.getContext(`2d`),d=u.createImageData(s,c),f=d.data,p=n/2,m=r/2,h=o.table,g=h.length,_=(e,t,n)=>{let r=e*a-.5,i=t*a-.5,o=Math.floor(r),u=Math.floor(i),d=r-o,f=i-u;n[0]=n[1]=n[2]=n[3]=0;for(let e=0;e<2;e++)for(let t=0;t<2;t++){let r=o+t,i=u+e;if(r<0||i<0||r>=s||i>=c)continue;let a=(i*s+r)*4,p=(t?d:1-d)*(e?f:1-f),m=l[a+3]/255*p;n[0]+=l[a]*m,n[1]+=l[a+1]*m,n[2]+=l[a+2]*m,n[3]+=255*m}},v=[0,0,0,0];for(let e=0;e<c;e++)for(let t=0;t<s;t++){let n=(t+.5)/a-p,r=(e+.5)/a-m,c=Math.abs(n)-p+i,l=Math.abs(r)-m+i,u=Math.hypot(Math.max(c,0),Math.max(l,0))+Math.min(Math.max(c,l),0)-i;if(u>0)continue;let d=n<0?-1:1,y=r<0?-1:1,b,x;if(c>0&&l>0){let e=Math.hypot(c,l);b=c/e*d,x=l/e*y}else c>l?(b=d,x=0):(b=0,x=y);let ee=b*b,S=x*x,te=-u*(o.depth[0]*ee+o.depth[1]*S),ne=h[g-1][1],re=h[g-1][2];if(te<h[g-1][0]){for(let e=1;e<g;e++)if(te<=h[e][0]){let t=h[e][0]>h[e-1][0]?(te-h[e-1][0])/(h[e][0]-h[e-1][0]):0;ne=h[e-1][1]+(h[e][1]-h[e-1][1])*t,re=h[e-1][2]+(h[e][2]-h[e-1][2])*t;break}}if(re*=o.gain[0]*ee+o.gain[1]*S,re<=0||(_(n+p-b*ne,r+m-x*ne,v),v[3]<=0))continue;let ie=v[3]/255*re,ae=(e*s+t)*4;f[ae]=v[0]/v[3]*255,f[ae+1]=v[1]/v[3]*255,f[ae+2]=v[2]/v[3]*255,f[ae+3]=ie*255}u.putImageData(d,0,0)}var h={id:`liquid-glass`,status:`proposed`,purpose:`A clear, refractive glass surface for floating chrome: it bends, magnifies and lights what sits behind it.`,inputs:[`backdrop`,`shape (signed distance, continuous corners)`,`light angle`],notes:[`One parameter set, rendered per platform: WebGL (web, reference renderer), Metal layerEffect (iOS), AGSL RuntimeShader (Android).`,`Lengths are in points (CSS px). Shapes closer than merge distance melt into each other.`,`Parameter names and ranges were benchmarked against the Good Machines lab (goodmachines.ai/lab/liquid-glass). The renderer is our own.`],params:{refraction:{group:`Lens`,label:`Refraction`,unit:`px`,min:0,max:80,step:1,description:`How far the curved edge bends what sits behind it.`},bezel:{group:`Lens`,label:`Edge width`,unit:`px`,min:2,max:80,step:1,description:`Width of the rounded rim where the bending happens.`},magnify:{group:`Lens`,label:`Magnify`,unit:`×`,min:1,max:1.8,step:.01,description:`Zoom on what sits under the middle of the glass.`},dispersion:{group:`Lens`,label:`Dispersion`,unit:``,min:0,max:1,step:.01,description:`Splits colour at the rim, like a prism.`},blur:{group:`Surface`,label:`Blur`,unit:`px`,min:0,max:40,step:.5,description:`Softens what shows through the glass.`},frost:{group:`Surface`,label:`Frost`,unit:``,min:0,max:1,step:.01,description:`A milky haze that keeps content on the glass readable.`},vibrancy:{group:`Surface`,label:`Vibrancy`,unit:`×`,min:0,max:2,step:.01,description:`Colour saturation of what shows through.`},brightness:{group:`Surface`,label:`Brightness`,unit:``,min:-.3,max:.3,step:.01,description:`Lifts or lowers what shows through.`},dim:{group:`Surface`,label:`Dim around glass`,unit:``,min:0,max:.6,step:.01,description:`A dark scrim around the glass, so clear glass stays readable on bright images.`},pickup:{group:`Tint`,label:`Colour from below`,unit:``,min:0,max:1,step:.01,description:`The glass takes on the average colour of what is under it.`},specular:{group:`Light`,label:`Rim light`,unit:``,min:0,max:1.5,step:.01,description:`The bright line where light catches the edge.`},rimWidth:{group:`Light`,label:`Rim width`,unit:`px`,min:.3,max:12,step:.1,description:`Thickness of the rim light.`},lightAngle:{group:`Light`,label:`Light angle`,unit:`°`,min:-180,max:180,step:1,description:`Where the light comes from. −135° is the upper left.`},shadow:{group:`Light`,label:`Shadow`,unit:``,min:0,max:1,step:.01,description:`Soft contact shadow under the glass.`},merge:{group:`Shape`,label:`Merge distance`,unit:`px`,min:0,max:60,step:1,description:`Shapes closer than this melt into each other.`},smoothing:{group:`Shape`,label:`Corner smoothing`,unit:``,min:0,max:1,step:.01,description:`Continuous (squircle) corners. The system rule is 0.6 on every rounded layer.`}},appearance:{options:[`auto`,`light`,`dark`],description:`Auto picks light or dark content on each shape from the brightness underneath.`},presets:{"thick-lens":{status:`proposed`,label:`Thick lens`,description:`A deep, clear lens with a wide rim. It magnifies the middle and folds the image hard at the edge.`,values:{refraction:46,bezel:44,magnify:1.28,dispersion:.12,blur:0,frost:0,vibrancy:1.05,brightness:.02,dim:0,pickup:0,specular:.8,rimWidth:2.2,lightAngle:-135,shadow:.45,merge:24,smoothing:.6},appearance:`auto`},apple:{status:`proposed`,label:`Apple Liquid Glass`,description:`Apple's regular Liquid Glass: a thin refracting rim, a soft blur and a hint of the colour underneath. For bars and controls over any content.`,source:`Values from the Good Machines lab's remake of Apple's regular glass (Apple HIG and WWDC25 "Meet Liquid Glass"); not Apple's code.`,values:{refraction:18,bezel:20,magnify:1,dispersion:.04,blur:6,frost:.1,vibrancy:1.35,brightness:.02,dim:0,pickup:.35,specular:.7,rimWidth:1.4,lightAngle:-135,shadow:.3,merge:10,smoothing:.6},appearance:`auto`}}},g=h.params,_=h.presets,v=[`for-you`,`switch-right`,`notification`],y={"for-you":{label:`For You`,group:`small`,size:`110 × 48`},"switch-right":{label:`Map switch`,group:`small`,size:`60 × 48`},notification:{label:`Notification`,group:`large`,size:`214 to 291 × 64`}},b=[{id:`all`,label:`All glass`,ids:[...v]},{id:`small`,label:`Small pills`,ids:v.filter(e=>y[e].group===`small`)},{id:`large`,label:`Large pills`,ids:v.filter(e=>y[e].group===`large`)}],x={opacity:.4,blur:30,y:20,spread:-15},ee={opacity:{label:`Strength`,unit:``,min:0,max:1,step:.01,description:`How dark the shadow is. 1 is solid black.`},blur:{label:`Softness`,unit:`px`,min:0,max:120,step:1,description:`How far the shadow spreads out as it fades.`},y:{label:`Distance`,unit:`px`,min:0,max:80,step:1,description:`How far below the glass the shadow falls.`},spread:{label:`Size`,unit:`px`,min:-40,max:40,step:1,description:`Grows or shrinks the shadow before it is softened. Negative keeps it tucked under the glass.`}},S={strength:1,cap:.55,depth:1,reach:1,blur:.3},te={strength:{label:`Strength`,unit:`×`,min:0,max:2,step:.05,description:`How bright the reflected icon is. 0 turns the reflection off.`},cap:{label:`Round end`,unit:`×`,min:0,max:1.5,step:.05,description:`Brightness of the arc wrapped around the pill's round end, next to the icon. 0 leaves only the top and bottom rims.`},depth:{label:`Depth`,unit:`×`,min:.25,max:4,step:.05,description:`How far in from the edge the reflection reaches before it fades out.`},reach:{label:`Stretch`,unit:`×`,min:.5,max:1.5,step:.01,description:`How far across the pill the glass looks for the icon. Lower pulls the copy apart, higher squeezes it toward the rim.`},blur:{label:`Softness`,unit:`px`,min:0,max:3,step:.1,description:`Blurs the reflection.`}},ne=`apple`;function re(e,t){for(let n of v){let r=t?.[n];if(r){r.presetId&&_[r.presetId]&&(e[n].presetId=r.presetId),(r.appearance===`light`||r.appearance===`dark`)&&(e[n].appearance=r.appearance),typeof r.chrome==`number`&&(e[n].chrome=r.chrome);for(let t of Object.keys(g)){let i=r.params?.[t];typeof i==`number`&&(e[n].params[t]=i)}for(let t of Object.keys(ee)){let i=r.shadow?.[t];typeof i==`number`&&(e[n].shadow[t]=i)}for(let t of Object.keys(te)){let i=r.reflection?.[t];typeof i==`number`&&(e[n].reflection[t]=i)}}}return e}var ie=()=>({presetId:ne,params:{..._[ne].values,shadow:0},appearance:`dark`,chrome:1,shadow:{...x},reflection:{...S}}),ae=()=>Object.fromEntries(v.map(e=>[e,ie()])),oe=`discover-glass-v2`;function se(){try{let e=localStorage.getItem(oe);return e?JSON.parse(e):null}catch{return null}}var ce=se(),C=re(re(ae(),await s(`glass`)??{}),ce??{});function w(){try{localStorage.setItem(oe,JSON.stringify(C))}catch{}}function le(e){for(let t of e)C[t]=ie();w()}var T=class{response;damping;value;target;velocity=0;constructor(e,t=.42,n=1){this.response=t,this.damping=n,this.value=e,this.target=e}step(e){if(this.settled){this.value=this.target,this.velocity=0;return}let t=(2*Math.PI/this.response)**2,n=4*Math.PI*this.damping/this.response,r=Math.max(1,Math.ceil(e*480)),i=e/r;for(let e=0;e<r;e++)this.velocity+=(-t*(this.value-this.target)-n*this.velocity)*i,this.value+=this.velocity*i}get settled(){return Math.abs(this.value-this.target)<.001&&Math.abs(this.velocity)<.01}snap(e){this.value=e,this.target=e,this.velocity=0}},ue=(e,t)=>Math.sign(e)*(1-1/(Math.abs(e)*.55/t+1))*t,E=(e,t,n)=>Math.min(n,Math.max(t,e)),de=(e,t,n)=>e+(t-e)*n,D=o,fe=.45,pe=.18,me=.11,he=.8,ge=1.25,_e=.94,ve={size:16,seed:3,motes:5,scatter:2},ye=class{overlay;hooks;els=new Map;switches=new Map;time=0;pick=!1;reflection=null;notificationHost;tabbar;constructor(e,t){this.overlay=e,this.hooks=t,e.innerHTML=`
      <div class="status">
        <div class="time">9:41</div>
        <div class="island"></div>
        <div class="levels">
          <img src="${D}status-cellular.svg" width="19.2" height="12.226" alt="">
          <img src="${D}status-wifi.svg" width="17.142" height="12.328" alt="">
          <img src="${D}status-battery.svg" width="27.328" height="13" alt="">
        </div>
      </div>
      <div class="island-cutout" aria-hidden="true"></div>
      <div class="tabbar" id="tabbar">
        <button class="tab" aria-label="Browse"><img src="${D}tab-browse.svg" width="24" height="24" alt=""></button>
        <button class="tab" aria-label="Taps"><img src="${D}tab-taps.svg" width="24" height="24" alt=""></button>
        <button class="tab messages" aria-label="Messages"><img class="flip" src="${D}tab-messages.svg" width="24" height="24" alt=""><i class="unread"></i></button>
        <span class="badge"></span>
      </div>
      <div class="home-indicator"><i></i></div>
      <div id="notifHost"></div>
      <button class="glass g-foryou" data-glass="for-you" aria-label="For You">
        <span class="content"><span id="forYouStar"></span><span class="label">For You</span></span>
      </button>
      <button class="glass g-switch" data-glass="switch-right" aria-label="Switch grid and map">
        <span class="content">
          <img class="dot" src="${D}switch-dot.svg" width="6" height="6" alt="">
          <span class="glyph arrow"><img class="ico" src="${D}navigation-20.svg" width="20" height="20" alt=""></span>
          <span class="glyph grid"><img class="ico" src="${D}icon-grid.svg" width="20" height="20" alt=""></span>
        </span>
      </button>`,f(e.querySelector(`#forYouStar`),`${D}sparkle.svg`,ve.size,ve.seed,ve.motes,ve.scatter),this.notificationHost=e.querySelector(`#notifHost`),this.tabbar=e.querySelector(`#tabbar`);let n=(t,n,r,i,a,o=!1)=>{let s=e.querySelector(`[data-glass="${t}"]`);s.style.width=`${i}px`,s.style.height=`${a}px`,this.els.set(t,{id:t,el:s,x:n,y:r,w:i,h:a,vis:new T(1,.35,1),press:new T(1,.25,1),layered:o})};n(`for-you`,201,78,110,48),n(`switch-right`,352,747,60,48,!0);for(let[e,t]of[[`switch-right`,0]]){let n=this.els.get(e).el;this.switches.set(e,{mode:t,travel:new T(t,fe,1),arrow:new T(+!t,fe,1),grid:new T(+!!t,fe,1),pendingIn:null,dot:n.querySelector(`.dot`),arrowEl:n.querySelector(`.arrow`),gridEl:n.querySelector(`.grid`)})}for(let e of this.els.values())this.bindPress(e);this.update(0),this.addForYouReflection()}async addForYouReflection(){let e=this.els.get(`for-you`),t=e.el.querySelector(`#forYouStar`),n=new Image;n.src=`${D}sparkle.svg`,await Promise.all([n.decode(),document.fonts.ready]);let r=t.offsetWidth,i=document.createElement(`canvas`);i.width=e.w*3,i.height=e.h*3;let a=i.getContext(`2d`);a.scale(3,3),a.drawImage(n,t.offsetLeft,t.offsetTop,r,r);let o=document.createElement(`canvas`);o.className=`self-lens`,this.reflection={content:i,lens:o},this.refreshReflection(),e.el.insertBefore(o,e.el.firstChild)}refreshReflection(){if(!this.reflection)return;let e=this.els.get(`for-you`),t=C[`for-you`].reflection,{content:n,lens:r}=this.reflection;m(r,n,e.w,e.h,e.h/2,n.width/e.w,{table:p.table.map(([e,n,r])=>[e*t.depth,n*t.reach,r*t.strength]),gain:[t.cap,p.gain[1]],depth:p.depth,blur:t.blur}),r.style.filter=t.blur>0?`blur(${t.blur}px)`:`none`}bindPress(e){let t=e.el,n=!1;t.addEventListener(`pointerdown`,r=>{r.stopPropagation(),this.pick?this.hooks.onPick(e.id,r.shiftKey||r.metaKey):(n=!0,t.setPointerCapture(r.pointerId),e.press.target=_e)});let r=(r,i)=>{if(!n)return;n=!1,e.press.target=1;let a=t.getBoundingClientRect(),o=r.clientX>=a.left&&r.clientX<=a.right&&r.clientY>=a.top&&r.clientY<=a.bottom;i&&o&&this.switches.has(e.id)&&this.toggleSwitch(e.id)};t.addEventListener(`pointerup`,e=>r(e,!0)),t.addEventListener(`pointercancel`,e=>r(e,!1))}toggleSwitch(e){let t=this.switches.get(e);t.mode=+!t.mode,t.travel.target=t.mode;let[n,r]=t.mode?[t.arrow,t.grid]:[t.grid,t.arrow];n.response=pe,n.target=0,t.pendingIn={spring:r,at:this.time+me}}get mapSwitch(){let e=this.els.get(`switch-right`);return{el:e.el,x:e.x,y:e.y,w:e.w,h:e.h,scale:()=>e.press.value}}setPick(e){this.pick=e,this.overlay.classList.toggle(`picking`,e)}setSelection(e){for(let t of this.els.values())t.el.classList.toggle(`picked`,e.has(t.id))}update(e){this.time+=e;for(let t of this.els.values()){t.vis.step(e),t.press.step(e);let n=E(t.vis.value,0,1),r=n*t.press.value,i=E((n-.3)/.7,0,1),a=t.el.style;t.layered||(a.transform=`translate(${t.x-t.w/2}px, ${t.y-t.h/2}px) scale(${r})`);let o=C[t.id].shadow;a.setProperty(`--chrome`,String(C[t.id].chrome*i)),a.setProperty(`--sh-a`,String(o.opacity*i)),a.setProperty(`--sh-y`,`${o.y}px`),a.setProperty(`--sh-blur`,`${o.blur}px`),a.setProperty(`--sh-spread`,`${o.spread}px`),a.setProperty(`--content`,String(i)),t.layered||(a.pointerEvents=t.vis.target>.5?`auto`:`none`),t.el.classList.toggle(`on-light`,C[t.id].appearance===`light`)}for(let t of this.switches.values()){t.pendingIn&&this.time>=t.pendingIn.at&&(t.pendingIn.spring.response=fe,t.pendingIn.spring.target=1,t.pendingIn=null),t.travel.step(e),t.arrow.step(e),t.grid.step(e);let n=t.travel.value,r=1+.25*Math.sin(Math.PI*E(n,0,1));t.dot.style.transform=`translate(${de(41,15,n)-3}px, 21px) scaleX(${r})`;let i=de(22,34,n),a=(e,t)=>{let n=E(t,0,1);e.style.opacity=String(n),e.style.transform=`translate(${i-10}px, 14px) scale(${de(he,1,n)})`};a(t.arrowEl,t.arrow.value),a(t.gridEl,t.grid.value)}}shapes(){let e=[];for(let t of this.els.values()){if(t.layered)continue;let n=E(t.vis.value,0,1)*t.press.value;n<.03||e.push({id:t.id,kind:`capsule`,x:t.x,y:t.y,w:t.w*n,h:t.h*n})}return e}},O=o,k=[{name:`Sophie, 27`,online:!1,distance:`420 ft`,intent:`Dates`,heart:`outline`,status:`Too cool`,photos:[{src:O+`sophie-1.jpg`,crop:{w:123.83,h:155.55,left:-2.59,top:-16.79}},{src:O+`sophie-3.jpg`,crop:{w:113.47,h:142.54,left:-1.3,top:-32.26}},{src:O+`sophie-2.jpg`}]},{name:`Emma, 24`,online:!1,distance:`650 ft`,intent:`Casual`,heart:`outline`,status:`Free tonight`,photos:[{src:O+`emma.jpg`}]},{name:`Lily ☀️, 26`,online:!0,distance:`0.4 mi`,intent:`Friends first`,heart:`outline`,status:`Drinks?`,photos:[{src:O+`lily.jpg`}]},{name:`Monique, 29`,online:!0,distance:`0.2 mi`,intent:`Relationship`,heart:`outline`,status:`I play big tennis`,photos:[{src:O+`monique.jpg`}]},{name:`Zara, 31`,online:!0,distance:`0.8 mi`,intent:`Dates`,heart:`outline`,status:`Drinks?`,photos:[{src:O+`zara.jpg`}]}],A=[{id:`mila`,name:`Mila`,meta:` · 420 ft`,message:`Hi, you’re sexy 🔥`,avatar:O+`avatar-mila.png`,width:214},{id:`cindy`,name:`Cindy 🌸`,meta:` · 1.6 mi`,message:`Shared an album`,avatar:O+`avatar-cindy.png`,width:250,accessory:{kind:`album`,src:O+`album-cindy.jpg`,blur:0,box:{x:-8,y:-9,w:44,h:51},crop:{w:139.75,h:159.71,left:-17.72,top:-59.52}}},{id:`nina`,name:`Nina `,meta:` · 1.2 mi`,message:`Sent a private photo`,avatar:O+`avatar-nina.png`,width:275,accessory:{kind:`album`,src:O+`album-nina.jpg`,blur:2,box:{x:-2,y:0,w:36,h:42},crop:{w:187.24,h:213.99,left:-48.21,top:-114.29}}},{id:`amara`,name:`Amara`,meta:` · 920 ft`,message:`Meet ya at the bar`,avatar:O+`avatar-amara.png`,width:291,accessory:{kind:`map`}}],j=[`y`,`scale`,`opacity`,`blur`],M={y:{label:`Move`,unit:`pt`,min:-120,max:120,step:1,rest:0},scale:{label:`Scale`,unit:`×`,min:.4,max:1.2,step:.01,rest:1},opacity:{label:`Fade`,unit:``,min:0,max:1,step:.01,rest:1},blur:{label:`Blur`,unit:`pt`,min:0,max:40,step:1,rest:0}},be=[{id:`spring`,label:`Spring`,ease:{type:`spring`,bounce:0}},{id:`out`,label:`Ease out`,ease:{type:`bezier`,p:[0,0,.58,1]}},{id:`in`,label:`Ease in`,ease:{type:`bezier`,p:[.42,0,1,1]}},{id:`inout`,label:`In and out`,ease:{type:`bezier`,p:[.42,0,.58,1]}},{id:`linear`,label:`Linear`,ease:{type:`bezier`,p:[0,0,1,1]}},{id:`page`,label:`Page`,ease:{type:`bezier`,p:[.41,0,.19,1.02]}}],xe=e=>structuredClone(be.find(t=>t.id===e).ease),Se=[{id:`arrive`,label:`Arrives`,hint:`A notification comes up from under the grid edge.`},{id:`recede`,label:`Goes back`,hint:`The one being replaced steps back while the next arrives.`},{id:`leave`,label:`Leaves`,hint:`The last notification goes away.`}],N=(e,t,n=`spring`)=>({t:e,v:t,ease:xe(n)}),Ce=()=>({arrive:{duration:450,tracks:{y:[N(0,48),N(450,0)],scale:[N(0,.92),N(450,1)],opacity:[N(0,0),N(180,1,`out`)],blur:[N(0,0),N(450,0)]}},recede:{duration:180,tracks:{y:[N(0,0),N(180,-40,`out`)],scale:[N(0,1),N(180,.76,`out`)],opacity:[N(30,1),N(180,0,`linear`)],blur:[N(0,0),N(180,16,`out`)]}},leave:{duration:120,tracks:{y:[N(0,0),N(120,40,`inout`)],scale:[N(0,1),N(120,1)],opacity:[N(0,1),N(120,0,`out`)],blur:[N(0,0),N(120,0)]}},hold:1300,stagger:0,dim:.375});function we(e,t){let[n,r,i,a]=e,o=(e,t,n)=>3*(1-e)*(1-e)*e*t+3*(1-e)*e*e*n+e*e*e,s=0,c=1,l=t;for(let e=0;e<30;e++){let e=o(l,n,i);if(Math.abs(e-t)<1e-5)break;e<t?s=l:c=l,l=(s+c)/2}return o(l,r,a)}function Te(e,t){let n=Math.min(1,Math.max(.15,1-e)),r=e=>{if(n>=1)return 1-(1+9*e)*Math.exp(-9*e);let t=9*Math.sqrt(1-n*n);return 1-Math.exp(-n*9*e)*(Math.cos(t*e)+n*9/t*Math.sin(t*e))};return r(t)/r(1)}var Ee=(e,t)=>t<=0?0:t>=1?1:e.type===`spring`?Te(e.bounce,t):we(e.p,t);function P(e,t){if(t<=e[0].t)return e[0].v;for(let n=1;n<e.length;n++){let r=e[n-1],i=e[n];if(t<=i.t)return r.v+(i.v-r.v)*Ee(i.ease,(t-r.t)/Math.max(i.t-r.t,1))}return e[e.length-1].v}var F=(e,t)=>({y:P(e.tracks.y,t),scale:P(e.tracks.scale,t),opacity:P(e.tracks.opacity,t),blur:P(e.tracks.blur,t)}),De=(e,t)=>({y:e.y+t.y,scale:e.scale*t.scale,opacity:e.opacity*t.opacity,blur:e.blur+t.blur}),Oe=(e,t)=>({duration:e,tracks:{y:[N(0,0),N(e,40,`inout`)],scale:[N(0,1),N(e,1)],opacity:[N(t,1),N(e,0,`out`)],blur:[N(0,0),N(e,0)]}}),ke=[Oe(330,120),Oe(220,40)].map(e=>JSON.stringify(e)),Ae=`discover-motion-v2`;function je(e){let t=e;return!!t&&typeof t.hold==`number`&&typeof t.stagger==`number`&&[`arrive`,`recede`,`leave`].every(e=>t[e]&&typeof t[e].duration==`number`&&j.every(n=>Array.isArray(t[e].tracks?.[n])&&t[e].tracks[n].length>0))}function Me(){try{return JSON.parse(localStorage.getItem(Ae)??`null`)}catch{return null}}var Ne=Me(),Pe=await s(`motion`);function Fe(){let e={...Ce(),...je(Pe)?Pe:{},...je(Ne)?Ne:{}};return e.dim===.5&&(e.dim=Ce().dim),ke.includes(JSON.stringify(e.leave))&&(e.leave=Ce().leave),e}var I=Fe();function Ie(){try{localStorage.setItem(Ae,JSON.stringify(I))}catch{}}function Le(){Object.assign(I,Ce()),Ie()}var Re=`#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }`,ze=`#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uSize;     // px
uniform float uTop;     // sigma at the top row, px
uniform float uBottom;  // sigma at row uRange, px
uniform float uRange;   // px
const int TAPS = 32;
void main() {
  vec2 p = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y);
  float sigma = mix(uTop, uBottom, clamp(p.y / uRange, 0.0, 1.0));
  // Explicit mip level: inside a branch the automatic one is undefined and can read a blurred mip,
  // which bled the card's top edge into a bright hairline above it.
  if (sigma < 0.35) { outColor = textureLod(uTex, p / uSize, 0.0); return; }
  float lod = max(log2(sigma * 0.5), 0.0);
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int i = 0; i < TAPS; i++) {
    float f = (float(i) + 0.5) / float(TAPS);
    float r = sqrt(f) * 2.0 * sigma;
    float a = float(i) * 2.39996323;
    float w = exp(-0.5 * (r * r) / (sigma * sigma));
    acc += textureLod(uTex, (p + vec2(cos(a), sin(a)) * r) / uSize, lod) * w;
    wsum += w;
  }
  outColor = acc / wsum;
}`,Be=class{canvas=document.createElement(`canvas`);gl;loc={};constructor(){let e=this.canvas.getContext(`webgl2`,{antialias:!1,premultipliedAlpha:!0,preserveDrawingBuffer:!0});if(!e)throw Error(`WebGL2 is not available in this browser.`);this.gl=e;let t=(t,n)=>{let r=e.createShader(t);if(e.shaderSource(r,n),e.compileShader(r),!e.getShaderParameter(r,e.COMPILE_STATUS))throw Error(e.getShaderInfoLog(r)??`shader compile failed`);return r},n=e.createProgram();if(e.attachShader(n,t(e.VERTEX_SHADER,Re)),e.attachShader(n,t(e.FRAGMENT_SHADER,ze)),e.linkProgram(n),!e.getProgramParameter(n,e.LINK_STATUS))throw Error(e.getProgramInfoLog(n)??`link failed`);e.useProgram(n);for(let t of[`uTex`,`uSize`,`uTop`,`uBottom`,`uRange`])this.loc[t]=e.getUniformLocation(n,t);e.bindTexture(e.TEXTURE_2D,e.createTexture()),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR_MIPMAP_LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.pixelStorei(e.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!0)}render(e,t,n,r){let i=this.gl,a=e.width,o=e.height;return(this.canvas.width!==a||this.canvas.height!==o)&&(this.canvas.width=a,this.canvas.height=o),i.viewport(0,0,a,o),i.texImage2D(i.TEXTURE_2D,0,i.RGBA,i.RGBA,i.UNSIGNED_BYTE,e),i.generateMipmap(i.TEXTURE_2D),i.uniform1i(this.loc.uTex,0),i.uniform2f(this.loc.uSize,a,o),i.uniform1f(this.loc.uTop,t),i.uniform1f(this.loc.uBottom,n),i.uniform1f(this.loc.uRange,Math.max(r,1)),i.drawArrays(i.TRIANGLES,0,3),this.canvas}},L={w:402,h:874},R={x:8,top:117,w:386,h:546,r:32,gap:24},z=R.h+R.gap,Ve=782,He=`#f0f1f3`,Ue=`system-ui, -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif`,We=e=>new Promise((t,n)=>{let r=new Image;r.onload=()=>t(r),r.onerror=()=>n(Error(`Could not load ${e}`)),r.src=e}),Ge=[1.52866483,1.08849296,.86840694,.63149379,.07491139,.37282383,.16905956];function Ke(e,t,n,r,i,a){let[o,s,c,l,u,d,f]=Ge.map(e=>e*a),p=t+r,m=n+i;e.moveTo(t+o,n),e.lineTo(p-o,n),e.bezierCurveTo(p-s,n,p-c,n,p-l,n+u),e.bezierCurveTo(p-d,n+f,p-f,n+d,p-u,n+l),e.bezierCurveTo(p,n+c,p,n+s,p,n+o),e.lineTo(p,m-o),e.bezierCurveTo(p,m-s,p,m-c,p-u,m-l),e.bezierCurveTo(p-f,m-d,p-d,m-f,p-l,m-u),e.bezierCurveTo(p-c,m,p-s,m,p-o,m),e.lineTo(t+o,m),e.bezierCurveTo(t+s,m,t+c,m,t+l,m-u),e.bezierCurveTo(t+d,m-f,t+f,m-d,t+u,m-l),e.bezierCurveTo(t,m-c,t,m-s,t,m-o),e.lineTo(t,n+o),e.bezierCurveTo(t,n+s,t,n+c,t+u,n+l),e.bezierCurveTo(t+f,n+d,t+d,n+f,t+l,n+u),e.bezierCurveTo(t+c,n,t+s,n,t+o,n),e.closePath()}var qe=(e,t)=>{let n=document.createElement(`canvas`);return n.width=Math.round(e),n.height=Math.round(t),n},Je=class{canvas=document.createElement(`canvas`);ctx=this.canvas.getContext(`2d`,{alpha:!1});scale=0;photos=new Map;icons={};baked=[];blur=new Be;async load(){let e=[...new Set(k.flatMap(e=>e.photos.map(e=>e.src)))],[t,n,r,i]=await Promise.all([Promise.all(e.map(We)),We(`${o}navigation-12.svg`),We(`${o}heart-a.svg`),We(`${o}heart-b.svg`)]);e.forEach((e,n)=>this.photos.set(e,t[n])),this.icons={location:n,heartFilled:r,heartOutline:i}}setScale(e){e!==this.scale&&(this.scale=e,this.canvas.width=Math.round(L.w*e),this.canvas.height=Math.round(L.h*e),this.baked=k.map(e=>({photos:e.photos.map(e=>this.bakePhoto(e)),info:this.bakeInfo(e)})))}bakePhoto(e){let t=this.scale,{w:n,h:r}=R,i=qe(n*t,r*t),a=i.getContext(`2d`);a.scale(t,t),a.imageSmoothingQuality=`high`;let o=this.photos.get(e.src);if(e.crop){let t=e.crop;a.drawImage(o,t.left/100*n,t.top/100*r,t.w/100*n,t.h/100*r)}else{let e=Math.max(n/o.naturalWidth,r/o.naturalHeight),t=o.naturalWidth*e,i=o.naturalHeight*e;a.drawImage(o,(n-t)/2,(r-i)/2,t,i)}let s=Math.round((r-96)*t),c=i.height-s,l=qe(i.width,c);l.getContext(`2d`).drawImage(i,0,s,i.width,c,0,0,i.width,c);let u=this.blur.render(l,0,1.5*t,c);a.save(),a.setTransform(1,0,0,1,0,0),a.drawImage(u,0,s),a.restore();let d=a.createLinearGradient(0,r,0,r-96);return d.addColorStop(0,`rgba(0,0,0,0.75)`),d.addColorStop(1,`rgba(0,0,0,0.01)`),a.fillStyle=d,a.fillRect(0,r-96,n,96),i}bakeInfo(e){let t=this.scale,n=qe(R.w*t,R.h*t),r=n.getContext(`2d`);r.scale(t,t),r.fillStyle=He,r.textBaseline=`alphabetic`;let i=24;e.online&&(r.beginPath(),r.arc(i+4,482,4,0,Math.PI*2),r.fill(),i+=16),r.font=`545 24px ${Ue}`,r.letterSpacing=`0.07px`,r.fillText(e.name,i,490),r.font=`500 14px ${Ue}`,r.letterSpacing=`0.15px`,i=24;let a=(e,t)=>{e&&(r.drawImage(e,i,510,12,12),i+=20),r.fillText(t,i,521),i+=r.measureText(t).width+16};return a(this.icons.location,e.distance),a(e.heart===`filled`?this.icons.heartFilled:this.icons.heartOutline,e.intent),r.fillStyle=`rgba(255,255,255,0.2)`,r.fillRect(i,510,1,12),i+=16,r.fillStyle=He,a(null,e.status),n}topCopy=document.createElement(`canvas`);topBlur(e){let t=this.ctx,n=this.scale,r=R.top;if(!this.baked.some((t,n)=>{let i=R.top+n*z-e;return i<r&&i+R.h>0}))return;let i=this.canvas.width,a=Math.round((r+24)*n),o=Math.round(r*n);(this.topCopy.width!==i||this.topCopy.height!==a)&&(this.topCopy.width=i,this.topCopy.height=a),this.topCopy.getContext(`2d`).drawImage(this.canvas,0,0,i,a,0,0,i,a);let s=this.blur.render(this.topCopy,12*n,0,o);t.save(),t.setTransform(1,0,0,1,0,0),t.drawImage(s,0,0,i,o,0,0,i,o),t.restore()}draw(e,t,n=0){let r=this.ctx,i=this.scale;if(r.setTransform(i,0,0,i,0,0),r.globalAlpha=1,r.fillStyle=`#000`,r.fillRect(0,0,L.w,L.h),r.save(),r.beginPath(),Ke(r,R.x,-2e3,R.w,2782,R.r),r.clip(),this.baked.forEach((n,i)=>{let a=R.top+i*z-e;if(a>Ve||a+R.h<0)return;let o=t[i];if(r.save(),r.beginPath(),Ke(r,R.x,a,R.w,R.h,R.r),r.clip(),o.next>=0){let e=o.fade*R.w*o.dir;r.drawImage(n.photos[o.photo],R.x-e,a,R.w,R.h),r.drawImage(n.photos[o.next],R.x+R.w*o.dir-e,a,R.w,R.h)}else r.drawImage(n.photos[o.photo],R.x,a,R.w,R.h);r.restore(),r.drawImage(n.info,R.x,a,R.w,R.h),o.timer>=0&&(r.save(),r.beginPath(),r.roundRect(R.x+161,a+24,64,1.5,1),r.clip(),r.fillStyle=`rgba(255,255,255,0.1)`,r.fillRect(R.x+161,a+24,64,1.5),r.fillStyle=`#d9d9d9`,r.fillRect(R.x+161,a+24,64*o.timer,1.5),r.restore())}),r.restore(),this.topBlur(e),n>.001){let e=r.createLinearGradient(0,655,0,687);e.addColorStop(0,`rgba(0,0,0,0)`),e.addColorStop(1,`rgba(0,0,0,${n})`),r.fillStyle=e,r.fillRect(0,655,L.w,127)}let a=r.createLinearGradient(0,0,0,140);a.addColorStop(0,`#000`),a.addColorStop(.5,`rgba(0,0,0,0.55)`),a.addColorStop(1,`rgba(0,0,0,0)`),r.fillStyle=a,r.fillRect(0,0,L.w,140),a=r.createLinearGradient(0,L.h-280,0,L.h),a.addColorStop(0,`rgba(0,0,0,0)`),a.addColorStop(.7,`rgba(0,0,0,0.75)`),a.addColorStop(1,`#000`),r.fillStyle=a,r.fillRect(0,L.h-280,L.w,280),r.fillStyle=`#000`,r.fillRect(0,L.h-91,L.w,91)}},B=60,V=3,H=e=>+e.toFixed(2),Ye=e=>+e.toFixed(3),Xe=e=>H(e/1e3*B),Ze={files:[{name:`Grindr Case`,key:`YSxvNgWT1CeXLhLLtGgA1g`,url:`https://www.figma.com/design/YSxvNgWT1CeXLhLLtGgA1g/Grindr-Case?node-id=1451-27125`,role:`The screens (section "Section 1", node 1451:27125)`},{name:`Visual system test`,key:`DZyg8YAMxSL5GCxHoQcJwE`,url:`https://www.figma.com/design/DZyg8YAMxSL5GCxHoQcJwE/Visual-system-test?node-id=11-478`,role:`The design system (styles, tokens, components)`}],layers:[{layer:`Screen`,figma:`Home · Discover`,node:`1441:23520`,note:`Base frame, 402 × 874. Has two map switches; production keeps only the right one.`},{layer:`Card stack`,figma:`Grid`,node:`1451:26403`,note:`Five profile-card instances, 386 × 546, 24 apart, radius 32 (continuous corners).`},{layer:`Card photo 2 / 3 (Sophie)`,figma:`profile-card`,node:`1451:25772 and 1450:25711`,note:`The photos the slider pushes through.`},{layer:`Photo timer`,figma:`Progress/Timer`,node:`695:15107`,note:`64 × 1.5 track, centred, 24 from the card top.`},{layer:`Top fade`,figma:`Overlay/Fade · Top`,node:`1441:23873`,note:`140 tall. Carries a progressive blur in production.`},{layer:`Bottom fade`,figma:`Overlay/Fade (Photo)`,node:`1441:23809`,note:`Bottom 280.`},{layer:`Tab area`,figma:`Overlay/Fade · Tab area`,node:`1441:23810`,note:`Solid black, bottom 91.`},{layer:`For You pill`,figma:`button`,node:`1441:23820`,note:`Glass/Chrome, 110 × 48 at centre (201, 78). Label is "For You" in production.`},{layer:`Map switch`,figma:`Button/Map switch`,node:`1441:23818 (component 695:15058)`,note:`Glass/Chrome, 60 × 48 at centre (352, 747).`},{layer:`Notification: Mila`,figma:`Notification/Message`,node:`1447:24626`,note:`214 × 64.`},{layer:`Notification: Cindy`,figma:`Notification/Message`,node:`1444:24227`,note:`250 × 64, album thumbnail.`},{layer:`Notification: Nina`,figma:`Notification/Message`,node:`1447:24993`,note:`275 × 64, blurred private photo.`},{layer:`Notification: Amara`,figma:`Notification/Message`,node:`1447:25368`,note:`291 × 64, Map chip.`},{layer:`Tab bar`,figma:`Navigation/Tab bar`,node:`1441:23811 and 1444:24167`,note:`Second node has the unread count (Label/Tile 695:15093).`}]};function Qe(e){return e.type===`spring`?e.bounce?`spring, bounce ${e.bounce}`:`spring, no bounce`:`cubic-bezier(${e.p.join(`, `)})`}function $e(e,t){if(t.ease.type!==`bezier`)return null;let[n,r,i,a]=t.ease.p,o=(t.v-e.v)/Math.max((t.t-e.t)/1e3,1e-6);return{out:{influence:H(Math.max(n,.001)*100),speed:Ye(n>0?r/n*o:0)},in:{influence:H(Math.max(1-i,.001)*100),speed:Ye(i<1?o*((1-a)/(1-i)):0)}}}var et=(e,t)=>Array.from({length:Math.round(t/1e3*B)+1},(t,n)=>Ye(P(e,n/B*1e3)));function tt(e,t){let n=new T(0,e,t),r=[0];n.target=1;for(let e=0;e<180&&!n.settled;e++)n.step(1/B),r.push(Ye(n.value));return r}function nt(e){let t=A.length,n=e=>e*I.hold+(e>0?I.stagger:0),r=e=>(e+1)*I.hold,i=Object.fromEntries(Se.map(e=>{let t=I[e.id];return[e.id,{label:e.label,meaning:e.hint,durationMs:t.duration,durationFrames:Xe(t.duration),tracks:Object.fromEntries(j.map(e=>[e,t.tracks[e].map((e,t,n)=>({timeMs:e.t,frame:Xe(e.t),value:e.v,ease:t===0?null:e.ease,afterEffects:t===0?null:$e(n[t-1],e)}))])),bakedPerFrame:Object.fromEntries(j.map(e=>[e,et(t.tracks[e],t.duration)]))}]})),a=u(e.star.size,e.star.seed,e.star.motes,e.star.scatter);return{meta:{name:`Discover: notifications, photo slider and glass controls`,generated:new Date().toISOString(),units:`Points (pt), milliseconds, top-left origin, y down. Multiply lengths by the comp scale for pixels.`,comp:{designSize:[L.w,L.h],scale:V,pixelSize:[L.w*V,L.h*V],fps:B}},figma:Ze,sequence:{holdMs:I.hold,staggerMs:I.stagger,loopGapMs:e.loopGap,unreadCountStartsAt:e.startCount,events:[...A.map((i,a)=>({layer:`Notification: ${i.name.trim()}`,width:i.width,height:64,restCentre:[201,735],arrivesAtMs:n(a),goesAtMs:r(a),goesWith:a<t-1?`recede`:`leave`,unreadCountShown:e.startCount-a})),{layer:`Map switch`,width:60,height:48,restCentre:[352,747],leavesAtMs:n(0),leavesWith:`leave`,returnsAtMs:r(t-1),returnsWith:`arrive`}],endsAtMs:r(t-1)+I.leave.duration},moments:i,composeRule:`A notification that goes while still arriving adds the two moves and blurs and multiplies the two scales and opacities.`,clip:{note:`Notifications and the map switch are clipped at the bottom edge of the card window, so they rise from behind it and sink behind it.`,y:782},switchBlur:`The map switch adds the "recede" Blur track to its own exit (stretched over the "leave" duration) and plays it backwards over its return (stretched over the "arrive" Fade track).`,dim:{amount:I.dim,rule:`Black veil under the notifications. Opacity = amount × (arrive Fade track of the first notification) × (leave Fade track of the last one). It holds at full while one notification replaces another.`,region:`From y 655 (0 %) ramping to full at y 687, then solid down to y 782, full width.`},unreadBadge:{appear:`With the first notification: Messages icon fades out (180 ms ease-out); badge fades in (180 ms ease-out) and scales 0.75 → 1 (450 ms, cubic-bezier(0.2, 0.9, 0.3, 1)).`,countChange:`On each new notification the digit rolls: old digit moves up 100 % of the badge and fades (300 ms cubic-bezier(0.3, 0.7, 0.2, 1), fade 200 ms ease-out); new digit comes from 100 % below on the same curve.`,end:`When the last notification starts leaving: badge moves by (10, −9), scales to 0.28 and fades out; the 8 pt unread dot fades in (180 ms) and scales 0.4 → 1 (450 ms, cubic-bezier(0.2, 0.9, 0.3, 1)); the icon fades back in.`},photoSlider:{secondsPerPhoto:e.photoSeconds,timerBar:`Fills left to right, linear, over each photo's time; 64 × 1.5, centred, 24 below the card top.`,change:`Push: the next photo enters from the right and pushes the current one off to the left, edge to edge, inside the card's rounded shape. Name, status row and timer do not move.`,spring:e.push,bakedPerFrame:tt(e.push.response,e.push.damping),travel:R.w},paging:{pitch:z,rule:`One swipe moves one profile. Release faster than ${e.paging.flick} pt/ms goes to the next or previous; otherwise the nearest. The previous card stays visible under the top fade.`,spring:{response:e.paging.response,damping:e.paging.damping},bakedPerFrame:tt(e.paging.response,e.paging.damping)},mapSwitchTap:{rule:`On tap the dot and the icon trade places. Dot centre x 41 ↔ 15, icon centre x 22 ↔ 34 (inside the 60 × 48 pill).`,travelSpring:{response:e.toggle.travel,damping:1},bakedPerFrame:tt(e.toggle.travel,1),dotStretch:`Dot stretches horizontally to ${e.toggle.dotStretch}× at mid-travel (sine).`,glyphs:`Old icon fades and scales to ${e.toggle.glyphScale} over ${e.toggle.glyphOut*1e3} ms; the new one starts ${e.toggle.glyphDelay*1e3} ms later and grows from ${e.toggle.glyphScale} to 1 on the travel spring.`,press:`Any glass control scales to ${e.toggle.press} while pressed (spring, response 0.25 s, no bounce).`},forYouStar:{note:`Loops forever. Each loop's values are evenly spaced keyframes joined by a smooth curve (Catmull-Rom); rotation is in radians. Motes are clipped to the pill.`,starBoxInPill:`The 16 × 16 star box sits left of the label, centred vertically in the 110 × 48 pill.`,...a,reflection:{...C[`for-you`].reflection,table:p.table,note:`Static mirrored copies of the star in the pill's rims. Rows are (depth inside the edge, how far inside the glass looks, brightness). Icon only, never the label.`}},glass:{note:`The glass is a custom shader; these are its parameters per element, for reference when matching the look. Lengths in pt.`,parameters:Object.fromEntries(Object.entries(g).map(([e,t])=>[e,`${t.label}: ${t.description}`])),elements:Object.fromEntries(v.map(e=>[e,{label:y[e].label,...C[e]}])),figmaShadow:x},progressiveBlurs:{topFade:`Background blur under the top fade: Figma radius 24 (gaussian sigma 12 pt) at y 0, falling linearly to 0 at y 117, where a card rests.`,cardBottomBar:`Each card's bottom 96 pt: background blur from 0 at the bar's top edge to Figma radius 3 (sigma 1.5 pt) at the card's bottom, under a black gradient 1 % → 75 %.`},springs:{formula:`A spring is given as response (seconds) and damping ratio. Stiffness = (2π / response)², damping = 4π × ratio / response, mass 1. Ratio 1 is critically damped: x(t) = 1 − (1 + ωt)·e^(−ωt), ω = 2π / response.`,keyframeSpringEase:`A "spring" ease between two keyframes is that curve fitted to the segment: f(u) = [1 − (1 + 9u)·e^(−9u)] / [1 − 10·e^(−9)], u from 0 to 1.`,sampleOfKeyframeSpringEase:Array.from({length:21},(e,t)=>Ye(Ee({type:`spring`,bounce:0},t/20)))}}}function rt(e,t){let n=I[e].tracks[t],r=M[t].unit===`pt`?` pt`:M[t].unit===`×`?`×`:``,i=n.map((e,t)=>{let i=t?$e(n[t-1],e):null,a=t===0?`start`:Qe(e.ease),o=t===0?``:i?`out ${i.out.influence} % at ${i.out.speed}/s, in ${i.in.influence} % at ${i.in.speed}/s`:`bake (see below)`;return`| ${e.t} | ${Xe(e.t)} | ${e.v}${r} | ${a} | ${o} |`});return[`**${M[t].label}** (${t})`,``,`| Time, ms | Frame @60 | Value | Ease into this keyframe | After Effects ease |`,`|---|---|---|---|---|`,...i,``].join(`
`)}function it(e){let t=nt(e),n=t.sequence.events;return`# Discover motion guide

Generated ${t.meta.generated} from the live prototype. Everything below is what is on screen now.

This file is for rebuilding the screen's motion in After Effects. It has three parts: how to set the project up, every animation with its keyframes and easing, and the same data as JSON at the end for tools.

## 1. Project set-up

- **Design size:** ${L.w} × ${L.h} pt. **Suggested comp:** ${L.w*V} × ${L.h*V} px (${V}×), ${B} fps. Multiply every length in this file by ${V} for pixels.
- **Coordinates:** origin top-left, y down, the same as After Effects. Positions are layer centres; scale and rotation are about the centre.
- **Times:** milliseconds, with the frame number at ${B} fps beside them.
- **Blur values** are gaussian sigma in points (what CSS \`blur()\` uses). At ${V}× that is sigma × ${V} px. After Effects' Gaussian Blur "Blurriness" is not sigma: start near 2.5 × the pixel sigma and match by eye against the prototype. This factor is an estimate, not measured.
- **Easing:** bezier eases are given as CSS cubic-bezier and as After Effects influence and speed (speed in value units per second; for Move, multiply by ${V} for px/s). "Spring" eases have no After Effects equivalent: use the per-frame values in the JSON (\`moments.*.bakedPerFrame\`) as baked keyframes, or the formula in section 9.

## 2. Figma sources

${t.figma.files.map(e=>`- **${e.name}** (file key \`${e.key}\`): ${e.role}. ${e.url}`).join(`
`)}

| Layer | Figma layer name | Node | Notes |
|---|---|---|---|
${t.figma.layers.map(e=>`| ${e.layer} | ${e.figma} | ${e.node} | ${e.note} |`).join(`
`)}

## 3. Notification sequence

One clock drives everything. Time 0 is the first notification starting to arrive. A new notification arrives every ${I.hold} ms${I.stagger?`, ${I.stagger} ms after the previous one starts going back`:``}. The sequence ends at ${t.sequence.endsAtMs} ms and repeats after ${e.loopGap} ms.

| Layer | Size | Rest centre | Starts arriving, ms | Starts going, ms | Goes with | Unread count |
|---|---|---|---|---|---|---|
${A.map((e,t)=>{let r=n[t];return`| ${e.name.trim()} | ${e.width} × 64 | 201, 735 | ${r.arrivesAtMs} | ${r.goesAtMs} | "${r.goesWith===`recede`?`Goes back`:`Leaves`}" | ${r.unreadCountShown} |`}).join(`
`)}
| Map switch | 60 × 48 | 352, 747 | returns at ${t.sequence.events[A.length]&&t.sequence.events[A.length].returnsAtMs} with "Arrives" | leaves at 0 with "Leaves" | | |

- ${t.composeRule}
- ${t.clip.note} The edge is at y ${t.clip.y}.
- ${t.switchBlur}

## 4. The three moments

Each notification is animated relative to its rest state (Move 0, Scale 1, Fade 100 %, Blur 0). Move is vertical, positive down.

${Se.map(e=>`### ${e.label} (\`${e.id}\`), ${I[e.id].duration} ms = ${Xe(I[e.id].duration)} frames

${e.hint}

${j.map(t=>rt(e.id,t)).join(`
`)}`).join(`
`)}

## 5. Dim under the notifications

- Amount: ${H(I.dim*100)} % black.
- ${t.dim.rule}
- Region: ${t.dim.region}

## 6. Unread count on the Messages tab

- ${t.unreadBadge.appear}
- ${t.unreadBadge.countChange}
- ${t.unreadBadge.end}
- The count starts at ${e.startCount} and drops by one with each notification.

## 7. Photo slider, paging and the map switch tap

- **Photo slider:** each photo shows for ${e.photoSeconds} s. ${t.photoSlider.timerBar} ${t.photoSlider.change} Spring: response ${e.push.response} s, damping ratio ${e.push.damping} (no bounce), travel ${R.w} pt. Per-frame values: \`photoSlider.bakedPerFrame\`.
- **Paging between profiles:** ${t.paging.rule} Page pitch ${z} pt. Spring: response ${e.paging.response} s, damping ratio ${e.paging.damping}. Per-frame values: \`paging.bakedPerFrame\`.
- **Map switch tap:** ${t.mapSwitchTap.rule} Travel spring: response ${e.toggle.travel} s, no bounce. ${t.mapSwitchTap.dotStretch} ${t.mapSwitchTap.glyphs}
- **Press:** ${t.mapSwitchTap.press}

## 8. For You star

${t.forYouStar.note} ${t.forYouStar.starBoxInPill} All loops start ${H(t.forYouStar.begin)} s into their cycle.

| Loop | Property | Keyframe values (evenly spaced) | Length, s |
|---|---|---|---|
${t.forYouStar.loops.map(e=>`| ${e.name} | ${e.property} (${e.unit}) | ${e.values.map(Ye).join(`, `)} | ${e.seconds} |`).join(`
`)}

Sparkles (${t.forYouStar.motes.length}): each follows its own path of five evenly spaced points (smooth curve) inside the star's 16 × 16 box coordinates, fading 0 → peak at 30 % → 80 % of peak at 65 % → 0, and scaling 0.5 → 1 → 0.9 → 0.4.

| Sparkle | Size, pt | Loop, s | Starts, s into loop | Peak opacity | Path x | Path y |
|---|---|---|---|---|---|---|
${t.forYouStar.motes.map((e,t)=>`| ${t+1} | ${H(e.size)} | ${H(e.seconds)} | ${H(e.offset)} | ${H(e.peak)} | ${e.xs.map(H).join(`, `)} | ${e.ys.map(H).join(`, `)} |`).join(`
`)}

Reflection of the star in the pill's rims (static): strength ${t.forYouStar.reflection.strength}, round end ${t.forYouStar.reflection.cap}, depth ${t.forYouStar.reflection.depth}, stretch ${t.forYouStar.reflection.reach}, softness ${t.forYouStar.reflection.blur}. ${t.forYouStar.reflection.note}

## 9. Springs

- ${t.springs.formula}
- ${t.springs.keyframeSpringEase}

## 10. Glass, shadows and blurs

${t.glass.note}

| Element | Preset | Chrome fill | Drop shadow (strength / softness / distance / size) | Refraction | Edge width | Blur | Frost | Rim light |
|---|---|---|---|---|---|---|---|---|
${v.map(e=>{let t=C[e];return`| ${y[e].label} | ${t.presetId} | ${t.chrome} | ${t.shadow.opacity} / ${t.shadow.blur} / ${t.shadow.y} / ${t.shadow.spread} | ${t.params.refraction} | ${t.params.bezel} | ${t.params.blur} | ${t.params.frost} | ${t.params.specular} |`}).join(`
`)}

Figma's Glass/Chrome style has a full-strength fill and a shadow of ${x.opacity} / ${x.blur} / ${x.y} / ${x.spread}. Every glass parameter is in the JSON under \`glass.elements\`.

- **Top fade blur:** ${t.progressiveBlurs.topFade}
- **Card bottom bar blur:** ${t.progressiveBlurs.cardBottomBar}

## 11. Data

\`\`\`json
${JSON.stringify(t,null,1)}
\`\`\`
`}function at(e){let t=URL.createObjectURL(new Blob([it(e)],{type:`text/markdown`})),n=document.createElement(`a`);n.href=t,n.download=`discover-motion-guide.md`,document.body.appendChild(n),n.click(),n.remove(),setTimeout(()=>URL.revokeObjectURL(t),1e3)}var ot=e=>Math.round(e/10)*10,U=(e,t,n)=>Math.min(n,Math.max(t,e)),st=(e,t)=>e===`scale`?`${t.toFixed(2)}×`:e===`opacity`?`${Math.round(t*100)}%`:`${Math.round(t)} pt`;function ct(e,t,n,r,i,a=48){let o=``;for(let s=0;s<=a;s++){let c=s/a;o+=`${s?`L`:`M`}${(t+c*r).toFixed(1)} ${(n+i-Ee(e,c)*i).toFixed(1)}`}return o}var lt=(e,t)=>JSON.stringify(e)===JSON.stringify(t),W={x:30,y:30,w:200,h:110,W:260,H:170},ut=class{root;notifs;phase=`recede`;sel={prop:`blur`,index:1};head=null;el={};constructor(e,t){this.root=e,this.notifs=t,e.innerHTML=`
      <section id="mTransport"></section>
      <section id="mMoments"></section>
      <section id="mTimeline"></section>
      <section id="mEditor"></section>
      <section id="mSequence"></section>
      <section class="actions">
        <button class="button" id="mCopy">Copy values</button>
        <button class="button" id="mReset">Reset motion</button>
        <p class="hint footer">Defaults follow the motion guidelines: a 0.45 s spring with no bounce for what arrives, 0.18 s for what steps back. Values are remembered in this browser.</p>
      </section>`;let n=t=>e.querySelector(t);this.el={transport:n(`#mTransport`),moments:n(`#mMoments`),timeline:n(`#mTimeline`),editor:n(`#mEditor`),sequence:n(`#mSequence`)},n(`#mCopy`).addEventListener(`click`,async e=>{let t=e.currentTarget;try{await navigator.clipboard.writeText(JSON.stringify(I,null,2)),t.textContent=`Copied`}catch{t.textContent=`Could not copy`}setTimeout(()=>{t.textContent=`Copy values`},1200)}),n(`#mReset`).addEventListener(`click`,()=>{Le(),this.sel.index=Math.min(this.sel.index,this.keys.length-1),this.renderAll()}),e.addEventListener(`keydown`,e=>{e.key!==`Backspace`&&e.key!==`Delete`||e.target instanceof HTMLInputElement||this.deleteKey()}),this.renderAll()}get ph(){return I[this.phase]}get keys(){return this.ph.tracks[this.sel.prop]}get key(){return this.keys[this.sel.index]}renderAll(){this.renderTransport(),this.renderMoments(),this.renderTimeline(),this.renderEditor(),this.renderSequence()}changed(){Ie(),this.notifs.mode===`scrub`&&this.head!==null&&this.notifs.scrub(this.phase,this.head)}syncMode(){this.notifs.mode!==`scrub`&&(this.head=null),this.renderTransport(),this.placeHead()}renderTransport(){let e=[[1,`1×`],[.5,`½×`],[.25,`¼×`],[.1,`⅒×`]];this.el.transport.innerHTML=`
      <div class="transport">
        <button class="button primary" id="mPlay">
          <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true"><path d="M0 0L10 6L0 12Z" fill="currentColor"/></svg>
          ${this.notifs.mode===`play`?`Restart`:`Play`}
        </button>
        <div class="segmented" id="mSpeed" title="Playback speed">
          ${e.map(([e,t])=>`<button data-v="${e}" class="${this.notifs.speed===e?`active`:``}">${t}</button>`).join(``)}
        </div>
      </div>`,this.el.transport.querySelector(`#mPlay`).addEventListener(`click`,()=>{this.head=null,this.notifs.play()}),this.el.transport.querySelectorAll(`#mSpeed button`).forEach(e=>e.addEventListener(`click`,()=>{this.notifs.speed=+e.dataset.v,this.renderTransport()}))}renderMoments(){this.el.moments.innerHTML=`
      <h2>Moment</h2>
      <div class="moments">
        ${Se.map(e=>`
          <button class="moment${e.id===this.phase?` active`:``}" data-phase="${e.id}">
            <span class="mini" data-mini="${e.id}"><i class="mp a"></i><i class="mp b"></i></span>
            <span class="m-label">${e.label}</span>
            <span class="m-dur">${I[e.id].duration} ms</span>
          </button>`).join(``)}
      </div>
      <p class="hint">${Se.find(e=>e.id===this.phase).hint}</p>`,this.el.moments.querySelectorAll(`.moment`).forEach(e=>e.addEventListener(`click`,()=>{this.phase=e.dataset.phase,this.sel.index=Math.min(this.sel.index,this.keys.length-1),this.head=null,this.notifs.mode===`scrub`&&this.notifs.play(),this.renderMoments(),this.renderTimeline(),this.renderEditor()}))}tick(e){this.el.moments.querySelectorAll(`.mini`).forEach(t=>{let n=t.dataset.mini,r=I[n],i=e%(r.duration+900)-200,a=n===`arrive`?i<0?null:F(r,i):De({y:0,scale:1,opacity:1,blur:0},F(r,Math.max(i,0))),o=n===`recede`&&i-I.stagger>=0?F(I.arrive,i-I.stagger):null,s=(e,t)=>{e.style.opacity=t?String(U(t.opacity,0,1)):`0`,t&&(e.style.transform=`translate(-50%, -50%) translateY(${t.y*.4}px) scale(${t.scale})`,e.style.filter=t.blur>.1?`blur(${t.blur*.4}px)`:`none`)};s(t.children[0],a),s(t.children[1],o)})}spark(e,t){let n=Array.from({length:61},(n,r)=>P(e,r/60*t)),r=Math.min(...n),i=Math.max(...n);return n.map((e,t)=>`${t?`L`:`M`}${(t/60*100).toFixed(2)} ${(i-r<1e-6?12:21-(e-r)/(i-r)*18).toFixed(2)}`).join(``)}renderTimeline(){let e=this.ph,t=e.duration,n=t<=600?100:t<=1500?250:500,r=Array.from({length:Math.floor(t/n)+1},(e,t)=>t*n);this.el.timeline.innerHTML=`
      <div class="row-head">
        <h2>Timeline</h2>
        <label class="num">Duration <input id="mDur" type="number" min="50" max="3000" step="10" value="${t}"> ms</label>
      </div>
      <div class="tl">
        <div class="tl-labels"><span></span>${j.map(e=>`<span class="${e===this.sel.prop?`on`:``}">${M[e].label}</span>`).join(``)}</div>
        <div class="tl-inner" id="tlInner">
          <div class="tl-ruler" id="tlRuler">${r.map(e=>`<i style="left:${e/t*100}%">${e}</i>`).join(``)}</div>
          ${j.map(n=>`
            <div class="tl-track${n===this.sel.prop?` on`:``}" data-track="${n}">
              <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none"><path d="${this.spark(e.tracks[n],t)}"/></svg>
              ${e.tracks[n].map((e,r)=>`<button class="kf${n===this.sel.prop&&r===this.sel.index?` sel`:``}" data-i="${r}" style="left:${e.t/t*100}%" title="${M[n].label} ${st(n,e.v)} at ${e.t} ms"></button>`).join(``)}
            </div>`).join(``)}
          <div class="tl-head" id="tlHead" hidden></div>
        </div>
      </div>
      <p class="hint">Drag across the ruler to scrub the screen. Drag a diamond to retime it, double-click a row to add one.</p>`,this.placeHead(),this.bindTimeline()}placeHead(){let e=this.el.timeline.querySelector(`#tlHead`);e&&(e.hidden=this.head===null,this.head!==null&&(e.style.left=`${this.head/this.ph.duration*100}%`))}bindTimeline(){let e=this.el.timeline,t=e.querySelector(`#tlInner`),n=e=>{let n=t.getBoundingClientRect();return U((e.clientX-n.left)/n.width*this.ph.duration,0,this.ph.duration)};e.querySelector(`#mDur`).addEventListener(`change`,e=>{let t=U(ot(+e.target.value||this.ph.duration),50,3e3),n=t/this.ph.duration;for(let e of j)for(let t of this.ph.tracks[e])t.t=ot(t.t*n);this.ph.duration=t,this.head=null,this.changed(),this.renderMoments(),this.renderTimeline(),this.renderEditor()});let r=e.querySelector(`#tlRuler`),i=e=>{this.head=Math.round(n(e)),this.notifs.scrub(this.phase,this.head),this.placeHead()};r.addEventListener(`pointerdown`,e=>{r.setPointerCapture(e.pointerId),i(e)}),r.addEventListener(`pointermove`,e=>{r.hasPointerCapture(e.pointerId)&&i(e)}),e.querySelectorAll(`.tl-track`).forEach(t=>{let r=t.dataset.track;t.addEventListener(`dblclick`,e=>{if(e.target.classList.contains(`kf`))return;let t=this.ph.tracks[r],i=ot(n(e));t.some(e=>e.t===i)||(t.push({t:i,v:+P(t,i).toFixed(M[r].step<1?2:0),ease:structuredClone(be[0].ease)}),t.sort((e,t)=>e.t-t.t),this.sel={prop:r,index:t.findIndex(e=>e.t===i)},this.changed(),this.renderTimeline(),this.renderEditor())}),t.querySelectorAll(`.kf`).forEach(i=>{i.addEventListener(`pointerdown`,a=>{a.stopPropagation();let o=+i.dataset.i,s=this.ph.tracks[r],c=s[o];this.sel={prop:r,index:o},e.querySelectorAll(`.kf.sel`).forEach(e=>e.classList.remove(`sel`)),i.classList.add(`sel`),this.renderEditor(),i.setPointerCapture(a.pointerId);let l=o>0?s[o-1].t+10:0,u=o<s.length-1?s[o+1].t-10:this.ph.duration,d=!1,f=e=>{let r=U(ot(n(e)),l,u);r!==c.t&&(d=!0,c.t=r,i.style.left=`${r/this.ph.duration*100}%`,t.querySelector(`path`).setAttribute(`d`,this.spark(s,this.ph.duration)),this.changed(),this.renderEditor())},p=()=>{i.removeEventListener(`pointermove`,f),i.removeEventListener(`pointerup`,p),i.removeEventListener(`pointercancel`,p),d?this.renderTimeline():(e.querySelectorAll(`.tl-track, .tl-labels span`).forEach(e=>e.classList.remove(`on`)),t.classList.add(`on`))};i.addEventListener(`pointermove`,f),i.addEventListener(`pointerup`,p),i.addEventListener(`pointercancel`,p)})})})}refreshSparks(){this.el.timeline.querySelectorAll(`.tl-track`).forEach(e=>{e.querySelector(`path`).setAttribute(`d`,this.spark(this.ph.tracks[e.dataset.track],this.ph.duration))})}deleteKey(){this.keys.length<2||(this.keys.splice(this.sel.index,1),this.sel.index=Math.min(this.sel.index,this.keys.length-1),this.changed(),this.renderTimeline(),this.renderEditor())}curveSVG(e){let{x:t,y:n,w:r,h:i,W:a,H:o}=W,s=e.type===`bezier`?(()=>{let[a,o,s,c]=e.p,l=(e,a)=>[t+e*r,n+i-a*i],[u,d]=l(a,o),[f,p]=l(s,c);return`<line x1="${t}" y1="${n+i}" x2="${u}" y2="${d}"/><line x1="${t+r}" y1="${n}" x2="${f}" y2="${p}"/>
        <circle class="handle" data-h="0" cx="${u}" cy="${d}" r="7"/><circle class="handle" data-h="1" cx="${f}" cy="${p}" r="7"/>`})():``;return`<svg class="curve" id="mCurve" viewBox="0 0 ${a} ${o}">
      <rect x="${t}" y="${n}" width="${r}" height="${i}" rx="4"/>
      <text x="${t}" y="${o-8}">from the keyframe before</text><text x="${t+r}" y="${n-10}" text-anchor="end">this keyframe</text>
      <path d="${ct(e,t,n,r,i)}"/>${s}
    </svg>`}renderEditor(){let e=this.sel.prop,t=M[e],n=this.key,r=this.sel.index===0,i=n.ease;this.el.editor.innerHTML=`
      <div class="row-head">
        <h2>Keyframe</h2>
        <button class="link" id="kDel" ${this.keys.length<2?`disabled`:``}>Delete</button>
      </div>
      <div class="kf-title"><i class="kf sel"></i>${t.label} at <label class="num"><input id="kT" type="number" min="0" max="${this.ph.duration}" step="10" value="${n.t}"> ms</label></div>
      <div class="param">
        <div class="param-head"><span>Value</span><output id="kOut">${st(e,n.v)}</output></div>
        <input id="kV" type="range" min="${t.min}" max="${t.max}" step="${t.step}" value="${n.v}"/>
        <p class="hint">At rest this is ${st(e,t.rest)}.</p>
      </div>
      ${r?`<p class="hint">This is the first keyframe on the row: the value the moment starts from.</p>`:`
      <h2 class="sub">How it gets here</h2>
      <div class="ease-tiles">
        ${be.map(e=>`
          <button class="ease-tile${lt(e.ease,i)?` active`:``}" data-ease="${e.id}" title="${e.label}">
            <svg viewBox="0 0 40 28"><path d="${ct(e.ease,6,5,28,18,24)}"/></svg><span>${e.label}</span>
          </button>`).join(``)}
      </div>
      ${this.curveSVG(i)}
      ${i.type===`spring`?`
        <div class="param${i.bounce?` changed`:``}">
          <div class="param-head"><span>Bounce</span><output id="kBounceOut">${i.bounce.toFixed(2)}</output></div>
          <input id="kBounce" type="range" min="0" max="0.5" step="0.01" value="${i.bounce}"/>
          <p class="hint">The motion guidelines use no bounce (0): things land calmly and don't wobble.</p>
        </div>`:`<p class="hint">Drag the two handles to shape the curve. <span id="kBez">cubic-bezier(${i.p.join(`, `)})</span></p>`}`}`,this.bindEditor()}bindEditor(){let e=this.el.editor,t=this.sel.prop,n=this.key;e.querySelector(`#kDel`).addEventListener(`click`,()=>this.deleteKey()),e.querySelector(`#kT`).addEventListener(`change`,e=>{let t=this.sel.index,r=this.keys,i=t>0?r[t-1].t+10:0,a=t<r.length-1?r[t+1].t-10:this.ph.duration;n.t=U(ot(+e.target.value||0),i,a),this.changed(),this.renderTimeline(),this.renderEditor()});let r=e.querySelector(`#kV`);r.addEventListener(`input`,()=>{n.v=+r.value,e.querySelector(`#kOut`).textContent=st(t,n.v),this.refreshSparks(),this.changed()}),r.addEventListener(`dblclick`,()=>{n.v=M[t].rest,this.changed(),this.renderTimeline(),this.renderEditor()}),e.querySelectorAll(`.ease-tile`).forEach(e=>e.addEventListener(`click`,()=>{n.ease=structuredClone(be.find(t=>t.id===e.dataset.ease).ease),this.changed(),this.refreshSparks(),this.renderEditor()}));let i=e.querySelector(`#kBounce`);i?.addEventListener(`input`,()=>{n.ease.type===`spring`&&(n.ease.bounce=+i.value,e.querySelector(`#kBounceOut`).textContent=n.ease.bounce.toFixed(2),e.querySelector(`#mCurve path`).setAttribute(`d`,ct(n.ease,W.x,W.y,W.w,W.h)),this.refreshSparks(),this.changed())}),i?.addEventListener(`change`,()=>this.renderEditor());let a=e.querySelector(`#mCurve`);a?.querySelectorAll(`.handle`).forEach(t=>{t.addEventListener(`pointerdown`,r=>{if(n.ease.type!==`bezier`)return;let i=n.ease,o=+t.dataset.h;t.setPointerCapture(r.pointerId);let s=n=>{let r=a.getBoundingClientRect(),s=W.W/r.width,c=U(((n.clientX-r.left)*s-W.x)/W.w,0,1),l=U((W.y+W.h-(n.clientY-r.top)*s)/W.h,-.25,1.25);i.p[o*2]=+c.toFixed(2),i.p[o*2+1]=+l.toFixed(2);let u=W.x+c*W.w,d=W.y+W.h-l*W.h;t.setAttribute(`cx`,String(u)),t.setAttribute(`cy`,String(d));let f=a.querySelectorAll(`line`)[o];f.setAttribute(`x2`,String(u)),f.setAttribute(`y2`,String(d)),a.querySelector(`path`).setAttribute(`d`,ct(i,W.x,W.y,W.w,W.h));let p=e.querySelector(`#kBez`);p&&(p.textContent=`cubic-bezier(${i.p.join(`, `)})`),this.refreshSparks(),this.changed()},c=()=>{t.removeEventListener(`pointermove`,s),t.removeEventListener(`pointerup`,c),t.removeEventListener(`pointercancel`,c),this.renderEditor()};t.addEventListener(`pointermove`,s),t.addEventListener(`pointerup`,c),t.addEventListener(`pointercancel`,c)})})}renderSequence(){this.el.sequence.innerHTML=`
      <h2>Sequence</h2>
      <div class="param" data-s="hold">
        <div class="param-head"><span>Time between notifications</span><output>${I.hold} ms</output></div>
        <input type="range" min="400" max="3000" step="50" value="${I.hold}"/>
      </div>
      <div class="param" data-s="stagger">
        <div class="param-head"><span>Next one waits</span><output>${I.stagger} ms</output></div>
        <input type="range" min="0" max="400" step="10" value="${I.stagger}"/>
        <p class="hint">How long after the old notification starts going back the next one starts arriving.</p>
      </div>
      <div class="param" data-s="dim">
        <div class="param-head"><span>Dim under notifications</span><output>${+(I.dim*100).toFixed(1)}%</output></div>
        <input type="range" min="0" max="1" step="0.025" value="${I.dim}"/>
        <p class="hint">How much darker the card under the notifications gets. It follows the Fade rows: in with the first arrival, out with the last one leaving.</p>
      </div>`,this.el.sequence.querySelectorAll(`.param`).forEach(e=>{let t=e.dataset.s,n=e.querySelector(`input`),r=e.querySelector(`output`);n.addEventListener(`input`,()=>{I[t]=+n.value,r.textContent=t===`dim`?`${+(I.dim*100).toFixed(1)}%`:`${I[t]} ms`,this.changed()})})}},dt=o,G={top:622,h:160},ft={x:201,y:735,h:64},pt=2400,mt=e=>`
  <span class="album">
    <i class="stack"></i>
    <span class="thumb">
      <span class="thumb-box" style="left:${e.box.x}px;top:${e.box.y}px;width:${e.box.w}px;height:${e.box.h}px;${e.blur?`filter:blur(${e.blur}px);`:``}">
        <img src="${e.src}" alt="" style="left:${e.crop.left}%;top:${e.crop.top}%;width:${e.crop.w}%;height:${e.crop.h}%">
      </span>
    </span>
  </span>`,ht=e=>`
  <span class="avatar">
    <img class="photo" src="${e.avatar}" width="40" height="40" alt="">
    <i class="online"></i>
  </span>
  <span class="text">
    <span class="title"><span class="name">${e.name}</span><span class="meta">${e.meta}</span></span>
    <span class="message">${e.message}</span>
  </span>
  ${e.accessory?e.accessory.kind===`album`?mt(e.accessory):`
  <span class="find">
    <span class="ico-box"><img class="ico" src="${dt}navigation-16.svg" width="16" height="16" alt=""></span>
    <span class="find-label">Map</span>
  </span>`:``}`,gt=class{tabbar;guest;hooks;mode=`play`;T=-1500;speed=1;heldIndex=-1;layers=[];guestLayer;crop=document.createElement(`canvas`);cropCtx=this.crop.getContext(`2d`,{alpha:!1});pixelScale=1;pick=!1;picked=!1;present=!1;cycles=0;badge;badgeState=``;constructor(e,t,n,r){this.tabbar=t,this.guest=n,this.hooks=r,this.badge=t.querySelector(`.badge`);{let t=document.createElement(`div`);t.className=`nlayer`,t.style.top=`${G.top}px`,t.style.height=`${G.h}px`,t.innerHTML=`<div class="nfx"><canvas></canvas></div>`,e.appendChild(t);let r=t.querySelector(`.nfx`),i=t.querySelector(`canvas`);r.appendChild(n.el),this.guestLayer={root:t,fx:r,canvas:i,pill:n.el,content:n.el,renderer:new a(i),index:-1}}for(let t=0;t<2;t++){let t=document.createElement(`div`);t.className=`nlayer`,t.style.top=`${G.top}px`,t.style.height=`${G.h}px`,t.innerHTML=`<div class="nfx"><canvas></canvas><div class="glass g-notif" data-glass="notification" role="status"><span class="content"></span></div></div>`,e.appendChild(t);let n=t.querySelector(`canvas`),r=t.querySelector(`.glass`);r.style.height=`${ft.h}px`,r.addEventListener(`pointerdown`,e=>{e.stopPropagation(),this.pick&&this.hooks.onPick(e.shiftKey||e.metaKey)}),this.layers.push({root:t,fx:t.querySelector(`.nfx`),canvas:n,pill:r,content:r.querySelector(`.content`),renderer:new a(n),index:-1})}}get count(){return A.length}start(e){return e*I.hold+(e>0?I.stagger:0)}end(e){return(e+1)*I.hold}get total(){return this.end(this.count-1)+I.leave.duration}pose(e,t){let n=t-this.start(e);if(n<0)return null;let r=F(I.arrive,n),i=t-this.end(e);if(i>=0){let t=e<this.count-1?I.recede:I.leave;if(i>t.duration)return null;r=De(r,F(t,i))}return r.opacity>.002?r:null}get dim(){let e=this.T-this.start(0);if(e<0)return 0;let t=P(I.arrive.tracks.opacity,e),n=this.T-this.end(this.count-1);return n>=0&&(t*=n>I.leave.duration?0:P(I.leave.tracks.opacity,n)),Math.min(1,Math.max(0,t))*I.dim}play(){this.mode=`play`,this.heldIndex=-1,this.T=-300,this.hooks.onChange()}stop(){this.mode=`off`,this.heldIndex=-1,this.T=-1e9,this.cycles=0,this.hooks.onChange()}hold(e){this.mode=`held`,this.heldIndex=e,this.T=Math.min(this.start(e)+I.arrive.duration,this.end(e)-1),this.hooks.onChange()}scrub(e,t){let n=this.mode;this.mode=`scrub`,this.heldIndex=-1,this.T=(e===`arrive`?this.start(0):e===`recede`?this.end(0):this.end(this.count-1))+t,n!==`scrub`&&this.hooks.onChange()}get current(){return this.T<0||this.T>=this.end(this.count-1)?-1:Math.min(this.count-1,Math.floor(this.T/I.hold))}setPick(e){this.pick=e}setPicked(e){this.picked=e;for(let t of this.layers)t.pill.classList.toggle(`picked`,e)}layout(e,t){this.pixelScale=e,this.crop.width=Math.round(L.w*t),this.crop.height=Math.round(G.h*t);for(let t of[...this.layers,this.guestLayer])t.renderer.setViewport(L.w,G.h,e),t.renderer.setBackdrop(this.crop,this.crop.width,this.crop.height,0)}update(e){this.mode===`play`&&(this.T+=e*1e3*this.speed,this.T>this.total+2400&&(this.T=-300,this.cycles+=1));let t=this.T,n=this.end(this.count-1),r=t>=-300&&t<n+I.leave.duration;r!==this.present&&(this.present=r,this.hooks.onPresence(r)),this.updateBadge(t,n)}updateBadge(e,t){let n=e<0?this.mode===`off`||this.cycles===0&&this.mode!==`scrub`||this.badgeState.startsWith(`count`)?`icon`:this.badgeState||`icon`:e<t?`count:${6-Math.min(this.count-1,Math.floor(e/I.hold))}`:`dot`;if(n===this.badgeState)return;let r=this.badgeState.startsWith(`count`);if(this.badgeState=n,this.tabbar.classList.toggle(`s-count`,n.startsWith(`count`)),this.tabbar.classList.toggle(`s-dot`,n===`dot`),!n.startsWith(`count`))return;let i=document.createElement(`span`);i.className=`digit`,i.textContent=n.slice(6);let a=this.badge.querySelector(`.digit:not(.out)`);a&&r?(a.classList.add(`out`),setTimeout(()=>a.remove(),400),i.classList.add(`in`),this.badge.appendChild(i),requestAnimationFrame(()=>requestAnimationFrame(()=>i.classList.remove(`in`)))):this.badge.replaceChildren(i)}guestPose(e){let t=e-this.start(0);if(t<0)return{y:0,scale:1,opacity:1,blur:0};let n=e-this.end(this.count-1),r=e=>P(I.recede.tracks.blur,Math.min(1,Math.max(0,e))*I.recede.duration),i=null;if(n>=0){let e=I.arrive.tracks.opacity,t=Math.max(e[e.length-1].t,1);i=F(I.arrive,n),i.blur+=r(1-n/t)}else t<=I.leave.duration&&(i=F(I.leave,t),i.blur+=r(t/I.leave.duration));return i&&i.opacity>.002?i:null}paint(e,t,n,r,i,a,o,s){e.root.style.visibility=`visible`,e.fx.style.opacity=String(Math.min(1,a.opacity)),e.fx.style.filter=a.blur>.05?`blur(${a.blur}px)`:`none`;let c=n-i/2-s,l=t-r/2-s,u=r+s*2,d=i+s*2;e.canvas.style.clipPath=`inset(${c}px ${L.w-l-u}px ${G.h-c-d}px ${l}px round ${d/2}px)`,e.renderer.updateBackdrop(),e.renderer.render({shapes:[{id:`n`,kind:`capsule`,x:t,y:n,w:r,h:i}],params:o.params,appearances:[o.appearance],scroll:[0,0]})}render(e){let t=[];for(let e=0;e<this.count;e++){let n=this.pose(e,this.T);n&&t.push({i:e,p:n})}let n=new Set,r=this.guestPose(this.T);if(t.length||r){let t=this.crop.width/L.w;this.cropCtx.drawImage(e,0,G.top*t,this.crop.width,this.crop.height,0,0,this.crop.width,this.crop.height)}{let e=this.guest,t=this.guestLayer;if(r){let n=r.scale*e.scale(),i=e.y+r.y-G.top;this.paint(t,e.x,i,e.w*n,e.h*n,r,C[`switch-right`],r.blur>.05?0:28),t.root.style.zIndex=`-1`,e.el.style.transform=`translate(${e.x-e.w/2}px, ${i-e.h/2}px) scale(${n})`,e.el.style.pointerEvents=r.opacity>.5?`auto`:`none`}else t.root.style.visibility=`hidden`,e.el.style.pointerEvents=`none`}let i=C.notification;for(let{i:e,p:r}of t.slice(-2)){let t=this.layers[e%2],a=A[e];n.add(t),t.index!==e&&(t.index=e,t.content.innerHTML=ht(a),t.pill.style.width=`${a.width}px`);let o=a.width*r.scale,s=ft.h*r.scale,c=ft.y+r.y-G.top;t.root.style.zIndex=String(e),this.paint(t,ft.x,c,o,s,r,i,0),t.pill.style.transform=`translate(${ft.x-a.width/2}px, ${c-ft.h/2}px) scale(${r.scale})`,t.pill.style.setProperty(`--chrome`,String(i.chrome)),t.pill.style.setProperty(`--sh-a`,String(i.shadow.opacity)),t.pill.style.setProperty(`--sh-y`,`${i.shadow.y}px`),t.pill.style.setProperty(`--sh-blur`,`${i.shadow.blur}px`),t.pill.style.setProperty(`--sh-spread`,`${i.shadow.spread}px`),t.pill.style.pointerEvents=this.pick?`auto`:`none`,t.pill.classList.toggle(`on-light`,i.appearance===`light`),t.pill.classList.toggle(`picked`,this.picked)}for(let e of this.layers)n.has(e)||(e.root.style.visibility=`hidden`)}},_t=e=>e.replace(/[&<>"]/g,e=>({"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`})[e]),vt=(e,t)=>{let n=g[e],r=n.step>=1?0:n.step>=.1?1:2;return`${t.toFixed(r)}${n.unit===`px`?` px`:n.unit}`},yt=(e,t)=>e===`blur`?`${t.toFixed(1)} px`:`${t.toFixed(2)}×`,bt=(e,t)=>e===`opacity`?t.toFixed(2):`${t} px`,xt=class{root;chrome;notifs;selection=new Set(b.find(e=>e.id===`small`).ids);pick=!1;holding=!1;constructor(e,t,n){this.root=e,this.chrome=t,this.notifs=n,this.render(),this.syncSelection()}select(e,t=!1){t||this.selection.clear();for(let n of e)t&&this.selection.has(n)&&this.selection.size>1?this.selection.delete(n):this.selection.add(n);this.syncSelection(),this.render()}syncSelection(){this.chrome.setSelection(this.selection);let e=this.selection.has(`notification`);this.notifs.setPicked(e),e&&this.notifs.mode!==`held`?(this.holding=this.notifs.mode===`play`,this.notifs.hold(Math.max(this.notifs.current,0))):!e&&this.holding&&(this.holding=!1,this.notifs.play())}get ids(){return[...this.selection]}get first(){return C[this.ids[0]]}mixed(e){return new Set(this.ids.map(e)).size>1}refreshNotifications(){let e=this.root.querySelector(`#notifSection`);e&&(e.innerHTML=this.notificationsHTML(),this.bindNotifications())}notificationsHTML(){let e=this.notifs;return`
      <h2>Notifications</h2>
      <div class="chips">
        <button class="chip${e.mode===`play`||e.mode===`scrub`?` active`:``}" data-n="auto">Play</button>
        ${A.map((t,n)=>`<button class="chip${e.mode===`held`&&e.heldIndex===n?` active`:``}" data-n="${n}">${_t(t.name.trim())}</button>`).join(``)}
        <button class="chip${e.mode===`off`?` active`:``}" data-n="hide">None</button>
      </div>
      <p class="hint">Play runs the four messages in turn. Pick one to hold it on screen. Their motion is in the Motion tab.</p>`}bindNotifications(){this.root.querySelectorAll(`[data-n]`).forEach(e=>e.addEventListener(`click`,()=>{let t=e.dataset.n;if(this.holding=!1,t===`auto`||t===`hide`){if(this.selection.has(`notification`)){let e=this.ids.filter(e=>e!==`notification`);this.select(e.length?e:b[1].ids)}t===`auto`?this.notifs.play():this.notifs.stop()}else this.notifs.hold(+t);this.refreshNotifications()}))}render(){let e=this.root.parentElement,t=e.scrollTop,n=this.first,r=_[n.presetId],i=[...new Set(Object.values(g).map(e=>e.group))],a=e=>e.length===this.selection.size&&e.every(e=>this.selection.has(e)),o=this.selection.size;this.root.innerHTML=`
      <section>
        <h2>Glass elements</h2>
        <div class="chips">
          ${b.map(e=>`<button class="chip${a(e.ids)?` active`:``}" data-group="${e.id}">${e.label}</button>`).join(``)}
        </div>
        ${v.map(e=>`
          <button class="list-item${this.selection.has(e)?` active`:``}" data-el="${e}">
            <span>${y[e].label}</span><span class="meta">${y[e].size}</span>
          </button>`).join(``)}
        <label class="toggle"><input type="checkbox" id="pick" ${this.pick?`checked`:``}/> <span>Select on the screen</span></label>
        <p class="hint">Click a row to select it, ⌘-click to add or remove one. The controls below change ${o===1?`the selected element`:`all ${o} selected elements`}.</p>
      </section>
      <section id="notifSection">${this.notificationsHTML()}</section>
      <section>
        <h2>Preset</h2>
        <select id="preset">
          ${this.mixed(e=>C[e].presetId)?`<option selected disabled>Mixed</option>`:``}
          ${Object.entries(_).map(([e,t])=>`<option value="${e}"${!this.mixed(e=>C[e].presetId)&&e===n.presetId?` selected`:``}>${t.label}</option>`).join(``)}
        </select>
        <p class="hint">${r.description}</p>
      </section>
      <section>
        <h2>Appearance</h2>
        <div class="segmented" id="appearance">
          ${[`dark`,`light`].map(e=>`<button data-a="${e}" class="${!this.mixed(e=>C[e].appearance)&&n.appearance===e?`active`:``}">${e[0].toUpperCase()+e.slice(1)}</button>`).join(``)}
        </div>
        <p class="hint">Dark glass carries light content, light glass dark content.</p>
      </section>
      <section>
        <h2>Figma style</h2>
        <div class="param${n.chrome===1?``:` changed`}" data-chrome>
          <div class="param-head"><span>Chrome fill</span><output>${this.mixed(e=>C[e].chrome)?`Mixed`:n.chrome.toFixed(2)}</output></div>
          <input type="range" min="0" max="1" step="0.01" value="${n.chrome}"/>
          <p class="hint">Figma's Glass/Chrome gradient fill over the glass. 1 is as designed.</p>
        </div>
      </section>
      <section>
        <h2>Drop shadow</h2>
        ${Object.keys(ee).map(e=>{let t=ee[e],r=n.shadow[e];return`<div class="param${r===x[e]?``:` changed`}" data-sh="${e}" title="${_t(t.description)}">
            <div class="param-head"><span>${t.label}</span><output>${this.mixed(t=>C[t].shadow[e])?`Mixed`:bt(e,r)}</output></div>
            <input type="range" min="${t.min}" max="${t.max}" step="${t.step}" value="${r}"/>
            <p class="hint">${t.description}</p>
          </div>`}).join(``)}
        <p class="hint">Figma's Glass/Chrome shadow is strength 0.40, softness 30, distance 20, size −15. Double-click a slider to return to it.</p>
      </section>
      ${this.selection.has(`for-you`)?`
      <section>
        <h2>Icon reflection</h2>
        ${Object.keys(te).map(e=>{let t=te[e],n=C[`for-you`].reflection[e];return`<div class="param${n===S[e]?``:` changed`}" data-rf="${e}" title="${_t(t.description)}">
            <div class="param-head"><span>${t.label}</span><output>${yt(e,n)}</output></div>
            <input type="range" min="${t.min}" max="${t.max}" step="${t.step}" value="${n}"/>
            <p class="hint">${t.description}</p>
          </div>`}).join(``)}
        <p class="hint">The For You star mirrored in the pill's rims, as in the iOS concept. Double-click a slider to return to the concept's value.</p>
      </section>`:``}
      ${i.map(e=>`
        <section>
          <h2>${e}</h2>
          ${Object.keys(g).filter(t=>g[t].group===e).map(e=>{let t=g[e],i=this.mixed(t=>C[t].params[e]);return`<div class="param${n.params[e]===r.values[e]?``:` changed`}" data-k="${e}" title="${_t(t.description)}">
              <div class="param-head"><span>${t.label}</span><output>${i?`Mixed`:vt(e,n.params[e])}</output></div>
              <input type="range" min="${t.min}" max="${t.max}" step="${t.step}" value="${n.params[e]}"/>
              <p class="hint">${t.description}</p>
            </div>`}).join(``)}
        </section>`).join(``)}
      <section class="actions">
        <button class="button" id="copy">Copy values</button>
        <button class="button" id="reset">Reset selection</button>
        <p class="hint footer">Every change is saved as it is made, in this browser and to glass-defaults.json in the project, which is what any browser starts from. Reset selection returns to the built-in start. Double-click a slider to reset it to the preset.</p>
      </section>`,e.scrollTop=t,this.bind()}bind(){let e=this.root;e.querySelectorAll(`[data-group]`).forEach(e=>e.addEventListener(`click`,()=>this.select(b.find(t=>t.id===e.dataset.group).ids))),e.querySelectorAll(`[data-el]`).forEach(e=>e.addEventListener(`click`,t=>this.select([e.dataset.el],t.metaKey||t.shiftKey||t.ctrlKey))),e.querySelector(`#pick`).addEventListener(`change`,e=>{this.pick=e.target.checked,this.chrome.setPick(this.pick),this.notifs.setPick(this.pick)}),this.bindNotifications(),e.querySelector(`#preset`).addEventListener(`change`,e=>{let t=e.target.value;for(let e of this.ids)C[e].presetId=t,C[e].params={..._[t].values};w(),this.render()}),e.querySelectorAll(`#appearance button`).forEach(e=>e.addEventListener(`click`,()=>{for(let t of this.ids)C[t].appearance=e.dataset.a;w(),this.render()}));let t=e.querySelector(`[data-chrome]`),n=t.querySelector(`input`),r=t.querySelector(`output`),i=e=>{for(let t of this.ids)C[t].chrome=e;r.textContent=e.toFixed(2),t.classList.toggle(`changed`,e!==1),w()};n.addEventListener(`input`,()=>i(+n.value)),n.addEventListener(`dblclick`,()=>{n.value=`1`,i(1)}),e.querySelectorAll(`.param[data-rf]`).forEach(e=>{let t=e.dataset.rf,n=e.querySelector(`input`),r=e.querySelector(`output`),i=n=>{C[`for-you`].reflection[t]=n,r.textContent=yt(t,n),e.classList.toggle(`changed`,n!==S[t]),this.chrome.refreshReflection(),w()};n.addEventListener(`input`,()=>i(+n.value)),n.addEventListener(`dblclick`,()=>{n.value=String(S[t]),i(S[t])})}),e.querySelectorAll(`.param[data-sh]`).forEach(e=>{let t=e.dataset.sh,n=e.querySelector(`input`),r=e.querySelector(`output`),i=n=>{for(let e of this.ids)C[e].shadow[t]=n;r.textContent=bt(t,n),e.classList.toggle(`changed`,n!==x[t]),w()};n.addEventListener(`input`,()=>i(+n.value)),n.addEventListener(`dblclick`,()=>{n.value=String(x[t]),i(x[t])})}),e.querySelectorAll(`.param[data-k]`).forEach(e=>{let t=e.dataset.k,n=e.querySelector(`input`),r=e.querySelector(`output`),i=n=>{for(let e of this.ids)C[e].params[t]=n;r.textContent=vt(t,n),e.classList.toggle(`changed`,n!==_[this.first.presetId].values[t]),w()};n.addEventListener(`input`,()=>i(+n.value)),n.addEventListener(`dblclick`,()=>{let e=_[this.first.presetId].values[t];n.value=String(e),i(e)})}),e.querySelector(`#copy`).addEventListener(`click`,async e=>{let t=e.currentTarget,n=Object.fromEntries(this.ids.map(e=>[e,C[e]]));try{await navigator.clipboard.writeText(JSON.stringify(n,null,2)),t.textContent=`Copied`}catch{t.textContent=`Could not copy`}setTimeout(()=>{t.textContent=`Copy values`},1200)}),e.querySelector(`#reset`).addEventListener(`click`,()=>{le(this.ids),this.chrome.refreshReflection(),this.render()})}},K=e=>document.getElementById(e),St=K(`stage`),q=K(`phone`),Ct=K(`glass`),wt=K(`overlay`),Tt=k.length-1,Et=665,Dt=.25,Ot=2,kt={response:.28,damping:1.12},At=30,J={y:0,spring:new T(0,.42,1),drag:null,wheel:null},jt=e=>{let t=Tt*z;return e<0?ue(e,Et):e>t?t+ue(e-t,Et):e},Mt=1,Nt=e=>(e-q.getBoundingClientRect().top)/Mt,Pt=e=>(e-q.getBoundingClientRect().left)/Mt;q.addEventListener(`pointerdown`,e=>{if(e.button!==0)return;let t=Nt(e.clientY);J.spring.snap(J.y),J.drag={pointer:e.pointerId,startX:Pt(e.clientX),startY:t,axis:``,startScroll:J.y,page:Math.round(E(J.y/z,0,Tt)),moved:!1,samples:[{t:e.timeStamp,y:t}]},q.setPointerCapture(e.pointerId)}),q.addEventListener(`pointermove`,e=>{let t=J.drag;if(!t||e.pointerId!==t.pointer)return;let n=Nt(e.clientY),r=Pt(e.clientX)-t.startX;!t.axis&&(Math.abs(r)>6||Math.abs(n-t.startY)>6)&&(t.axis=Math.abs(r)>Math.abs(n-t.startY)?`x`:`y`),t.axis!==`x`&&(Math.abs(n-t.startY)>3&&(t.moved=!0),t.samples.push({t:e.timeStamp,y:n}),t.samples.length>8&&t.samples.shift(),J.y=jt(E(t.startScroll-(n-t.startY),(t.page-1)*z,(t.page+1)*z)),q.classList.toggle(`dragging`,t.moved))});var Ft=e=>{let t=J.drag;if(!t||e.pointerId!==t.pointer)return;if(J.drag=null,q.classList.remove(`dragging`),t.axis===`x`){let n=Pt(e.clientX)-t.startX,r=R.top+t.page*z-J.y,i=t.startY>=r&&t.startY<=r+R.h;e.type===`pointerup`&&i&&Math.abs(n)>=At&&zt(t.page,n<0?1:-1),It(t.page,0);return}let n=t.samples.filter(t=>e.timeStamp-t.t<80)[0]??t.samples[t.samples.length-1],r=t.samples[t.samples.length-1],i=r.t>n.t?-(r.y-n.y)/(r.t-n.t):0;It(E(i>Dt?t.page+1:i<-.25?t.page-1:Math.round(J.y/z),Math.max(0,t.page-1),Math.min(Tt,t.page+1)),i*1e3)};q.addEventListener(`pointerup`,Ft),q.addEventListener(`pointercancel`,Ft);function It(e,t){J.spring.value=J.y,J.spring.velocity=t,J.spring.target=e*z}q.addEventListener(`wheel`,e=>{if(e.preventDefault(),J.drag)return;let t=J.wheel;t||=(J.spring.snap(J.y),J.wheel={page:Math.round(E(J.y/z,0,Tt)),raw:J.y,timer:0}),t.raw=E(t.raw+e.deltaY/Mt,(t.page-1)*z,(t.page+1)*z),J.y=jt(t.raw),clearTimeout(t.timer),t.timer=window.setTimeout(()=>{J.wheel=null,It(E(Math.round(J.y/z),0,Tt),0)},90)},{passive:!1});var Lt=k.map(()=>({photo:0,next:-1,fade:0,dir:1,timer:-1})),Rt=k.map(()=>new T(0,kt.response,kt.damping));function zt(e,t){let n=Lt[e],r=k[e].photos.length;r<2||(n.next>=0&&(n.photo=n.next),n.next=(n.photo+t+r)%r,n.dir=t<0?-1:1,n.fade=0,Rt[e].snap(0),Rt[e].target=1,n.timer=0)}function Bt(e){let t=!J.drag&&!J.wheel&&J.spring.settled,n=Math.round(E(J.y/z,0,Tt));Lt.forEach((r,i)=>{let a=k[i].photos.length;r.next>=0&&(Rt[i].step(e),r.fade=E(Rt[i].value,0,1),Rt[i].settled&&(r.photo=r.next,r.next=-1,r.fade=0)),a<2||(i===n?(r.timer<0&&(r.timer=0),!t||r.next>=0||(r.timer+=e/Ot,r.timer>=1&&zt(i,1))):r.timer=0)})}var Y=new Je,X;try{X=new a(Ct)}catch(e){throw St.innerHTML=`<p class="error">${e.message}</p>`,e}var Z=X.gl,Vt=_[Object.keys(_)[0]].values,Ht=K(`panel`);Ht.innerHTML=`
  <div class="brand">Discover <span>web prototype</span></div>
  <div class="tabs" id="tabs"><button data-tab="glass">Glass</button><button data-tab="motion">Motion</button></div>
  <div id="glassPanel"></div>
  <div id="motionPanel" tabindex="-1"></div>`;var Ut,Wt,Gt=new ye(wt,{onPick:(e,t)=>Ut?.select([e],t)}),Kt=new gt(Gt.notificationHost,Gt.tabbar,Gt.mapSwitch,{onPick:e=>Ut?.select([`notification`],e),onPresence:()=>{},onChange:()=>{Ut?.refreshNotifications(),Wt?.syncMode()}});Ut=new xt(K(`glassPanel`),Gt,Kt),Wt=new ut(K(`motionPanel`),Kt);var qt=K(`edit`);function Jt(e){document.body.classList.toggle(`editing`,e),qt.textContent=e?`Done`:`Edit`,e!==(location.hash===`#edit`)&&history.replaceState(null,``,e?`#edit`:location.pathname+location.search)}qt.addEventListener(`click`,()=>Jt(!document.body.classList.contains(`editing`))),Jt(location.hash===`#edit`);var Yt=()=>({photoSeconds:Ot,push:kt,paging:{response:J.spring.response,damping:J.spring.damping,flick:Dt},toggle:{travel:fe,glyphOut:pe,glyphDelay:me,glyphScale:he,dotStretch:ge,press:_e},star:ve,startCount:6,loopGap:pt});K(`guide`).addEventListener(`click`,()=>at(Yt()));var Q=`glass`;try{Q=localStorage.getItem(`discover-tab`)===`motion`?`motion`:`glass`}catch{}function Xt(e){Q=e,K(`glassPanel`).hidden=Q!==`glass`,K(`motionPanel`).hidden=Q!==`motion`,Ht.querySelectorAll(`#tabs button`).forEach(e=>e.classList.toggle(`active`,e.dataset.tab===Q));try{localStorage.setItem(`discover-tab`,Q)}catch{}}Ht.querySelectorAll(`#tabs button`).forEach(e=>e.addEventListener(`click`,()=>Xt(e.dataset.tab))),Xt(Q);var $=1;function Zt(){let e=St.getBoundingClientRect();if(e.width<100||e.height<100)return;Mt=Math.min(1,(e.width-48)/L.w,(e.height-48)/L.h),q.style.transform=`scale(${Mt})`,$=Mt*(window.devicePixelRatio||1),X.setViewport(L.w,L.h,$);let t=Math.min(3,Math.max(1,Math.ceil($*2)/2));Y.setScale(t),X.setBackdrop(Y.canvas,Y.canvas.width,Y.canvas.height,0),Kt.layout($,t)}function Qt(){X.updateBackdrop(),Z.disable(Z.SCISSOR_TEST),X.render({shapes:[],params:Vt,appearances:[],scroll:[0,0]});let e=Gt.shapes(),t=new Map;for(let n of e){let e=JSON.stringify(C[n.id].params);t.set(e,[...t.get(e)??[],n])}Z.enable(Z.SCISSOR_TEST);for(let e of t.values()){let t=C[e[0].id].params,n=e.map(e=>C[e.id].appearance),r=t.dim>0?96:28;for(let i of e){let a=Math.floor((i.x-i.w/2-r)*$),o=Math.ceil((i.x+i.w/2+r)*$),s=Math.floor((L.h-(i.y+i.h/2+r))*$),c=Math.ceil((L.h-(i.y-i.h/2-r))*$);Z.scissor(a,s,o-a,c-s),X.render({shapes:e,params:t,appearances:n,scroll:[0,0]})}}Z.disable(Z.SCISSOR_TEST)}function $t(e){!J.drag&&!J.wheel&&(J.spring.step(e),J.y=J.spring.value),Bt(e),Kt.update(e),Gt.update(e),Y.draw(J.y,Lt,Kt.dim),Qt(),Kt.render(Y.canvas),Q===`motion`&&Wt?.tick(performance.now())}var en=performance.now();function tn(e){let t=Math.min(.05,(e-en)/1e3);en=e,$t(t),requestAnimationFrame(tn)}Y.load().then(()=>{new ResizeObserver(Zt).observe(St),Zt(),q.classList.add(`ready`),requestAnimationFrame(e=>{en=e,tn(e)})}).catch(e=>{St.innerHTML=`<p class="error">${e.message}</p>`}),window.proto={scroll:J,cards:Lt,chrome:Gt,settings:C,scene:Y,renderer:X,panel:Ut,notifs:Kt,motionPanel:Wt,settle:It,stepPhoto:zt,frame:$t};