<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<title>{{TITLE}}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--bg:#0a0a12;--bg2:#14141d;--bg3:#1a1a25;--surf:#14141d;--surf-r:#1a1a25;--surf-e:#22222f;--surf-h:#22222f;--text:#eef1f6;--muted:#a6a2b4;--dim:#6a6678;--border:rgba(255,255,255,0.09);--bstr:rgba(255,255,255,0.16);--p:#b794f4;--p-strong:#7E47D7;--c:#45b8cc;--g:#43c39a;--y:#e8a64d;--r:#e06666;--m:#c9a8e6;--recommend:#67a0aa;--recommend-bg:rgba(103,160,170,0.05);--glow:rgba(126,71,215,0.15);--gglow:rgba(69,184,204,0.15);--fs:'Space Grotesk',system-ui,sans-serif;--fm:'IBM Plex Mono',ui-monospace,monospace;}
  *{box-sizing:border-box;}body{margin:0;font-family:var(--fs);color:var(--text);background:var(--bg);font-size:14px;line-height:1.55;}
  header.banner{background:var(--bg2);border-bottom:1px solid var(--bstr);padding:20px 32px;position:relative;}
  header.banner::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--p-strong),var(--c),transparent);opacity:0.55;}
  .brand{display:flex;align-items:baseline;gap:14px;margin-bottom:6px;}
  .logo{font-family:var(--fs);font-weight:700;font-size:22px;letter-spacing:0.18em;background:linear-gradient(135deg,var(--primary-soft,var(--p)) 0%,var(--c) 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}
  .product{font-size:14px;font-weight:500;color:var(--muted);letter-spacing:0.04em;}
  .meta{font-size:11.5px;font-family:var(--fm);color:var(--muted);letter-spacing:0.02em;}
  .meta .mk{color:var(--c);font-weight:600;}.meta .mv{color:var(--text);font-weight:600;}.meta .sep{color:var(--dim);margin:0 6px;}
  /* tabs — ported from the evaluator report's unified-brand treatment: void background,
     NO box-shadow (restrained brand), --fs-xs(12px) floor, subtle surf hover, and the
     active tab underlines in the STRONG primary (--p-strong) for clear affordance. */
  nav.tabs{background:var(--bg);border-bottom:1px solid var(--border);padding:0 12px;position:sticky;top:0;z-index:100;overflow-x:auto;white-space:nowrap;}
  nav.tabs button{background:none;border:none;padding:10px 12px;font-size:12px;font-weight:500;color:var(--muted);cursor:pointer;border-bottom:3px solid transparent;transition:all 0.15s;font-family:inherit;letter-spacing:0.01em;text-decoration:none;}
  nav.tabs button:hover{color:var(--text);background:var(--surf);}
  nav.tabs button.active{color:var(--p);border-bottom-color:var(--p-strong);font-weight:600;}
  nav.tabs button.internal{color:var(--c);} nav.tabs button.internal.active{border-bottom-color:var(--c);}
  nav.tabs button .sev-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;vertical-align:middle;}
  .sev-crit{background:var(--r);}.sev-high{background:var(--y);}.sev-med{background:var(--c);}.sev-info{background:var(--dim);}
  main{max-width:1200px;margin:0 auto;padding:28px 32px 140px 32px;}
  .panel{display:none;}.panel.active{display:block;animation:fade 0.2s ease-out;}
  @keyframes fade{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:translateY(0);}}
  h2{font-size:22px;font-weight:600;margin:0 0 8px 0;padding-bottom:10px;border-bottom:1px solid var(--bstr);color:var(--text);}
  .sub{color:var(--muted);font-size:13px;margin-bottom:24px;}
  h3{font-size:16px;font-weight:600;margin-top:24px;color:var(--p);}
  h4{font-size:13px;font-weight:600;margin-top:14px;color:var(--text);text-transform:uppercase;letter-spacing:0.04em;font-family:var(--fm);}
  p{line-height:1.6;color:var(--muted);}strong{color:var(--text);}
  table{border-collapse:collapse;margin:12px 0;font-size:12px;width:100%;border:1px solid var(--border);border-radius:8px;overflow:hidden;}
  th,td{border:1px solid var(--border);padding:8px 12px;text-align:left;vertical-align:top;color:var(--muted);}
  th{background:var(--surf-r);font-weight:600;color:var(--text);}tr:nth-child(even) td{background:var(--bg3);}
  code{background:var(--bg);color:var(--m);padding:2px 6px;border-radius:4px;font-size:max(11px,0.88em);font-family:var(--fm);border:1px solid var(--border);}
  .crit{background:rgba(224,102,102,0.08);border-left:3px solid var(--r);padding:14px 18px;margin:14px 0;}.crit strong{color:var(--r);}
  .warn{background:rgba(232,166,77,0.08);border-left:3px solid var(--y);padding:14px 18px;margin:14px 0;}.warn strong{color:var(--y);}
  .alert{background:rgba(67,195,154,0.08);border-left:3px solid var(--g);padding:14px 18px;margin:14px 0;}.alert strong{color:var(--g);}
  .internal-banner{background:rgba(69,184,204,0.08);border:1px dashed rgba(69,184,204,0.45);padding:10px 16px;margin:0 0 18px 0;font-family:var(--fm);font-size:11px;color:var(--c);letter-spacing:0.03em;}
  .badge{display:inline-block;padding:2px 6px;font-size:11px;border-radius:3px;font-weight:600;letter-spacing:0.04em;font-family:var(--fm);margin-right:4px;}
  .b-crit{background:rgba(224,102,102,0.18);color:var(--r);border:1px solid rgba(224,102,102,0.35);}
  .b-high{background:rgba(232,166,77,0.18);color:var(--y);border:1px solid rgba(232,166,77,0.35);}
  .b-med{background:rgba(69,184,204,0.18);color:var(--c);border:1px solid rgba(69,184,204,0.35);}
  .b-info{background:rgba(112,112,136,0.18);color:var(--dim);border:1px solid rgba(112,112,136,0.35);}
  .b-tool{background:rgba(201,168,230,0.15);color:var(--m);border:1px solid rgba(201,168,230,0.3);padding:2px 7px;border-radius:3px;font-family:var(--fm);font-size:11px;margin:2px;display:inline-block;}
  .taxonomy{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 14px 0;}
  .tax-chip{font-family:var(--fm);font-size:11px;padding:4px 8px;border-radius:4px;background:var(--surf-r);border:1px solid var(--border);color:var(--muted);}
  .tax-chip strong{color:var(--p);font-weight:600;}
  .whychain{margin:10px 0;padding:0;list-style:none;}
  .whychain li{position:relative;padding:8px 0 8px 18px;font-size:13px;color:var(--muted);border-left:2px solid var(--border);margin-left:8px;}
  .whychain li.origin{border-left-color:var(--r);color:var(--text);}
  .whychain li.origin::after{content:'← ORIGIN';font-family:var(--fm);font-size:11px;color:var(--r);margin-left:8px;font-weight:600;letter-spacing:0.04em;}
  .whychain li em{display:block;font-style:normal;color:var(--dim);font-size:11px;font-family:var(--fm);margin-top:3px;}
  /* EV-1: trace narration line — "trace <id> — <whatHappened> «example»" */
  .ev-narration{font-size:13px;color:var(--muted);}
  .ev-narration code{font-family:var(--fm);font-size:11px;color:var(--p);}
  .ev-example{display:block;margin-top:4px;font-style:normal;color:var(--dim);font-size:11px;font-family:var(--fm);quotes:none;}
  .whychain li em .ev-example{margin-top:2px;}
  .assumptions{background:rgba(232,166,77,0.06);border:1px solid rgba(232,166,77,0.25);border-radius:6px;padding:10px 14px;margin:12px 0;}
  .assumptions h4{margin-top:0;color:var(--y);}
  .assumptions li{font-size:12px;color:var(--muted);margin:4px 0;}
  .assumptions .verified{color:var(--g);font-family:var(--fm);font-size:11px;}
  .assumptions .unverified{color:var(--r);font-family:var(--fm);font-size:11px;}
  .assumptions .hypothesis-pending{color:var(--y);font-family:var(--fm);font-size:11px;}
  .remedy{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin:10px 0;display:flex;align-items:flex-start;gap:12px;position:relative;}
  .remedy.recommended{border:1px solid var(--recommend);border-left:3px solid var(--recommend);background:var(--recommend-bg);}
  .remedy.recommended::before{content:'★ RECOMMENDED';position:absolute;top:-9px;left:12px;background:var(--recommend);color:var(--bg);font-family:var(--fm);font-size:11px;font-weight:700;letter-spacing:0.06em;padding:2px 8px;}
  .remedy-cb{accent-color:var(--p);cursor:pointer;flex-shrink:0;margin-top:3px;}
  .remedy.recommended .remedy-cb{accent-color:var(--g);}
  .remedy-id{font-family:var(--fm);font-weight:700;color:var(--c);font-size:11px;min-width:95px;padding-top:1px;}
  .remedy.recommended .remedy-id{color:var(--g);}
  .remedy-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;}.remedy-what{font-weight:500;color:var(--text);font-size:13px;line-height:1.5;}
  .remedy-meta{font-family:var(--fm);font-size:11px;color:var(--dim);margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
  .rank-pill{font-family:var(--fm);font-size:11px;font-weight:700;padding:1px 7px;border-radius:3px;background:var(--surf-e);color:var(--muted);border:1px solid var(--bstr);}
  .apply-pill{font-family:var(--fm);font-size:11px;padding:1px 7px;border-radius:3px;}
  .apply-code{background:rgba(224,102,102,0.15);color:var(--r);border:1px solid rgba(224,102,102,0.3);}
  .apply-prompt{background:rgba(126,71,215,0.15);color:var(--p);border:1px solid rgba(126,71,215,0.3);}
  .apply-config{background:rgba(69,184,204,0.15);color:var(--c);border:1px solid rgba(69,184,204,0.3);}
  .apply-none{background:rgba(112,112,136,0.15);color:var(--dim);border:1px solid rgba(112,112,136,0.3);}
  .b-cost-low{background:rgba(67,195,154,0.18);color:var(--g);border:1px solid rgba(67,195,154,0.35);padding:1px 6px;border-radius:3px;}
  .b-cost-med{background:rgba(232,166,77,0.18);color:var(--y);border:1px solid rgba(232,166,77,0.35);padding:1px 6px;border-radius:3px;}
  .b-cost-high{background:rgba(224,102,102,0.18);color:var(--r);border:1px solid rgba(224,102,102,0.35);padding:1px 6px;border-radius:3px;}
  .entity{background:var(--surf-r);border:1px solid var(--bstr);border-radius:10px;padding:18px 20px;margin:16px 0;}
  .entity-head{display:flex;align-items:baseline;gap:12px;margin-bottom:12px;}
  .entity-name{font-size:18px;font-weight:700;color:var(--text);}
  .entity-grid{display:grid;grid-template-columns:140px 1fr;gap:8px 16px;font-size:13px;}
  .entity-grid .k{color:var(--dim);font-family:var(--fm);font-size:11px;text-transform:uppercase;letter-spacing:0.04em;padding-top:3px;}
  .entity-grid .v{color:var(--muted);}
  .access-yes{color:var(--g);font-weight:600;}.access-no{color:var(--r);font-weight:600;}
  details.expand{margin-top:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg2);}
  details.expand summary{cursor:pointer;padding:9px 12px;font-family:var(--fm);font-size:11px;color:var(--c);font-weight:600;list-style:none;}
  details.expand summary::-webkit-details-marker{display:none;}
  details.expand summary::before{content:'▶ ';color:var(--dim);}details.expand[open] summary::before{content:'▼ ';}
  details.expand pre{margin:0;padding:12px;background:#0a0a14;color:#c4c4d4;font-family:var(--fm);font-size:11px;white-space:pre-wrap;word-break:break-word;border-top:1px solid var(--border);max-height:340px;overflow:auto;border-radius:0 0 6px 6px;}
  .f-desc{margin:10px 0;font-size:13px;color:var(--muted);line-height:1.6;}
  .f-desc strong{color:var(--text);}
  .big-stat{display:flex;gap:18px;flex-wrap:wrap;margin:16px 0;}
  .big-stat .s{background:var(--surf-r);border:1px solid var(--border);border-radius:8px;padding:12px 16px;min-width:96px;}
  .big-stat .v{font-size:22px;font-weight:700;font-family:var(--fm);}
  .big-stat .l{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:0.06em;margin-top:2px;}
  /* scan-coverage funnel */
  .funnel{display:flex;align-items:stretch;gap:0;margin:14px 0;border-radius:8px;overflow:hidden;border:1px solid var(--border);}
  .funnel .seg{padding:12px 16px;display:flex;flex-direction:column;justify-content:center;position:relative;}
  .funnel .seg .fv{font-family:var(--fm);font-weight:700;font-size:20px;}
  .funnel .seg .fl{font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-top:2px;}
  .funnel .seg .fp{font-family:var(--fm);font-size:11px;opacity:0.7;margin-top:2px;}
  .funnel .s-total{background:var(--surf-r);flex:3;}
  .funnel .s-code{background:rgba(69,184,204,0.10);flex:3;border-left:1px solid var(--border);}
  .funnel .s-llm{background:rgba(126,71,215,0.12);flex:1;border-left:1px solid var(--border);}
  .funnel .s-total .fv{color:var(--text);}.funnel .s-code .fv{color:var(--c);}.funnel .s-llm .fv{color:var(--p);}
  /* heatmap */
  .heat{display:flex;flex-wrap:wrap;gap:3px;margin:12px 0;}
  .heat .cell{width:42px;height:42px;border-radius:5px;border:1px solid var(--border);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:var(--fm);cursor:default;}
  .heat .cell .ch{font-size:11px;color:rgba(255,255,255,0.55);}
  .heat .cell .cn{font-size:11px;font-weight:600;color:#fff;}
  .heat-legend{display:flex;gap:10px;align-items:center;font-family:var(--fm);font-size:11px;color:var(--dim);margin-top:6px;}
  .heat-legend .sw{width:14px;height:14px;border-radius:3px;display:inline-block;vertical-align:middle;margin-right:3px;}
  .l0{background:rgba(67,195,154,0.25);}.l1{background:rgba(232,166,77,0.28);}.l2{background:rgba(232,166,77,0.40);}.l3{background:rgba(224,102,102,0.42);}.l4{background:rgba(224,102,102,0.58);}
  .mermaid{background:var(--surf-r);border:1px solid var(--bstr);border-radius:8px;padding:18px;margin:14px 0;text-align:center;overflow-x:auto;}
  .action-bar{position:fixed;bottom:24px;right:24px;display:flex;gap:10px;z-index:1000;}
  .action-bar button{padding:11px 18px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,0.35);font-family:var(--fs);}
  .action-bar button#reset-all{background:var(--surf-e);color:var(--muted);border:1px solid var(--bstr);}
  /* D2: the Copy-decisions CTA is the PRIMARY action of the Decisions panel — it lives
     INSIDE that panel (renderDecisionsTab) and sticks to the panel's top-right edge just
     below the sticky tab bar. The transparent bar lets content scroll under it on the
     left while the opaque purple button covers it on the right. */
  .decisions-cta-bar{position:sticky;top:44px;z-index:50;display:flex;justify-content:flex-end;margin:-8px 0 14px 0;pointer-events:none;}
  .decisions-cta-bar button#copy-decisions{pointer-events:auto;background:var(--p-strong);color:#fff;border:1px solid var(--p);padding:11px 18px;cursor:pointer;font-size:13px;font-weight:600;box-shadow:0 2px 10px rgba(0,0,0,0.45);font-family:var(--fs);}
  .decisions-cta-bar button#copy-decisions:hover{filter:brightness(1.08);}
  .approved-count{position:fixed;bottom:24px;left:24px;background:var(--surf-e);border:1px solid var(--bstr);border-radius:8px;padding:9px 16px;font-family:var(--fm);font-size:12px;color:var(--muted);z-index:1000;}
  .approved-count strong{color:var(--p);font-weight:700;}
  .remedy-notes{width:100%;margin-top:8px;min-height:40px;padding:7px 10px;font-family:var(--fm);font-size:11px;background:#0a0a14;color:var(--text);border:1px solid var(--bstr);border-radius:4px;resize:vertical;line-height:1.45;}
  .remedy-notes::placeholder{color:var(--dim);font-style:italic;}
  .remedy-notes:focus{outline:none;border-color:var(--p);box-shadow:0 0 0 2px rgba(126,71,215,0.15);}
  .gfeedback{background:var(--surf-e);border:1px solid var(--bstr);border-radius:10px;padding:18px 20px;margin:16px 0;}
  .gfeedback h4{margin:0 0 8px 0;color:var(--p);font-size:12px;text-transform:uppercase;letter-spacing:0.06em;font-family:var(--fm);}
  .gfeedback textarea{width:100%;min-height:120px;padding:11px 14px;font-family:var(--fm);font-size:13px;background:#0a0a14;color:var(--text);border:1px solid var(--bstr);border-radius:8px;resize:vertical;line-height:1.6;}
  .gfeedback textarea::placeholder{color:var(--dim);font-style:italic;}
  .gfeedback textarea:focus{outline:none;border-color:var(--p);box-shadow:0 0 0 2px rgba(126,71,215,0.15);}
  /* Wave-6 R2.5 — coverage proof */
  .coverage-proof{margin:16px 0;}
  /* PRD-CC-05 — canonical remedy card anatomy (D1/D3/D4/D5/D6) */
  .remedy-header{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;}
  .remedy-rank-id{display:flex;align-items:center;gap:6px;flex-shrink:0;}
  .r-rationale{background:rgba(126,71,215,0.10);border-left:3px solid var(--p);padding:10px 14px;margin:10px 0;}
  .r-why-works{background:rgba(69,184,204,0.10);border-left:3px solid var(--c);padding:10px 14px;margin:10px 0;}
  .r-rationale p,.r-why-works p{margin:4px 0 0 0;font-size:13px;color:var(--muted);line-height:1.55;}
  .r-block-label{font-family:var(--fm);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--dim);}
  .r-rationale .r-block-label{color:var(--p);}
  .r-why-works .r-block-label{color:var(--c);}
  .r-target{border:1px dashed var(--border);border-radius:5px;padding:7px 12px;margin:8px 0;display:flex;align-items:center;gap:8px;font-size:12px;}
  .r-target-label{font-family:var(--fm);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--dim);flex-shrink:0;}
  .r-diff-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0;}
  .diff-col{display:flex;flex-direction:column;}
  .diff-col pre{margin:0;padding:10px;background:#0a0a14;color:#c4c4d4;font-family:var(--fm);font-size:11px;white-space:pre-wrap;word-break:break-word;border:1px solid var(--border);border-radius:0 0 5px 5px;flex:1;}
  .diff-label{padding:4px 10px;font-family:var(--fm);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-radius:5px 5px 0 0;}
  .diff-label.label-before{background:rgba(224,102,102,0.18);color:var(--r);}
  .diff-label.label-after{background:rgba(67,195,154,0.18);color:var(--g);}
  /* W12-08: source-not-found caveat shown in place of the Before/After grid (PR-052 proposed). */
  .r-diff-caveat{border:1px dashed var(--y);border-radius:5px;padding:10px 12px;margin:10px 0;background:rgba(232,166,77,0.07);}
  .r-diff-caveat-label{font-family:var(--fm);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--y);margin-bottom:5px;}
  .r-diff-caveat p{margin:0;font-size:12px;color:var(--dim);}
  .r-apply-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:10px 0;}
  .apply-col{background:var(--surf-e);border:1px solid var(--border);border-radius:6px;padding:12px 14px;}
  .apply-col-empty{opacity:0.6;}
  .apply-col-label{font-family:var(--fm);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--c);margin-bottom:6px;}
  .r-apply-plan,.r-apply-instr{margin:6px 0;padding-left:16px;font-size:12px;color:var(--muted);}
  .r-apply-plan li,.r-apply-instr li{margin:3px 0;}
  .r-verify-label{font-family:var(--fm);font-size:11px;text-transform:uppercase;color:var(--dim);margin-top:6px;}
  .r-acceptance{font-size:12px;color:var(--g);margin-top:6px;font-style:italic;}
  .r-commit{font-size:11px;color:var(--dim);margin-top:4px;}
  .r-line-range{color:var(--dim);font-size:11px;}
  .r-muted{font-size:12px;color:var(--dim);margin:4px 0 0 0;}
  .r-count{font-family:var(--fm);font-size:11px;color:var(--dim);font-weight:400;}
  /* PRD-CC-05 — feedback block (D5/D9 — no emojis) */
  .feedback-list{margin:12px 0;}
  .feedback-list h3{margin-top:0;color:var(--c);}
  .fb-item{border-radius:6px;padding:10px 14px;margin:8px 0;border-left:3px solid var(--border);}
  .fb-item blockquote{margin:6px 0 0 0;font-size:13px;color:var(--muted);border-left:none;padding:0;}
  .fb-item.fb-chat{border-left-color:var(--c);background:rgba(69,184,204,0.07);}
  .fb-item.fb-trace-score{border-left-color:var(--y);background:rgba(232,166,77,0.07);}
  .fb-item.fb-external{border-left-color:var(--p);background:rgba(126,71,215,0.07);}
  .fb-head{font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:4px;align-items:center;}
  .fb-source-type{font-family:var(--fm);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;}
  .fb-item.fb-chat .fb-source-type{color:var(--c);}
  .fb-item.fb-trace-score .fb-source-type{color:var(--y);}
  .fb-item.fb-external .fb-source-type{color:var(--p);}
  .fb-score-note{font-family:var(--fm);font-size:11px;color:var(--dim);}
  /* PRD-CC-05 — targetClass + changeType pills */
  .tclass-pill{font-family:var(--fm);font-size:11px;padding:1px 7px;border-radius:3px;}
  .tclass-local-agent{background:rgba(126,71,215,0.15);color:var(--p);border:1px solid rgba(126,71,215,0.3);}
  .tclass-local-code-construct{background:rgba(69,184,204,0.15);color:var(--c);border:1px solid rgba(69,184,204,0.3);}
  .tclass-remote{background:rgba(232,166,77,0.15);color:var(--y);border:1px solid rgba(232,166,77,0.3);}
  .ctype-pill{font-family:var(--fm);font-size:11px;padding:1px 7px;border-radius:3px;}
  .ctype-add{background:rgba(67,195,154,0.15);color:var(--g);border:1px solid rgba(67,195,154,0.3);}
  .ctype-modify{background:rgba(69,184,204,0.15);color:var(--c);border:1px solid rgba(69,184,204,0.3);}
  .ctype-replace{background:rgba(126,71,215,0.15);color:var(--p);border:1px solid rgba(126,71,215,0.3);}
  .ctype-delete{background:rgba(224,102,102,0.15);color:var(--r);border:1px solid rgba(224,102,102,0.3);}
  /* PRD-CC-05 — correctness badge */
  .b-correctness-low{background:rgba(224,102,102,0.18);color:var(--r);border:1px solid rgba(224,102,102,0.35);padding:1px 6px;border-radius:3px;}
  .b-correctness-med{background:rgba(232,166,77,0.18);color:var(--y);border:1px solid rgba(232,166,77,0.35);padding:1px 6px;border-radius:3px;}
  .b-correctness-high{background:rgba(67,195,154,0.18);color:var(--g);border:1px solid rgba(67,195,154,0.35);padding:1px 6px;border-radius:3px;}
  /* PRD-CC-06 — live preview textarea in Decisions panel */
  .live-preview{background:var(--surf-e);border:1px solid var(--bstr);border-radius:8px;padding:14px 16px;margin:16px 0;}
  .lp-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
  .lp-label{font-family:var(--fm);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--c);}
  .lp-meta{font-family:var(--fm);font-size:11px;color:var(--dim);}
  .lp-body{width:100%;min-height:160px;padding:10px 12px;font-family:var(--fm);font-size:11px;background:#0a0a14;color:#c4c4d4;border:1px solid var(--bstr);border-radius:6px;resize:vertical;line-height:1.5;}
  /* PRD-SD-06 — decisions subject row */
  .decisions-subject-row{font-family:var(--fm);font-size:12px;color:var(--dim);margin:8px 0;padding:6px 10px;background:var(--surf-r);border-radius:5px;display:flex;gap:8px;align-items:center;}
  /* Wave-6 R2.4 — methodology widgets (tier pie · selection cards · trace) */
  .pie-legend{display:flex;flex-wrap:wrap;gap:12px;margin:8px 0 4px 0;font-size:12px;font-family:var(--fm);}
  .pie-leg{display:inline-flex;align-items:center;gap:6px;color:var(--muted);}
  .pie-sw{display:inline-block;width:12px;height:12px;border-radius:3px;}
  .sel-cards{display:flex;flex-wrap:wrap;gap:12px;margin:10px 0;}
  .sel-card{flex:1 1 220px;background:var(--surf-e);border:1px solid var(--bstr);border-radius:8px;padding:12px 14px;}
  .sel-card-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
  .sel-card-body{font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;}
  .sel-k{text-transform:uppercase;letter-spacing:0.05em;font-size:11px;color:var(--dim);font-family:var(--fm);}
  /* D3: richer dataset-candidate detail rows — each links the discovered signal to its
     finding's RCA narrative (scenario · edge-case · why-failed · why-high-value · prevents). */
  .sel-detail{font-size:12px;color:var(--muted);line-height:1.5;margin-top:7px;width:100%;}
  .sel-detail .sel-k{display:block;margin-bottom:1px;color:var(--c);}
  .sel-detail.sel-prevents .sel-k{color:var(--g);}
  .sel-detail.sel-value .sel-k{color:var(--p);}
  /* design-system: SHARP corners (radius 0) is the brand — enforce across every element,
     including inline-styled nodes emitted by render.ts and the structured-report template. */
  *,*::before,*::after{border-radius:0!important;}
</style></head><body>
<header class="banner">
  <div class="brand"><div class="logo">MUTAGENT</div><div class="product">{{HEADER_TITLE}}</div></div>
  <div class="meta">{{HEADER_META}}</div>
</header>
{{INTERNAL_BANNER_FORCE}}

<nav class="tabs" id="tabnav">{{TAB_NAV_HTML}}</nav>

<main>
{{INTERNAL_BANNER_HTML}}
{{METHODOLOGY_PANEL_HTML}}
{{OVERVIEW_PANEL_HTML}}
{{FUNNEL_HEATMAP_HTML}}
{{FINDING_PANELS_HTML}}
{{DECISIONS_PANEL_HTML}}
</main>

<div class="approved-count">Selected: <strong id="approved-count">0</strong> of {{APPROVED_COUNT_DENOMINATOR}}</div>
<div class="action-bar"><button id="reset-all">Reset all</button></div>

<!-- generated: {{GENERATED_AT}} -->
{{FINDINGS_JSONLD}}
{{MERMAID_SCRIPT_HTML}}
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>
try { mermaid.initialize({ startOnLoad: true, theme: 'dark', themeVariables: { primaryColor:'#1a1a25', primaryTextColor:'#eef1f6', primaryBorderColor:'#7E47D7', lineColor:'#b794f4', actorBkg:'#1a1a25', actorBorder:'#7E47D7', actorTextColor:'#eef1f6', noteBkgColor:'#22222f', noteTextColor:'#a6a2b4', noteBorderColor:'#45b8cc' }, securityLevel:'loose' }); } catch(e) {}
document.querySelectorAll('nav.tabs button').forEach(function(btn){
  btn.addEventListener('click', function(){
    var t = btn.dataset.tab;
    document.querySelectorAll('nav.tabs button').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach(function(p){ p.classList.remove('active'); });
    var panel = document.getElementById(t);
    if (panel) panel.classList.add('active');
    window.scrollTo({top:0,behavior:'instant'});
  });
});
// inject per-remedy notes textareas (idempotent — W12-04 restored the
// `.remedy-body` wrapper, and renderRemedyCard now emits its own `.remedy-notes`
// inside it; skip injection when one already exists to avoid double textareas)
document.querySelectorAll('.remedy').forEach(function(r){
  var body = r.querySelector('.remedy-body'); if (!body) return;
  if (body.querySelector('.remedy-notes')) return;
  var ta = document.createElement('textarea');
  ta.className = 'remedy-notes';
  ta.placeholder = 'Notes / conditions on this remedy — voice-dump welcome (overrides, caveats, why-not)…';
  body.appendChild(ta);
});
function updateApprovedCount(){ document.getElementById('approved-count').textContent = document.querySelectorAll('.remedy-cb:checked').length; }
document.querySelectorAll('.remedy-cb').forEach(function(cb){ cb.addEventListener('change', updateApprovedCount); });
updateApprovedCount();
var _copyBtn0 = document.getElementById('copy-decisions');
if (_copyBtn0) _copyBtn0.addEventListener('click', function(){
  var txt=function(e){return e?e.textContent.trim().replace(/\s+/g,' '):'';};
  var lines = ['# Approved Remedies (handoff)','','Generated: ' + new Date().toISOString(),'','---',''];
  var checked = Array.from(document.querySelectorAll('.remedy-cb:checked'));
  if (checked.length === 0) { lines.push('_No remedies selected._'); }
  else { checked.forEach(function(cb){
    var card = cb.closest('.remedy'); var panel = cb.closest('.panel');
    var rid = cb.dataset.id || '?'; var fid = cb.dataset.finding || '?';
    var rec = card.classList.contains('recommended') ? ' ★RECOMMENDED' : '';
    var apply = card.querySelector('.apply-pill') ? card.querySelector('.apply-pill').textContent.trim() : '';
    var cost=''; card.querySelectorAll('.remedy-meta span').forEach(function(s){ if(/cost:/.test(s.textContent)) cost=s.textContent.trim(); });
    var what = txt(card.querySelector('.remedy-what'));
    var fhead = panel ? txt(panel.querySelector('h2')) : '';
    var tax = panel ? Array.from(panel.querySelectorAll('.taxonomy .tax-chip')).map(function(c){return txt(c);}).join(' · ') : '';
    var evid = panel ? txt(panel.querySelector('h3 + p')) : '';
    var origin = panel ? txt(panel.querySelector('.whychain li.origin')) : '';
    var assume = panel ? Array.from(panel.querySelectorAll('.assumptions li')).map(function(l){return txt(l);}) : [];
    lines.push('## ' + rid + ' (' + fid + ')' + rec + '  [' + apply + (cost?' · '+cost:'') + ']');
    lines.push('**Remedy:** ' + what);
    if (fhead) lines.push('**Finding:** ' + fhead);
    if (tax) lines.push('**Taxonomy:** ' + tax);
    if (origin) lines.push('**Root cause (origin):** ' + origin);
    if (evid) lines.push('**Evidence:** ' + evid);
    if (assume.length){ lines.push('**Assumptions:**'); assume.forEach(function(a){ lines.push('- ' + a); }); }
    var note = card.querySelector('.remedy-notes');
    if (note && note.value.trim()) { lines.push('**Operator notes:**'); note.value.trim().split(/\r?\n/).forEach(function(ln){ lines.push('> ' + ln); }); }
    lines.push('');
  }); }
  var rejected = Array.from(document.querySelectorAll('.remedy-cb:not(:checked)')).filter(function(cb){ var t=cb.closest('.remedy').querySelector('.remedy-notes'); return t && t.value.trim(); });
  if (rejected.length){ lines.push('---'); lines.push(''); lines.push('## Not selected (with rationale)'); lines.push(''); rejected.forEach(function(cb){
    var card=cb.closest('.remedy'); var rid=cb.dataset.id||'?'; var fid=cb.dataset.finding||'?';
    lines.push('- [ ] `'+rid+'` ('+fid+') — '+txt(card.querySelector('.remedy-what'))); card.querySelector('.remedy-notes').value.trim().split(/\r?\n/).forEach(function(ln){ lines.push('  > '+ln); });
  }); lines.push(''); }
  var gf = document.getElementById('general-feedback');
  if (gf && gf.value.trim()){ lines.push('---'); lines.push(''); lines.push('## General feedback'); lines.push(''); lines.push(gf.value.trim()); lines.push(''); }
  var text = lines.join('\n');
  navigator.clipboard.writeText(text).then(function(){ var b=document.getElementById('copy-decisions'),o=b.textContent; b.textContent='Copied ✓ — paste in chat'; setTimeout(function(){b.textContent=o;},2200); }).catch(function(){ window.prompt('Copy:', text); });
});
document.getElementById('reset-all').addEventListener('click', function(){ if(!confirm('Reset all selections + notes?'))return; document.querySelectorAll('.remedy-cb').forEach(function(cb){cb.checked=false;}); document.querySelectorAll('.remedy-notes').forEach(function(t){t.value='';}); var gf=document.getElementById('general-feedback'); if(gf)gf.value=''; updateApprovedCount(); });
</script>
</body></html>
