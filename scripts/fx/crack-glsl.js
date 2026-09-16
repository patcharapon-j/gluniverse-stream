/**
 * The Broken-condition glass fracture, copied from the GLUniverse suite so the stream card cracks the
 * same way a broken creature's initiative card does.
 *
 * Source: gluniverse-foundry-modules/scripts/core/fx-glsl.mjs at commit ad75f31.
 * FX_GLSL_NOISE, FX_GLSL_BREAK_FIELD and FX_GLSL_BREAK_PULSE are verbatim; re-copy them rather than
 * editing them here. FX_FRAG_ROLL_CARD_BREAK is the suite's FX_FRAG_BREAK with the field's `dense`
 * and `reach` shape parameters promoted to uniforms, because the roll card is about 6:1 and the
 * suite's square-card values (1.0, 1.0) leave its shards a pixel wide and its spread dying early.
 * The circular clip is dropped: the card is always rectangular.
 *
 * No PIXI, no DOM, no imports.
 */

export const FX_GLSL_NOISE = `
float gluHash1(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7))+uSeed)*43758.5453); }
float gluVNoise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(gluHash1(i),gluHash1(i+vec2(1.0,0.0)),f.x),
             mix(gluHash1(i+vec2(0.0,1.0)),gluHash1(i+vec2(1.0,1.0)),f.x), f.y); }
float gluFbm(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*gluVNoise(p); p*=2.02; a*=0.5; } return s; }
`;

export const FX_GLSL_BREAK_FIELD = `
vec2 gluHash2(vec2 p){ p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))); return fract(sin(p+uSeed)*43758.5453); }
float gluVoroEdge(vec2 x){
  vec2 n=floor(x), f=fract(x); float f1=9.0,f2=9.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 g=vec2(float(i),float(j)); vec2 o=gluHash2(n+g); vec2 r=g+o-f; float d=dot(r,r);
    if(d<f1){f2=f1;f1=d;} else if(d<f2){f2=d;}
  }
  return sqrt(f2)-sqrt(f1);
}
vec4 gluBreakField(vec2 q, vec2 imp, float time, float thick, float texel, float dense, float reach){
  vec2 d=q-imp;
  float dist=length(d)/reach;
  float ang=atan(d.y,d.x);
  float warp=0.17*gluFbm(vec2(ang*1.3+3.0,1.7))+0.09*gluFbm(vec2(ang*3.7,5.0))-0.13;
  float wdist=dist+warp;
  float scale=mix(15.0,6.0,smoothstep(0.0,0.8,dist))*dense;  // fine shards near the impact -> fewer outward
  float ce=gluVoroEdge(q*scale+7.0);
  float aaWidth=max(thick, 1.5*scale*texel);
  float edge=1.0-smoothstep(0.0,aaWidth,ce);
  float shatterT=clamp(time*1.4,0.0,1.0);
  float front=smoothstep(0.05,-0.06, wdist-(0.05+1.2*shatterT));
  float coverage=smoothstep(1.15,0.10,wdist)*front;    // spreads across the art behind the front
  float crack=edge*coverage;
  float settled=smoothstep(0.55,1.0,shatterT);
  float flow=pow(0.5+0.5*sin(dist*26.0-time*3.2),6.0); // flowing energy along the cracks
  float glowFlow=crack*flow*settled;
  float pulse=0.62+0.38*sin(time*2.2);
  float halo=(1.0-smoothstep(0.0,0.13,ce))*coverage*0.30*pulse;   // soft amber bloom around the shards
  float core=smoothstep(0.12,0.0,dist)*smoothstep(0.0,0.12,shatterT);
  return vec4(crack, halo, core, glowFlow);
}
`;

export const FX_GLSL_BREAK_PULSE = `float gluBreakPulse(float time){ return 0.62+0.38*sin(time*2.2); }`;

export const FX_FRAG_ROLL_CARD_BREAK = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform float uTime, uSeed, uAspect, uThick, uTexel, uDense, uReach;
uniform vec2 uImpact;
uniform vec3 uBreakAmber, uBreakHot;
${FX_GLSL_NOISE}
${FX_GLSL_BREAK_FIELD}
${FX_GLSL_BREAK_PULSE}
void main(void){
  vec2 uv=vTextureCoord;
  vec4 f=gluBreakField(vec2(uv.x*uAspect,uv.y), vec2(uImpact.x*uAspect,uImpact.y),
                       uTime, uThick, uTexel, uDense, uReach);
  float crack=f.x, halo=f.y, core=f.z, glowFlow=f.w;
  float pulse=gluBreakPulse(uTime);
  vec3 amber=uBreakAmber, hot=uBreakHot, white=vec3(1.0);
  vec3 col=mix(amber,hot,clamp(crack*pulse,0.0,1.0));
  col=mix(col,white,clamp(core+glowFlow,0.0,1.0));
  float a=clamp(crack*0.95 + halo + core*0.7 + glowFlow*0.8, 0.0, 1.0);
  gl_FragColor=vec4(col*a, a);
}`;

/** Shape defaults for a roll card, tuned at 1080p in the design mockup. */
export const ROLL_CARD_CRACK_SHAPE = Object.freeze({ thick: 0.045, dense: 0.42, reach: 2.2 });

/**
 * Crack colours as `[base, hot]` linear RGB. Gold is the suite's breakAmber / breakHot, so a stream crit
 * matches a Broken creature's card exactly.
 */
export const CRACK_COLORS = Object.freeze({
  gold: Object.freeze({ base: [1.0, 0.694, 0.176], hot: [1.0, 0.878, 0.439] }),
  red: Object.freeze({ base: [1.0, 0.24, 0.28], hot: [1.0, 0.72, 0.74] }),
  violet: Object.freeze({ base: [0.62, 0.45, 1.0], hot: [0.88, 0.83, 1.0] })
});
