<!DOCTYPE html>
<!--
  ╔══════════════════════════════════════════════════════════════════════════╗
  ║  wave-dashboard-template.html                                            ║
  ║  INTERNAL DEV TEMPLATE — Design tier 1 — NOT SHIPPED TO END USERS       ║
  ╠══════════════════════════════════════════════════════════════════════════╣
  ║  THREE-TIER MODEL                                                        ║
  ║                                                                          ║
  ║  Tier 1 · Design (internal dev) — THIS FILE                             ║
  ║    tracks skill development + design + docs across waves                 ║
  ║    stripped on publish via .npmignore / internal/ exclusion              ║
  ║                                                                          ║
  ║  Tier 2 · Runtime (ships with skill)                                    ║
  ║    what the skill produces per diagnostic run                            ║
  ║    lives at: assets/templates/report.html.tpl (+ sister .tpl files)     ║
  ║    UNTOUCHED by this template — DO NOT modify via this file              ║
  ║                                                                          ║
  ║  Tier 3 · Meta-diag (skill-on-itself)                                   ║
  ║    skill reports its own issues / health / coverage                      ║
  ║    DEFERRED — operator is building a standalone version;                 ║
  ║    requirements TBD after dogfood completes                              ║
  ║    DO NOT add "Meta-Diag" tab/section to this template                  ║
  ╠══════════════════════════════════════════════════════════════════════════╣
  ║  PURPOSE                                                                 ║
  ║    Unified per-wave artifact. Replaces the need to maintain three        ║
  ║    separate internal templates (iteration + status + skill-overview)     ║
  ║    for a single wave's context. All four views live in one file:         ║
  ║                                                                          ║
  ║    Tab ① Kanban      — WIP board + phase cards + drift + OQs + lockins  ║
  ║    Tab ② Skill Ovw.  — §0–§9 walkthrough + §8 Design Principles         ║
  ║    Tab ③ Audit Mx.   — criteria matrix + context map + timeline + princ ║
  ║    Tab ④ Doc Map     — Mermaid dep graph + change-propagation table      ║
  ╠══════════════════════════════════════════════════════════════════════════╣
  ║  HOW TO USE                                                              ║
  ║    1. Replace {{WAVE_N}} with the wave number (e.g. "3", "4", "5")      ║
  ║    2. Replace {{wave_subtitle}} with the wave state line                 ║
  ║       (e.g. "Wave-3 Phase A LANDED · awaits dogfood-3")                 ║
  ║    3. Fill metric cards above the tabs with wave-level counts            ║
  ║    4. Populate sub-panels from SKILL.md + engineering docs               ║
  ║    5. Open in browser to verify; use "Copy Decisions" to export lockins  ║
  ║    6. Delete this comment block once filled for a real wave              ║
  ╠══════════════════════════════════════════════════════════════════════════╣
  ║  RELATIONSHIP TO LEGACY TEMPLATES                                        ║
  ║    iteration-template.html   — legacy · kept for ad-hoc standalone fork  ║
  ║    status-template.html      — legacy · kept for ad-hoc standalone fork  ║
  ║    skill-overview-template.html — legacy · kept for ad-hoc standalone   ║
  ║    This file (wave-dashboard-template.html) is RECOMMENDED for new waves ║
  ╚══════════════════════════════════════════════════════════════════════════╝
-->
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<title>MUTAGENT — {{SKILL_DISPLAY_NAME}} · Wave-{{WAVE_N}} Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  /* ╔══════════════════════════════════════════════════════════════════════╗
     ║  MUTAGENT brand tokens — keep this :root block intact across reuses  ║
     ╚══════════════════════════════════════════════════════════════════════╝ */
  :root {
    /* surfaces */
    --bg: #0a0a10; --bg2: #14141e; --bg3: #181824;
    --surf: #1c1c2a; --surf-e: #252535; --surf-h: #2f2f42;
    /* text */
    --text: #f5f5f9; --muted: #b0b0c4; --dim: #707088;
    /* lines */
    --border: rgba(255,255,255,0.08); --bstr: rgba(255,255,255,0.15);
    /* accents — purple primary, cyan secondary (MUTAGENT gradient) */
    --p: #a78bfa; --c: #06b6d4;
    /* status accents */
    --g: #10b981; --y: #f59e0b; --r: #ef4444; --m: #f0abfc;
    /* effects */
    --glow: rgba(167,139,250,0.25);
    /* type */
    --fs: 'Space Grotesk', system-ui, -apple-system, sans-serif;
    --fm: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
  }

  *{box-sizing:border-box;}
  body{margin:0;font-family:var(--fs);color:var(--text);background:var(--bg);font-size:14px;line-height:1.55;}

  /* ─── Internal badge strip ──────────────────────────────────────────── */
  .internal-strip{background:rgba(245,158,11,0.08);border-bottom:2px solid rgba(245,158,11,0.3);padding:6px 32px;font-family:var(--fm);font-size:11px;color:var(--y);letter-spacing:0.04em;}

  /* ─── Header banner with MUTAGENT logotype (purple→cyan gradient) ──── */
  header.banner{background:linear-gradient(135deg,#0a0a14 0%,#1a1a2e 50%,#16213e 100%);border-bottom:1px solid var(--bstr);padding:20px 32px;position:relative;}
  header.banner::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--p),var(--c),transparent);}
  .brand{display:flex;align-items:baseline;gap:14px;margin-bottom:6px;}
  .logo{font-family:var(--fs);font-weight:700;font-size:22px;letter-spacing:0.18em;background:linear-gradient(135deg,var(--p) 0%,var(--c) 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;text-shadow:0 0 30px var(--glow);}
  .product{font-size:14px;font-weight:500;color:var(--muted);letter-spacing:0.04em;}
  .meta{font-size:11px;opacity:0.7;font-family:var(--fm);color:var(--dim);}

  /* ─── Top-level tab nav (sticky) ──────────────────────────────────── */
  nav.tabs{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 12px;position:sticky;top:0;z-index:100;box-shadow:0 2px 12px rgba(0,0,0,0.4);overflow-x:auto;white-space:nowrap;}
  nav.tabs button{background:none;border:none;padding:12px 14px;font-size:12px;font-weight:500;color:var(--muted);cursor:pointer;border-bottom:3px solid transparent;font-family:inherit;letter-spacing:0.01em;}
  nav.tabs button:hover{color:var(--text);background:var(--surf-h);}
  nav.tabs button.active{color:var(--p);border-bottom-color:var(--p);font-weight:600;}

  /* ─── Sub-tab nav (inside each panel) ──────────────────────────────── */
  nav.subtabs{background:var(--bg3);border-bottom:1px solid var(--border);padding:0 8px;margin-bottom:20px;overflow-x:auto;white-space:nowrap;border-radius:8px 8px 0 0;}
  nav.subtabs button{background:none;border:none;padding:8px 11px;font-size:11px;font-weight:500;color:var(--dim);cursor:pointer;border-bottom:2px solid transparent;font-family:inherit;letter-spacing:0.01em;}
  nav.subtabs button:hover{color:var(--text);background:var(--surf-h);}
  nav.subtabs button.active{color:var(--c);border-bottom-color:var(--c);font-weight:600;}

  main{max-width:1280px;margin:0 auto;padding:28px 32px 80px 32px;}

  /* ─── Top-level panels ──────────────────────────────────────────────── */
  .panel{display:none;}.panel.active{display:block;animation:fade 0.2s ease-out;}
  @keyframes fade{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:translateY(0);}}

  /* ─── Sub-panels ─────────────────────────────────────────────────────── */
  .subpanel{display:none;}.subpanel.active{display:block;animation:fade 0.15s ease-out;}

  /* ─── Typography ──────────────────────────────────────────────────── */
  h2{font-size:22px;font-weight:600;margin:0 0 8px 0;padding-bottom:10px;border-bottom:1px solid var(--bstr);}
  h3{font-size:16px;font-weight:600;margin-top:24px;color:var(--p);}
  h4{font-size:14px;font-weight:600;margin-top:16px;color:var(--text);}
  p{color:var(--muted);}strong{color:var(--text);}
  .sub{color:var(--muted);font-size:13px;margin-bottom:24px;}

  /* ─── Code ─────────────────────────────────────────────────────────── */
  code{background:#0a0a14;color:var(--m);padding:2px 6px;border-radius:4px;font-size:0.88em;font-family:var(--fm);border:1px solid var(--border);}
  pre{background:#0a0a14;color:#c4c4d4;padding:14px 16px;border-radius:8px;overflow-x:auto;font-size:12px;font-family:var(--fm);white-space:pre;margin:12px 0;border:1px solid var(--border);}
  pre code{background:none;color:inherit;padding:0;border:none;}

  /* ─── Tables ──────────────────────────────────────────────────────── */
  table{border-collapse:collapse;margin:12px 0;font-size:12px;width:100%;border:1px solid var(--border);border-radius:8px;overflow:hidden;}
  th,td{border:1px solid var(--border);padding:8px 12px;text-align:left;color:var(--muted);vertical-align:top;}
  th{background:var(--surf-e);color:var(--text);font-weight:600;}
  tr:nth-child(even) td{background:var(--bg3);}

  /* ─── Section containers ──────────────────────────────────────────── */
  .section{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:20px 24px;margin-bottom:18px;}

  /* ─── Callouts (rationale / delta / resolved / warn) ──────────────── */
  .rationale{background:linear-gradient(135deg,rgba(167,139,250,0.08) 0%,rgba(99,102,241,0.04) 100%);border-left:3px solid var(--p);padding:10px 14px;margin:14px 0;font-size:12px;border-radius:0 8px 8px 0;color:var(--muted);}
  .rationale strong{color:var(--p);}
  .delta{background:linear-gradient(135deg,rgba(245,158,11,0.08) 0%,rgba(217,119,6,0.04) 100%);border-left:3px solid var(--y);padding:10px 14px;margin:14px 0;font-size:12px;border-radius:0 8px 8px 0;color:var(--muted);}
  .delta strong{color:var(--y);}
  .resolved{background:linear-gradient(135deg,rgba(16,185,129,0.08) 0%,rgba(5,150,105,0.04) 100%);border-left:3px solid var(--g);padding:10px 14px;margin:12px 0;font-size:12px;border-radius:0 8px 8px 0;color:var(--muted);}
  .resolved strong{color:var(--g);}

  /* ─── Mermaid container ──────────────────────────────────────────── */
  div.mermaid{background:var(--surf);padding:20px;margin:18px 0;border:1px solid var(--bstr);border-radius:8px;text-align:center;overflow-x:auto;}

  /* ─── Lock-in widget (per-section approval) ──────────────────────── */
  .lockin{background:var(--surf-e);border:1px solid var(--bstr);border-radius:8px;padding:14px 18px;margin:24px 0 0 0;box-shadow:0 8px 24px rgba(0,0,0,0.4);}
  .lockin-title{font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--p);margin-bottom:10px;font-family:var(--fm);}
  .lockin-radios{display:flex;gap:22px;flex-wrap:wrap;margin-bottom:10px;font-size:13px;}
  .lockin-radios label{cursor:pointer;display:flex;align-items:center;gap:6px;color:var(--muted);}
  .lockin-radios label:hover{color:var(--text);}
  .lockin-radios input[type="radio"]{accent-color:var(--p);cursor:pointer;}
  .lockin textarea{width:100%;min-height:60px;padding:8px 12px;border:1px solid var(--bstr);border-radius:6px;font-family:var(--fm);font-size:12px;resize:vertical;background:#0a0a14;color:var(--text);}

  /* ─── Per-item approval row ──────────────────────────────────────── */
  .remedy{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin:8px 0;display:flex;align-items:center;gap:12px;}
  .remedy-id{font-family:var(--fm);font-weight:700;color:var(--c);font-size:11px;min-width:110px;}
  .remedy-cb{accent-color:var(--p);cursor:pointer;flex-shrink:0;}
  .remedy-body{flex:1;}
  .remedy-what{font-weight:500;color:var(--text);font-size:13px;}

  /* ─── Principle / Evidence cards ─────────────────────────────────── */
  .principle{background:var(--surf);border:1px solid var(--border);border-left:4px solid var(--m);border-radius:8px;padding:14px 18px;margin:10px 0;}
  .principle .pid{font-family:var(--fm);font-weight:700;color:var(--m);font-size:11px;letter-spacing:0.05em;}
  .principle .pt{font-weight:600;color:var(--text);font-size:14px;margin:6px 0 4px 0;}
  .principle .pb{font-size:13px;color:var(--muted);line-height:1.55;}
  .principle.proposed{border-left-color:var(--c);opacity:0.75;}
  .principle.proposed .pid{color:var(--c);}
  .evidence{background:var(--surf);border:1px solid var(--border);border-left:3px solid var(--c);border-radius:6px;padding:10px 14px;margin:8px 0;}
  .evidence .e-title{font-weight:600;color:var(--c);font-size:13px;margin-bottom:4px;font-family:var(--fm);}
  .evidence .e-ask{font-size:12px;color:var(--muted);margin:3px 0;}
  .evidence .e-ask::before{content:'→ ';color:var(--c);font-weight:600;}
  .evidence .e-pass{font-size:11px;color:var(--g);margin-top:5px;font-family:var(--fm);}
  .evidence .e-pass::before{content:'✓ pass: ';color:var(--g);}

  /* ─── Metric cards row (grid of 4) ───────────────────────────────── */
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px;}
  @media(max-width:800px){.grid{grid-template-columns:repeat(2,1fr);}}
  .card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:13px 16px;}
  .card .l{font-family:var(--fm);font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:var(--dim);}
  .card .v{font-size:22px;font-weight:600;color:var(--p);margin:5px 0 3px 0;}
  .card .d{font-size:11px;color:var(--muted);}

  /* ─── Kanban (5 columns) ─────────────────────────────────────────── */
  .kanban{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;}
  @media(max-width:1000px){.kanban{grid-template-columns:repeat(2,1fr);}}
  .col{background:var(--surf);border:1px solid var(--border);border-radius:8px;padding:10px 11px;min-height:240px;}
  .col-h{font-family:var(--fm);font-size:10px;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border);display:flex;align-items:baseline;gap:8px;}
  .col-h .ct{margin-left:auto;background:var(--bg);color:var(--dim);padding:1px 6px;border-radius:3px;font-size:9px;}
  .col.backlog{border-top:3px solid var(--dim);}.col.backlog .col-h{color:var(--dim);}
  .col.inflight{border-top:3px solid var(--y);}.col.inflight .col-h{color:var(--y);}
  .col.dogfood{border-top:3px solid var(--c);}.col.dogfood .col-h{color:var(--c);}
  .col.verified{border-top:3px solid var(--p);}.col.verified .col-h{color:var(--p);}
  .col.shipped{border-top:3px solid var(--g);}.col.shipped .col-h{color:var(--g);}
  .kcard{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:7px 10px;margin:6px 0;font-size:11px;line-height:1.4;}
  .kcard .kt{font-weight:600;color:var(--text);font-size:11px;margin-bottom:2px;}
  .kcard .km{font-family:var(--fm);color:var(--dim);font-size:10px;}
  .kcard.now{box-shadow:0 0 0 1px var(--y);animation:pulse 2s infinite;}
  .kcard.v01{border-left:2px solid var(--g);}.kcard.v02{border-left:2px solid var(--c);}.kcard.v03{border-left:2px solid var(--y);}.kcard.v04{border-left:2px solid var(--m);}.kcard.v05{border-left:2px solid var(--p);}
  @keyframes pulse{0%,100%{box-shadow:0 0 0 1px var(--y),0 0 0 0 rgba(245,158,11,0.4);}50%{box-shadow:0 0 0 1px var(--y),0 0 0 6px rgba(245,158,11,0);}}

  /* ─── Tree changelog ─────────────────────────────────────────────── */
  .tree{background:#0a0a14;border:1px solid var(--border);border-radius:8px;padding:14px 18px;font-family:var(--fm);font-size:12px;line-height:1.7;white-space:pre;color:var(--muted);overflow-x:auto;}
  .tree b{color:var(--p);font-weight:600;}
  .tree i{color:var(--c);font-style:normal;}
  .tree em{color:var(--dim);font-style:italic;}

  /* ─── Vertical timeline ──────────────────────────────────────────── */
  .timeline{position:relative;padding-left:24px;border-left:2px solid var(--border);}
  .ev{position:relative;padding:8px 0;}
  .ev::before{content:'';position:absolute;left:-30px;top:14px;width:10px;height:10px;border-radius:50%;background:var(--p);border:2px solid var(--bg2);}
  .ev.done::before{background:var(--g);}.ev.current::before{background:var(--y);box-shadow:0 0 0 4px rgba(245,158,11,0.2);}
  .ev .date{font-family:var(--fm);font-size:10px;color:var(--dim);}
  .ev .title{font-weight:600;font-size:13px;color:var(--text);margin:2px 0;}
  .ev .desc{font-size:12px;color:var(--muted);}

  /* ─── Badges ─────────────────────────────────────────────────────── */
  .badge{display:inline-block;padding:2px 7px;font-size:10px;border-radius:4px;font-weight:600;letter-spacing:0.04em;font-family:var(--fm);margin-right:4px;}
  .b-new{background:rgba(16,185,129,0.18);color:var(--g);border:1px solid rgba(16,185,129,0.35);}
  .b-changed{background:rgba(245,158,11,0.18);color:var(--y);border:1px solid rgba(245,158,11,0.35);}
  .b-locked{background:rgba(6,182,212,0.18);color:var(--c);border:1px solid rgba(6,182,212,0.35);}
  .b-dropped{background:rgba(239,68,68,0.18);color:var(--r);border:1px solid rgba(239,68,68,0.35);}

  /* ─── Success Criteria Matrix pills ───────────────────────────────── */
  .matrix th{background:var(--surf-e);color:var(--text);font-weight:600;font-size:11px;}
  .matrix td{font-size:11px;line-height:1.5;}
  .matrix em{color:var(--dim);font-style:italic;}
  .pill{display:inline-block;padding:2px 8px;font-size:10px;border-radius:12px;font-weight:600;font-family:var(--fm);letter-spacing:0.04em;white-space:nowrap;}
  .pill.p-green{background:rgba(16,185,129,0.18);color:var(--g);border:1px solid rgba(16,185,129,0.4);}
  .pill.p-blue{background:rgba(6,182,212,0.18);color:var(--c);border:1px solid rgba(6,182,212,0.4);}
  .pill.p-yellow{background:rgba(245,158,11,0.18);color:var(--y);border:1px solid rgba(245,158,11,0.4);}
  .pill.p-white{background:rgba(176,176,196,0.15);color:var(--muted);border:1px solid rgba(176,176,196,0.3);}
  .pill.p-red{background:rgba(239,68,68,0.18);color:var(--r);border:1px solid rgba(239,68,68,0.4);}
  .pill.p-purple{background:rgba(240,171,252,0.18);color:var(--m);border:1px solid rgba(240,171,252,0.4);}

  /* ─── Phase card (feature/issue-style description block) ─────────── */
  .phase-card{background:var(--bg2);border:1px solid var(--border);border-left:5px solid var(--p);border-radius:10px;padding:18px 22px;margin:18px 0;}
  .phase-card.phase-safe{border-left-color:var(--g);}
  .phase-card.phase-arch{border-left-color:var(--y);border-left-width:6px;background:linear-gradient(135deg,rgba(245,158,11,0.05) 0%,var(--bg2) 100%);}
  .phase-card.phase-medium{border-left-color:var(--c);}
  .phase-head{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border);}
  .phase-id{font-family:var(--fm);font-weight:700;color:var(--p);font-size:13px;letter-spacing:0.06em;text-transform:uppercase;}
  .phase-card.phase-safe .phase-id{color:var(--g);}
  .phase-card.phase-arch .phase-id{color:var(--y);}
  .phase-card.phase-medium .phase-id{color:var(--c);}
  .phase-title{flex:1;font-weight:600;color:var(--text);font-size:15px;}
  .phase-tags{display:flex;gap:6px;flex-wrap:wrap;}
  .phase-sub{margin:14px 0;}
  .phase-sub h4{margin:0 0 8px 0;font-size:13px;color:var(--c);}
  .phase-sub p,.phase-sub li{font-size:13px;color:var(--muted);line-height:1.6;}
  .phase-sub ol,.phase-sub ul{margin:8px 0 8px 22px;padding:0;}
  .phase-sub ol li,.phase-sub ul li{margin:6px 0;}
  .phase-sub ol li strong,.phase-sub ul li strong{color:var(--text);}
  .phase-sub pre{font-size:11px;margin:8px 0;padding:10px 12px;}
  .phase-sub table{margin:8px 0;font-size:11px;}
  .vstamp{background:linear-gradient(135deg,rgba(240,171,252,0.08) 0%,rgba(167,139,250,0.04) 100%);border-left:3px solid var(--m);padding:8px 12px;border-radius:0 6px 6px 0;margin:8px 0;font-size:12px;color:var(--muted);}
  .vstamp strong{color:var(--m);}
  .note{background:linear-gradient(135deg,rgba(6,182,212,0.08) 0%,rgba(6,182,212,0.02) 100%);border-left:3px solid var(--c);padding:8px 12px;border-radius:0 6px 6px 0;margin:8px 0;font-size:12px;color:var(--muted);}
  .note strong{color:var(--c);}
  .phase-meta-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0;padding:10px 0;border-top:1px dashed var(--border);border-bottom:1px dashed var(--border);}
  @media(max-width:800px){.phase-meta-row{grid-template-columns:repeat(2,1fr);}}
  .phase-meta-block{font-size:11px;color:var(--dim);}
  .phase-meta-block strong{color:var(--text);font-size:11px;display:block;margin-bottom:3px;font-family:var(--fm);text-transform:uppercase;letter-spacing:0.06em;}
  .phase-meta-block .meta-val{color:var(--muted);}

  /* ─── Open Questions / Drift items ──────────────────────────────── */
  .oq{background:var(--surf);border:1px solid var(--border);border-left:3px solid var(--y);border-radius:6px;padding:10px 14px;margin:8px 0;}
  .oq .oq-id{font-family:var(--fm);font-size:10px;font-weight:700;color:var(--y);text-transform:uppercase;letter-spacing:0.06em;}
  .oq .oq-body{font-size:13px;color:var(--muted);margin-top:4px;}
  .oq.resolved-oq{border-left-color:var(--g);opacity:0.7;}
  .oq.resolved-oq .oq-id{color:var(--g);}

  /* ─── Drift item ─────────────────────────────────────────────────── */
  .drift{background:var(--surf);border:1px solid var(--border);border-left:3px solid var(--r);border-radius:6px;padding:10px 14px;margin:8px 0;}
  .drift .drift-id{font-family:var(--fm);font-size:10px;font-weight:700;color:var(--r);}
  .drift .drift-body{font-size:13px;color:var(--muted);margin-top:4px;}
  .drift .drift-fix{font-size:12px;color:var(--g);margin-top:4px;}
  .drift .drift-fix::before{content:'Fix: ';font-weight:700;}

  /* ─── Three-column grid ──────────────────────────────────────────── */
  .three-col{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:14px 0;}
  @media(max-width:900px){.three-col{grid-template-columns:1fr;}}
  .tax-card{background:var(--surf);border:1px solid var(--border);border-radius:8px;padding:14px 16px;}
  .tax-card h4{margin-top:0;color:var(--c);font-family:var(--fm);text-transform:uppercase;letter-spacing:0.08em;font-size:12px;}
  .tax-card ul{margin:8px 0 0 18px;padding:0;}
  .tax-card li{font-size:12px;color:var(--muted);margin:4px 0;}

  /* ─── Action bar (floating bottom-right) ─────────────────────────── */
  .action-bar{position:fixed;bottom:24px;right:24px;display:flex;gap:10px;z-index:1000;}
  .action-bar button{padding:11px 18px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.4);font-family:var(--fs);letter-spacing:0.02em;}
  .action-bar button.primary{background:linear-gradient(135deg,var(--p) 0%,var(--c) 100%);color:#fff;box-shadow:0 4px 14px var(--glow);}
  .action-bar button.ghost{background:var(--surf-e);color:var(--muted);border:1px solid var(--bstr);}

  /* ─── Responsive ──────────────────────────────────────────────────── */
  @media(max-width:700px){main{padding:16px 12px 80px 12px;}.grid{grid-template-columns:1fr 1fr;}}
</style>
</head>
<body>

<!-- INTERNAL BADGE — visible reminder this file is dev-only -->
<div class="internal-strip">
  [INTERNAL DEV TEMPLATE — Design Tier 1] — NOT SHIPPED TO END USERS &nbsp;·&nbsp; internal/templates/review/wave-dashboard-template.html
</div>

<!-- ───────────────────────────────────────────────────────────────────
     HEADER — replace {{WAVE_N}} and {{wave_subtitle}}
     Example subtitle: "Wave-3 Phase A LANDED · awaits dogfood-3"
     ─────────────────────────────────────────────────────────────────── -->
<header class="banner">
  <div class="brand">
    <div class="logo">MUTAGENT</div>
    <div class="product">— DIAGNOSTICS &middot; Wave-{{WAVE_N}}</div>
  </div>
  <div class="meta">{{wave_subtitle}} &nbsp;·&nbsp; internal/templates/review/wave-dashboard-template.html</div>
</header>

<!-- ───────────────────────────────────────────────────────────────────
     TOP-LEVEL TAB NAV
     4 tabs: Kanban · Skill Overview · Audit Matrix · Document Map
     ─────────────────────────────────────────────────────────────────── -->
<nav class="tabs" id="tabnav">
  <button data-tab="t1" class="active">&#9312; Kanban</button>
  <button data-tab="t2">&#9313; Skill Overview</button>
  <button data-tab="t3">&#9314; Audit Matrix</button>
  <button data-tab="t4">&#9315; Document Map</button>
</nav>

<main>

  <!-- ─── METRIC CARDS — always visible above content ─────────────────── -->
  <!-- Fill these with wave-level top-line numbers. Examples below. -->
  <div class="grid">
    <div class="card">
      <div class="l">Wave</div>
      <div class="v">W{{WAVE_N}}</div>
      <div class="d"><!-- e.g. "4 phases · 2 PRs" --></div>
    </div>
    <div class="card">
      <div class="l"><!-- e.g. "Phases Done" --></div>
      <div class="v" style="color:var(--c);"><!-- e.g. "2/5" --></div>
      <div class="d"><!-- e.g. "A + B landed" --></div>
    </div>
    <div class="card">
      <div class="l"><!-- e.g. "Criteria Met" --></div>
      <div class="v" style="color:var(--m);"><!-- e.g. "14/23" --></div>
      <div class="d"><!-- e.g. "success matrix" --></div>
    </div>
    <div class="card">
      <div class="l"><!-- e.g. "Open Items" --></div>
      <div class="v" style="color:var(--y);"><!-- e.g. "3 OQs" --></div>
      <div class="d"><!-- e.g. "unresolved questions" --></div>
    </div>
  </div>


  <!-- ══════════════════════════════════════════════════════════════════
       TAB ① — KANBAN
       Sub-tabs: Overview · Tree Changelog · Phase A-E · Drift · OQs · Lockin/Decisions
       ══════════════════════════════════════════════════════════════════ -->
  <section class="panel active" id="t1">

    <nav class="subtabs" id="subtabs-t1">
      <button data-subtab="t1-overview" class="active">Overview</button>
      <button data-subtab="t1-tree">Tree Changelog</button>
      <button data-subtab="t1-pA">Phase A</button>
      <button data-subtab="t1-pB">Phase B</button>
      <button data-subtab="t1-pC">Phase C</button>
      <button data-subtab="t1-pD">Phase D</button>
      <button data-subtab="t1-pE">Phase E</button>
      <button data-subtab="t1-drift">Drift Audit</button>
      <button data-subtab="t1-oq">Open Questions</button>
      <button data-subtab="t1-lockin">Lockin / Decisions</button>
    </nav>

    <!-- ── t1-overview ── -->
    <div class="subpanel active" id="t1-overview">
      <div class="section">
        <h3>Wave-{{WAVE_N}} — WIP Board</h3>
        <p class="sub">Drag (mentally) cards as work moves between columns. Add <code>.kcard.now</code> to highlight the active card.</p>

        <div class="kanban">
          <div class="col backlog">
            <div class="col-h">&#128230; Backlog <span class="ct">0</span></div>
            <!-- example:
            <div class="kcard"><div class="kt">Feature name</div><div class="km">Phase C · issue #NNN</div></div>
            -->
          </div>
          <div class="col inflight">
            <div class="col-h">&#9881; In-Flight <span class="ct">0</span></div>
            <!-- mark active with .now for the pulsing ring:
            <div class="kcard now"><div class="kt">Active feature</div><div class="km">Phase A · PR #NNN</div></div>
            -->
          </div>
          <div class="col dogfood">
            <div class="col-h">&#128021; Dogfood-Pending <span class="ct">0</span></div>
          </div>
          <div class="col verified">
            <div class="col-h">&#10003; Verified <span class="ct">0</span></div>
          </div>
          <div class="col shipped">
            <div class="col-h">&#128640; Shipped <span class="ct">0</span></div>
          </div>
        </div>

        <div class="rationale"><strong>Status key:</strong> Backlog (not started) &rarr; In-Flight (dev) &rarr; Dogfood-Pending (shipped, awaits real-world trigger) &rarr; Verified (evidence collected) &rarr; Shipped (merged/closed).</div>
      </div>

      <!-- Wave summary section -->
      <div class="section">
        <h3>Wave Summary</h3>
        <!--
          Fill with wave-level context:
            - What this wave delivers (user-visible outcome)
            - Key PRs and their status
            - Dependencies from prior waves
            - Handoff to next wave
        -->
        <p><!-- {{wave_summary}} — replace with 2-4 sentence wave description --></p>
        <table>
          <thead><tr><th>Phase</th><th>PR</th><th>Status</th><th>Landed</th><th>Notes</th></tr></thead>
          <tbody>
            <tr><td>Phase A</td><td><code><!-- PR #NNN --></code></td><td><span class="pill p-white">&#9898; backlog</span></td><td>—</td><td><!-- brief --></td></tr>
            <tr><td>Phase B</td><td><code><!-- PR #NNN --></code></td><td><span class="pill p-white">&#9898; backlog</span></td><td>—</td><td><!-- brief --></td></tr>
            <tr><td>Phase C</td><td><code><!-- PR #NNN --></code></td><td><span class="pill p-white">&#9898; backlog</span></td><td>—</td><td><!-- brief --></td></tr>
            <tr><td>Phase D</td><td><code><!-- PR #NNN --></code></td><td><span class="pill p-white">&#9898; backlog</span></td><td>—</td><td><!-- brief --></td></tr>
            <tr><td>Phase E</td><td><code><!-- PR #NNN --></code></td><td><span class="pill p-white">&#9898; backlog</span></td><td>—</td><td><!-- brief --></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ── t1-tree ── -->
    <div class="subpanel" id="t1-tree">
      <div class="section">
        <h3>Tree Changelog — what moves between iterations</h3>
        <p class="sub">Fill from <code>git diff --stat origin/main...HEAD</code> + per-phase file list. Use <code>&lt;b&gt;</code> for key files, <code>&lt;i&gt;</code> for dirs, <code>&lt;em&gt;</code> for comments.</p>

        <!--
          Example tree block — replace with actual changed file tree:

          <div class="tree"><b>mutagent-system/{{SKILL_NAME}}/.claude/skills/{{SKILL_NAME}}/</b>
          ├─ <i>scripts/</i>
          │  ├─ <b>slicer.ts</b>                  <em>EDIT — added NL→filter adapter</em>
          │  └─ <i>report/</i>
          │     └─ <b>render.ts</b>               <em>EDIT — new renderFindingPanel()</em>
          ├─ <i>assets/templates/</i>
          │  └─ <b>report.html.tpl</b>            <em>EDIT — badge classes PR-024 portability</em>
          └─ <i>references/</i>
             └─ <b>principles.md</b>              <em>EDIT — added PR-024 through PR-026</em></div>
        -->
        <div class="tree"><!-- {{tree_changelog}} — paste git diff --stat tree here --></div>

        <div class="delta"><strong>How to fill:</strong> Run <code>git diff --stat origin/main...HEAD</code> in the worktree. Copy the output here. Use <code>&lt;b&gt;</code> on the most-changed files. Add <code>&lt;em&gt;</code> inline comments explaining WHY each file was touched.</div>
      </div>
    </div>

    <!-- ── t1-pA ── -->
    <div class="subpanel" id="t1-pA">
      <!--
        PHASE A — full feature-card structure.
        Fill in order: phase-head → goal → voice-stamps → scope → files → acceptance → meta-row → lockin.
        Risk modifier on .phase-card root:
          .phase-safe   green left-border (low risk)
          .phase-medium cyan left-border (typical)
          .phase-arch   thick yellow (architectural, extra approval)
      -->
      <div class="phase-card phase-medium">
        <div class="phase-head">
          <div class="phase-id">Phase A</div>
          <div class="phase-title"><!-- concise title --></div>
          <div class="phase-tags">
            <span class="pill p-white">&#9898; backlog</span>
            <span class="pill p-blue"><!-- ~Xh --></span>
            <span class="pill p-white"><!-- ~Y LOC --></span>
          </div>
        </div>

        <div class="phase-sub">
          <h4>&#127919; Goal</h4>
          <p><!-- One paragraph: user-visible outcome. WHY this exists. --></p>
        </div>

        <div class="vstamp"><strong>Voice-stamp T?</strong>: <em>"<!-- verbatim operator quote -->"</em></div>

        <div class="phase-sub">
          <h4>&#128203; Scope of work</h4>
          <ol>
            <li><strong><!-- Task name --></strong>: <!-- concrete action, file paths, CLI --></li>
            <li><strong><!-- Task name --></strong>: <!-- ... --></li>
          </ol>
          <div class="note"><strong>Constraint</strong>: <!-- invariants, don't-touch callouts --></div>
        </div>

        <div class="phase-sub">
          <h4>&#128194; Files touched</h4>
          <table>
            <thead><tr><th width="55%">File</th><th width="15%">Action</th><th width="30%">Notes</th></tr></thead>
            <tbody>
              <tr><td><code><!-- path/to/file --></code></td><td>NEW · EDIT · DELETE</td><td><!-- LOC or sub-edits --></td></tr>
            </tbody>
          </table>
        </div>

        <div class="phase-sub">
          <h4>&#9989; Acceptance criteria</h4>
          <ul>
            <li><!-- runnable command + expected exit/output --></li>
            <li><!-- behavioral observation --></li>
          </ul>
        </div>

        <div class="phase-meta-row">
          <div class="phase-meta-block"><strong>Dependencies</strong><br/><span class="meta-val"><!-- none / P-X / parallel-safe --></span></div>
          <div class="phase-meta-block"><strong>Risks</strong><br/><span class="meta-val"><!-- RISK-XX (severity) or none --></span></div>
          <div class="phase-meta-block"><strong>Voice-stamps</strong><br/><span class="meta-val"><!-- TN endorse --></span></div>
          <div class="phase-meta-block"><strong>PR scope</strong><br/><span class="meta-val"><!-- 1 PR · separate commit --></span></div>
        </div>

        <div class="lockin">
          <div class="lockin-title">Phase A — approve to dispatch</div>
          <div class="lockin-radios">
            <label><input type="radio" name="pA" value="lock"> LOCK + dispatch</label>
            <label><input type="radio" name="pA" value="revise"> REVISE</label>
            <label><input type="radio" name="pA" value="hold"> HOLD</label>
            <label><input type="radio" name="pA" value="drop"> DROP</label>
          </div>
          <textarea placeholder="Concerns, alternative proposals, peer-review asks"></textarea>
        </div>
      </div>
    </div>

    <!-- ── t1-pB ── -->
    <div class="subpanel" id="t1-pB">
      <div class="phase-card phase-medium">
        <div class="phase-head">
          <div class="phase-id">Phase B</div>
          <div class="phase-title"><!-- concise title --></div>
          <div class="phase-tags">
            <span class="pill p-white">&#9898; backlog</span>
            <span class="pill p-blue"><!-- ~Xh --></span>
          </div>
        </div>
        <div class="phase-sub"><h4>&#127919; Goal</h4><p><!-- goal --></p></div>
        <div class="vstamp"><strong>Voice-stamp T?</strong>: <em>"<!-- quote -->"</em></div>
        <div class="phase-sub">
          <h4>&#128203; Scope</h4>
          <ol><li><strong><!-- task --></strong>: <!-- detail --></li></ol>
        </div>
        <div class="phase-sub">
          <h4>&#128194; Files</h4>
          <table><thead><tr><th>File</th><th>Action</th><th>Notes</th></tr></thead><tbody>
            <tr><td><code><!-- path --></code></td><td>EDIT</td><td><!-- notes --></td></tr>
          </tbody></table>
        </div>
        <div class="phase-sub"><h4>&#9989; Acceptance</h4><ul><li><!-- criterion --></li></ul></div>
        <div class="phase-meta-row">
          <div class="phase-meta-block"><strong>Dependencies</strong><br/><span class="meta-val">Phase A</span></div>
          <div class="phase-meta-block"><strong>Risks</strong><br/><span class="meta-val"><!-- none --></span></div>
          <div class="phase-meta-block"><strong>Voice-stamps</strong><br/><span class="meta-val"><!-- TN --></span></div>
          <div class="phase-meta-block"><strong>PR scope</strong><br/><span class="meta-val">1 PR</span></div>
        </div>
        <div class="lockin">
          <div class="lockin-title">Phase B — approve to dispatch</div>
          <div class="lockin-radios">
            <label><input type="radio" name="pB" value="lock"> LOCK + dispatch</label>
            <label><input type="radio" name="pB" value="revise"> REVISE</label>
            <label><input type="radio" name="pB" value="hold"> HOLD</label>
            <label><input type="radio" name="pB" value="drop"> DROP</label>
          </div>
          <textarea placeholder="Notes"></textarea>
        </div>
      </div>
    </div>

    <!-- ── t1-pC ── -->
    <div class="subpanel" id="t1-pC">
      <div class="phase-card phase-medium">
        <div class="phase-head">
          <div class="phase-id">Phase C</div>
          <div class="phase-title"><!-- title --></div>
          <div class="phase-tags"><span class="pill p-white">&#9898; backlog</span></div>
        </div>
        <div class="phase-sub"><h4>&#127919; Goal</h4><p><!-- goal --></p></div>
        <div class="phase-sub">
          <h4>&#128203; Scope</h4>
          <ol><li><strong><!-- task --></strong>: <!-- detail --></li></ol>
        </div>
        <div class="phase-sub"><h4>&#9989; Acceptance</h4><ul><li><!-- criterion --></li></ul></div>
        <div class="lockin">
          <div class="lockin-title">Phase C — approve to dispatch</div>
          <div class="lockin-radios">
            <label><input type="radio" name="pC" value="lock"> LOCK + dispatch</label>
            <label><input type="radio" name="pC" value="revise"> REVISE</label>
            <label><input type="radio" name="pC" value="hold"> HOLD</label>
            <label><input type="radio" name="pC" value="drop"> DROP</label>
          </div>
          <textarea placeholder="Notes"></textarea>
        </div>
      </div>
    </div>

    <!-- ── t1-pD ── -->
    <div class="subpanel" id="t1-pD">
      <div class="phase-card phase-medium">
        <div class="phase-head">
          <div class="phase-id">Phase D</div>
          <div class="phase-title"><!-- title --></div>
          <div class="phase-tags"><span class="pill p-white">&#9898; backlog</span></div>
        </div>
        <div class="phase-sub"><h4>&#127919; Goal</h4><p><!-- goal --></p></div>
        <div class="phase-sub">
          <h4>&#128203; Scope</h4>
          <ol><li><strong><!-- task --></strong>: <!-- detail --></li></ol>
        </div>
        <div class="phase-sub"><h4>&#9989; Acceptance</h4><ul><li><!-- criterion --></li></ul></div>
        <div class="lockin">
          <div class="lockin-title">Phase D — approve to dispatch</div>
          <div class="lockin-radios">
            <label><input type="radio" name="pD" value="lock"> LOCK + dispatch</label>
            <label><input type="radio" name="pD" value="revise"> REVISE</label>
            <label><input type="radio" name="pD" value="hold"> HOLD</label>
            <label><input type="radio" name="pD" value="drop"> DROP</label>
          </div>
          <textarea placeholder="Notes"></textarea>
        </div>
      </div>
    </div>

    <!-- ── t1-pE ── -->
    <div class="subpanel" id="t1-pE">
      <div class="phase-card phase-arch">
        <div class="phase-head">
          <div class="phase-id">Phase E</div>
          <div class="phase-title"><!-- title — typically final merge / squash --></div>
          <div class="phase-tags">
            <span class="pill p-white">&#9898; backlog</span>
            <span class="pill p-yellow">arch</span>
          </div>
        </div>
        <div class="phase-sub"><h4>&#127919; Goal</h4><p><!-- final merge / integration goal --></p></div>
        <div class="phase-sub">
          <h4>&#128203; Scope</h4>
          <ol><li><strong><!-- task --></strong>: <!-- detail --></li></ol>
        </div>
        <div class="phase-sub"><h4>&#9989; Acceptance</h4><ul><li><!-- criterion --></li></ul></div>
        <div class="lockin" style="border-left:4px solid var(--m);background:linear-gradient(135deg,rgba(240,171,252,0.08) 0%,var(--surf-e) 100%);">
          <div class="lockin-title" style="color:var(--m);">Phase E / Final — squash-merge trigger</div>
          <div class="lockin-radios">
            <label><input type="radio" name="pE" value="defer"> DEFER (await dogfood)</label>
            <label><input type="radio" name="pE" value="squash"> SQUASH NOW</label>
            <label><input type="radio" name="pE" value="another-wave"> NEXT WAVE first</label>
          </div>
          <textarea placeholder="Final notes"></textarea>
        </div>
      </div>
    </div>

    <!-- ── t1-drift ── -->
    <div class="subpanel" id="t1-drift">
      <div class="section">
        <h3>Drift Audit — spec vs implementation gaps</h3>
        <p class="sub">List findings where implementation drifted from the design. Each item has an ID, body, and resolution plan.</p>

        <!--
          Fill with drift items found during code review / dogfood.
          Example:
          <div class="drift">
            <div class="drift-id">DRIFT-01 · HIGH</div>
            <div class="drift-body">SKILL.md §4 BoM lists assemble-meta.ts but scripts/ still has the old inline Python heredoc in fetch.sh.</div>
            <div class="drift-fix">Remove heredoc from fetch.sh. Wire assemble-meta.ts invocation per BoM spec.</div>
          </div>
        -->
        <div class="drift">
          <div class="drift-id">DRIFT-01 · <!-- severity --></div>
          <div class="drift-body"><!-- description --></div>
          <div class="drift-fix"><!-- resolution --></div>
        </div>

        <div class="rationale"><strong>How to fill:</strong> After each phase PR lands, do a diff-to-spec pass (compare files-touched vs SKILL.md §4 BoM + §5 agents + §3 architecture). Log every mismatch here. Resolved items get <code>.oq.resolved-oq</code> treatment when fixed.</div>
      </div>
    </div>

    <!-- ── t1-oq ── -->
    <div class="subpanel" id="t1-oq">
      <div class="section">
        <h3>Open Questions</h3>
        <p class="sub">Decisions pending operator input or additional evidence. Resolved items get a green border; leave the OQ for audit trail.</p>

        <!--
          Unresolved OQ:
          <div class="oq">
            <div class="oq-id">OQ-01 · open</div>
            <div class="oq-body">Should PR-024 (portability principle) apply retroactively to existing scripts or only new code?</div>
          </div>

          Resolved OQ:
          <div class="oq resolved-oq">
            <div class="oq-id">OQ-01 · RESOLVED</div>
            <div class="oq-body">Applies to new code only. Existing scripts addressed in next refactor wave.</div>
          </div>
        -->
        <div class="oq">
          <div class="oq-id">OQ-01 · open</div>
          <div class="oq-body"><!-- question body --></div>
        </div>

        <div class="delta"><strong>How to fill:</strong> Add an OQ whenever a decision fork comes up during implementation. Reference by ID in phase cards. Once resolved, flip class to <code>resolved-oq</code> and fill in resolution body.</div>
      </div>
    </div>

    <!-- ── t1-lockin ── -->
    <div class="subpanel" id="t1-lockin">
      <div class="section">
        <h3>Lockin / Wave Decisions</h3>
        <p class="sub">Summary of all wave-level decisions locked in so far. Use the "Copy Decisions" button to export as markdown for the orchestrator.</p>

        <table>
          <thead><tr><th width="15%">ID</th><th width="30%">Decision</th><th width="20%">Choice</th><th width="35%">Rationale</th></tr></thead>
          <tbody>
            <tr><td><code>DEC-01</code></td><td><!-- what was decided --></td><td><span class="pill p-green"><!-- locked --></span></td><td><!-- why --></td></tr>
            <tr><td><code>DEC-02</code></td><td><!-- decision --></td><td><span class="pill p-yellow"><!-- pending --></span></td><td><!-- rationale --></td></tr>
          </tbody>
        </table>

        <!-- Wave final lock-in -->
        <div class="lockin" style="margin-top:32px;">
          <div class="lockin-title">Wave {{WAVE_N}} — final wave-level decision</div>
          <div class="lockin-radios">
            <label><input type="radio" name="wave-final" value="proceed"> PROCEED to next wave</label>
            <label><input type="radio" name="wave-final" value="rework"> REWORK (see OQs)</label>
            <label><input type="radio" name="wave-final" value="hold"> HOLD (awaiting dogfood)</label>
          </div>
          <textarea placeholder="Wave-level notes for orchestrator"></textarea>
        </div>
      </div>
    </div>

  </section><!-- end t1 -->


  <!-- ══════════════════════════════════════════════════════════════════
       TAB ② — SKILL OVERVIEW
       Sub-tabs: §0 Setup · §1 Triggers · §3 Architecture · §4 BoM · §5 Agents
                 §6 References · §7 Config · §8 Design Principles · §9 Failure Taxonomy
       ══════════════════════════════════════════════════════════════════ -->
  <section class="panel" id="t2">

    <nav class="subtabs" id="subtabs-t2">
      <button data-subtab="t2-s0" class="active">§0 Setup</button>
      <button data-subtab="t2-s1">§1 Triggers</button>
      <button data-subtab="t2-s3">§3 Architecture</button>
      <button data-subtab="t2-s4">§4 Bill of Materials</button>
      <button data-subtab="t2-s5">§5 Agents</button>
      <button data-subtab="t2-s6">§6 References</button>
      <button data-subtab="t2-s7">§7 Config</button>
      <button data-subtab="t2-s8">§8 Design Principles &#11088;</button>
      <button data-subtab="t2-s9">§9 Failure Taxonomy</button>
    </nav>

    <!-- ── §0 Setup ── -->
    <div class="subpanel active" id="t2-s0">
      <div class="section">
        <h2>&#9312; Setup Detection (§0)</h2>
        <p class="sub">
          <!--
            Fill: 1-2 sentences describing what §0 does.
            Source: SKILL.md §0 + references/workflows/onboarding.md
            Content to include:
              - Branch decision flowchart (div.mermaid with config present vs missing paths)
              - Onboarding outputs table
              - Key design decision rationale
          -->
          <!-- {{section_0_subtitle}} — e.g. "Detects whether {{SKILL_NAME}} is configured; auto-generates config if missing." -->
        </p>

        <!-- {{section_0_content}} — replace this comment with actual §0 content -->

        <!-- Example flowchart placeholder:
        <div class="mermaid">
          flowchart TD
            START([Skill invoked]) - ->|check| CONFIG{.mutagentrc exists?}
            CONFIG - ->|yes| LOAD[Load config]
            CONFIG - ->|no| ONBOARD[Run onboarding workflow]
            LOAD - -> RUN[Run diagnostics]
            ONBOARD - -> RUN
        </div>
        -->

        <div class="rationale"><strong>Fill from:</strong> SKILL.md §0 + <code>references/workflows/onboarding.md</code>. Replace this rationale block with actual design decision context.</div>
      </div>
    </div>

    <!-- ── §1 Triggers ── -->
    <div class="subpanel" id="t2-s1">
      <div class="section">
        <h2>&#9313; Triggers (§1)</h2>
        <p class="sub"><!-- {{section_1_subtitle}} — source: SKILL.md §1 --></p>
        <!--
          Content:
            - Natural-language trigger phrases table (phrase → maps-to)
            - Bootstrap / install command (pre block)
            - Rationale for multiple phrasings (.rationale)
        -->
        <table>
          <thead><tr><th width="40%">Trigger phrase</th><th width="30%">Maps to</th><th width="30%">Notes</th></tr></thead>
          <tbody>
            <tr><td><!-- "run diagnostics" --></td><td><!-- skill invocation --></td><td><!-- --></td></tr>
            <tr><td><!-- "diagnose skill" --></td><td><!-- skill invocation --></td><td><!-- --></td></tr>
          </tbody>
        </table>
        <div class="rationale"><strong>Fill from:</strong> SKILL.md §1. Add every trigger phrase with its canonical invocation form.</div>
      </div>
    </div>

    <!-- ── §3 Architecture ── -->
    <div class="subpanel" id="t2-s3">
      <div class="section">
        <h2>&#9314; Architecture Overview (§3)</h2>
        <p class="sub"><!-- {{section_3_subtitle}} — source: SKILL.md §3 + references/reference.md --></p>
        <!--
          Content:
            - Top-level flowchart (div.mermaid)
            - Where-each-stage-runs table (Stage | Runs in | Owner)
            - Token cost / design notes (.delta)
        -->

        <!-- Example architecture flowchart placeholder:
        <div class="mermaid">
          flowchart LR
            CLI[CLI invocation] - -> SETUP[§0 Setup]
            SETUP - -> SLICER[slicer.ts]
            SLICER - -> TIER0[tier0-scan.ts]
            TIER0 - -> ANALYZER[diagnostics-analyzer agent]
            ANALYZER - -> RENDER[render.ts]
            RENDER - -> REPORT[report.html]
        </div>
        -->

        <table>
          <thead><tr><th width="25%">Stage</th><th width="30%">Runs in</th><th width="25%">Owner</th><th width="20%">Notes</th></tr></thead>
          <tbody>
            <tr><td><!-- Stage --></td><td><!-- context --></td><td><!-- owner --></td><td><!-- notes --></td></tr>
          </tbody>
        </table>
        <div class="rationale"><strong>Fill from:</strong> SKILL.md §3 + <code>references/reference.md</code>.</div>
      </div>
    </div>

    <!-- ── §4 Bill of Materials ── -->
    <div class="subpanel" id="t2-s4">
      <div class="section">
        <h2>&#9315; Bill of Materials — scripts/ (§4)</h2>
        <p class="sub"><!-- {{section_4_subtitle}} — source: SKILL.md §4 + scripts/ directory --></p>
        <!--
          Content:
            - Scripts inventory table (Script | Purpose | Invoked by)
            - Dispatch contract (pre block: how scripts are invoked by run.sh)
            - .rationale on design choice for the dispatch pattern
        -->
        <table>
          <thead><tr><th width="35%">Script</th><th width="40%">Purpose</th><th width="25%">Invoked by</th></tr></thead>
          <tbody>
            <tr><td><code>scripts/cli/run.sh</code></td><td><!-- entry point --></td><td><!-- skill caller --></td></tr>
            <tr><td><code>scripts/slicer.ts</code></td><td><!-- purpose --></td><td><code>run.sh</code></td></tr>
            <tr><td><code>scripts/tier0/tier0-scan.ts</code></td><td><!-- purpose --></td><td><code>run.sh</code></td></tr>
            <tr><td><code>scripts/report/render.ts</code></td><td><!-- purpose --></td><td><code>run.sh</code></td></tr>
          </tbody>
        </table>
        <div class="rationale"><strong>Fill from:</strong> SKILL.md §4. List every entry-point script + sub-scripts. Include the <code>run.sh</code> dispatch contract as a <code>&lt;pre&gt;</code> block.</div>
      </div>
    </div>

    <!-- ── §5 Agents ── -->
    <div class="subpanel" id="t2-s5">
      <div class="section">
        <h2>&#9316; Agents — assets/agents/ (§5)</h2>
        <p class="sub"><!-- {{section_5_subtitle}} — source: SKILL.md §5 + assets/agents/ --></p>
        <!--
          Content:
            - Agent roster table (Agent | Class | Dispatched by | Purpose)
            - Capability constraints (.rationale)
            - Retired agents and why (.delta or .resolved)
        -->
        <table>
          <thead><tr><th width="30%">Agent</th><th width="15%">Class</th><th width="20%">Dispatched by</th><th width="35%">Purpose</th></tr></thead>
          <tbody>
            <tr><td><code>diagnostics-analyzer.md</code></td><td><!-- actor --></td><td><code>run.sh</code></td><td><!-- purpose --></td></tr>
            <tr><td><code>diagnostics-apply-worker.md</code></td><td><!-- actor --></td><td><code>run.sh</code></td><td><!-- purpose --></td></tr>
          </tbody>
        </table>
        <div class="rationale"><strong>Fill from:</strong> SKILL.md §5 + <code>assets/agents/</code> directory. Document capability constraints (what agents can/cannot do) and rationale.</div>
      </div>
    </div>

    <!-- ── §6 References ── -->
    <div class="subpanel" id="t2-s6">
      <div class="section">
        <h2>&#9317; References — references/ (§6)</h2>
        <p class="sub"><!-- {{section_6_subtitle}} — source: SKILL.md §6 + references/ directory --></p>
        <!--
          Content:
            - .tree block showing the references/ directory structure
            - Progressive disclosure rationale (.rationale)
            - Note about internal/ being stripped on publish
        -->
        <div class="tree"><!-- {{references_tree}} — paste tree output of references/ directory here
references/
├─ <b>reference.md</b>               <em>master index + architecture overview</em>
├─ <b>principles.md</b>              <em>design principles PR-001..PR-0NN (source of truth)</em>
├─ <b>config.md</b>                  <em>configuration reference</em>
├─ <i>workflows/</i>
│  ├─ <b>onboarding.md</b>
│  ├─ <b>diagnostics.md</b>
│  ├─ <b>orchestrator-protocol.md</b>
│  ├─ <b>apply-dispatch.md</b>
│  ├─ <b>apply-pr-comment-format.md</b>
│  └─ <b>rca.md</b>
└─ <i>internal/</i>                  <em>NOT SHIPPED — stripped on publish</em></div>

        <div class="rationale"><strong>Progressive disclosure:</strong> Agents load only what they need. SKILL.md §6 lists which references are loaded at which stage. Do not flatten into a single doc.</div>
      </div>
    </div>

    <!-- ── §7 Config ── -->
    <div class="subpanel" id="t2-s7">
      <div class="section">
        <h2>&#9318; Config (§7)</h2>
        <p class="sub"><!-- {{section_7_subtitle}} — source: SKILL.md §7 + references/config.md + scripts/config/schema.ts --></p>
        <!--
          Content:
            - Key config fields table (Field | Type | Default | Purpose)
            - Example .mutagentrc snippet (pre block)
            - Schema source-of-truth callout (.rationale)
        -->
        <table>
          <thead><tr><th width="25%">Field</th><th width="15%">Type</th><th width="20%">Default</th><th width="40%">Purpose</th></tr></thead>
          <tbody>
            <tr><td><code><!-- field --></code></td><td><!-- type --></td><td><code><!-- default --></code></td><td><!-- purpose --></td></tr>
          </tbody>
        </table>
        <div class="rationale"><strong>Source of truth:</strong> <code>scripts/config/schema.ts</code>. The config reference doc (<code>references/config.md</code>) must match the schema. The template (<code>assets/templates/config.yaml.tpl</code>) must match both.</div>
      </div>
    </div>

    <!-- ── §8 Design Principles ── -->
    <div class="subpanel" id="t2-s8">
      <div class="section">
        <h2>&#9319; Design Principles (§8) &#11088;</h2>
        <p class="sub">PR-001 through PR-023 are current (source of truth: <code>references/principles.md</code>). PR-024+ are proposed additions from iter-12 review — pending formal write-up + adoption.</p>

        <div class="delta"><strong>Proposed for iter-12:</strong> PR-024 (portability) · PR-025 (renderer-smoke-test) · PR-026 (cross-platform install). See the <code>principle.proposed</code> cards below. These are NOT yet in <code>references/principles.md</code>.</div>

        <!-- PR-001 through PR-023 — current, locked -->
        <!--
          Fill each .principle card from references/principles.md.
          Structure:
            .pid   PR-NNN
            .pt    Title
            .pb    Body / enforcement guidance (1-3 sentences)
        -->

        <h4>Current Principles — PR-001 through PR-023</h4>

        <div class="principle">
          <div class="pid">PR-001</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body — fill from references/principles.md --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-002</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-003</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-004</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-005</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-006</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-007</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-008</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-009</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-010</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-011</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-012</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-013</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-014</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-015</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-016</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-017</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-018</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-019</div>
          <div class="pt">No inline Python heredocs</div>
          <div class="pb">Shell scripts MUST NOT embed Python via heredoc. Extract to <code>scripts/*.ts</code> and invoke via <code>bun run</code>. Violations caught by PR-019 lint gate.</div>
        </div>

        <div class="principle">
          <div class="pid">PR-020</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-021</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-022</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <div class="principle">
          <div class="pid">PR-023</div>
          <div class="pt"><!-- title --></div>
          <div class="pb"><!-- body --></div>
        </div>

        <!-- Proposed PR-024+ — proposed from iter-12, NOT yet in principles.md -->
        <h4 style="margin-top:32px;color:var(--c);">Proposed Principles — PR-024+ (iter-12 proposal, not yet adopted)</h4>
        <div class="resolved"><strong>Note:</strong> These are hypotheses surfaced during Wave-{{WAVE_N}} review. They need a formal write-up + operator approval before being written to <code>references/principles.md</code>. Audit Matrix tab §8 cross-links here.</div>

        <div class="principle proposed">
          <div class="pid">PR-024 · proposed</div>
          <div class="pt">Portability — no hard-coded absolute paths in scripts</div>
          <div class="pb">Scripts MUST NOT hard-code absolute paths. All paths are derived from runtime variables (<code>$SKILL_ROOT</code>, <code>$CWD</code>, etc.) or config entries. Enables moving skill between machines and clones without edits.</div>
        </div>

        <div class="principle proposed">
          <div class="pid">PR-025 · proposed</div>
          <div class="pt">Renderer smoke-test — <code>report.html.tpl</code> must have a companion smoke test</div>
          <div class="pb">Any change to <code>assets/templates/report.html.tpl</code> requires a companion smoke test that renders the template with minimal fixture data and asserts no JS errors + expected heading text. Prevents silent template regressions.</div>
        </div>

        <div class="principle proposed">
          <div class="pid">PR-026 · proposed</div>
          <div class="pt">Cross-platform install — macOS + Linux parity</div>
          <div class="pb">All setup scripts MUST test on both macOS (bash 3.2) and Linux (bash 5.x). Bash 3.2 compatibility gates: no <code>declare -A</code>, no <code>[[</code> regex with ERE, no <code>EPOCHSECONDS</code>. CI matrix MUST include both targets.</div>
        </div>

        <div class="rationale"><strong>How to promote a proposed principle:</strong> (1) draft formal write-up with concrete enforcement rule + CI gate, (2) operator approves via lockin widget, (3) write to <code>references/principles.md</code>, (4) flip card class from <code>.proposed</code> to current.</div>
      </div>
    </div>

    <!-- ── §9 Failure Taxonomy ── -->
    <div class="subpanel" id="t2-s9">
      <div class="section">
        <h2>&#9320; Failure Taxonomy (§9)</h2>
        <p class="sub"><!-- {{section_9_subtitle}} — source: SKILL.md §9 + references/workflows/rca.md --></p>
        <!--
          Content:
            - 3-axis taxonomy description
            - Tax-card grid (one card per axis: Surface · Layer · Severity)
            - Cross-link to rca.md
        -->
        <div class="three-col">
          <div class="tax-card">
            <h4>Axis 1 — Surface</h4>
            <ul>
              <li><!-- surface-1 --></li>
              <li><!-- surface-2 --></li>
              <li><!-- surface-3 --></li>
            </ul>
          </div>
          <div class="tax-card">
            <h4>Axis 2 — Layer</h4>
            <ul>
              <li><!-- layer-1 --></li>
              <li><!-- layer-2 --></li>
              <li><!-- layer-3 --></li>
            </ul>
          </div>
          <div class="tax-card">
            <h4>Axis 3 — Severity</h4>
            <ul>
              <li><!-- severity-1 --></li>
              <li><!-- severity-2 --></li>
              <li><!-- severity-3 --></li>
            </ul>
          </div>
        </div>
        <div class="rationale"><strong>Fill from:</strong> SKILL.md §9 + <code>references/workflows/rca.md</code>. The 3-axis taxonomy is the source of truth for failure categorization. All report.html.tpl badges derive from this taxonomy.</div>
      </div>
    </div>

  </section><!-- end t2 -->


  <!-- ══════════════════════════════════════════════════════════════════
       TAB ③ — AUDIT MATRIX
       Sub-tabs: Success Criteria Matrix · Skill Context Map · Audit Timeline · Design Principles Audit
       ══════════════════════════════════════════════════════════════════ -->
  <section class="panel" id="t3">

    <nav class="subtabs" id="subtabs-t3">
      <button data-subtab="t3-matrix" class="active">Success Criteria Matrix</button>
      <button data-subtab="t3-context">Skill Context Map</button>
      <button data-subtab="t3-timeline">Audit Timeline</button>
      <button data-subtab="t3-principles">Design Principles Audit</button>
    </nav>

    <!-- ── Success Criteria Matrix ── -->
    <div class="subpanel active" id="t3-matrix">
      <div class="section">
        <h3>&#128202; Success Criteria Matrix</h3>
        <p class="sub">Fill the <strong>Evidence</strong> column as transcripts arrive. Update the pill class to flip status. Group rows by functional area.</p>

        <div class="resolved"><strong>Pill flow:</strong> &#9898; <code>p-white</code> awaits-evidence &rarr; &#127761; <code>p-yellow</code> awaits-dogfood &rarr; &#128309; <code>p-blue</code> unit-tested &rarr; &#128994; <code>p-green</code> verified &rarr; &#128308; <code>p-red</code> failed</div>

        <h4>&#128682; Area — Core Functionality</h4>
        <table class="matrix">
          <thead><tr>
            <th width="22%">Feature</th>
            <th width="20%">Verification method</th>
            <th width="11%">Status</th>
            <th width="30%">Evidence</th>
            <th width="17%">Where</th>
          </tr></thead>
          <tbody>
            <tr>
              <td><strong><!-- Feature name --></strong></td>
              <td><!-- how verified --></td>
              <td><span class="pill p-white">&#9898; evidence</span></td>
              <td><em>awaits transcript</em></td>
              <td><code><!-- path --></code></td>
            </tr>
            <tr>
              <td><strong><!-- Feature name --></strong></td>
              <td><!-- how verified --></td>
              <td><span class="pill p-yellow">&#127761; dogfood</span></td>
              <td><em>awaits dogfood run</em></td>
              <td><code><!-- path --></code></td>
            </tr>
          </tbody>
        </table>

        <h4>&#128269; Area — Agents</h4>
        <table class="matrix">
          <thead><tr>
            <th width="22%">Feature</th>
            <th width="20%">Verification</th>
            <th width="11%">Status</th>
            <th width="30%">Evidence</th>
            <th width="17%">Where</th>
          </tr></thead>
          <tbody>
            <tr>
              <td><strong><!-- Feature --></strong></td>
              <td><!-- method --></td>
              <td><span class="pill p-white">&#9898; evidence</span></td>
              <td><em>requires real-world trigger</em></td>
              <td><code><!-- path --></code></td>
            </tr>
          </tbody>
        </table>

        <h4>&#127981; Area — Configuration</h4>
        <table class="matrix">
          <thead><tr>
            <th width="22%">Feature</th>
            <th width="20%">Verification</th>
            <th width="11%">Status</th>
            <th width="30%">Evidence</th>
            <th width="17%">Where</th>
          </tr></thead>
          <tbody>
            <tr>
              <td><strong><!-- Feature --></strong></td>
              <td><!-- method --></td>
              <td><span class="pill p-white">&#9898; evidence</span></td>
              <td><em>awaits config test</em></td>
              <td><code><!-- path --></code></td>
            </tr>
          </tbody>
        </table>

        <div class="rationale"><strong>How to update:</strong> when evidence arrives, (a) replace <code>&lt;em&gt;awaits...&lt;/em&gt;</code> with actual evidence (transcript in <code>&lt;details&gt;</code>, PR link, screenshot ref), (b) swap pill class. Add a new <code>&lt;h4&gt;</code> + <code>&lt;table&gt;</code> per functional area.</div>
      </div>
    </div>

    <!-- ── Skill Context Map ── -->
    <div class="subpanel" id="t3-context">
      <div class="section">
        <h3>&#127760; Skill Context Map</h3>
        <p class="sub">Mermaid diagram showing how agents, scripts, templates, and references connect at runtime.</p>

        <!--
          Fill with a Mermaid flowchart or sequenceDiagram showing the skill's
          runtime information flow. Example (replace with actual skill graph):
        -->
        <div class="mermaid">
%%{init: {'theme':'dark'}}%%
flowchart LR
  CLI([CLI invocation]) --> SETUP[Setup §0\ndetect.ts]
  SETUP -->|config ok| SLICER[slicer.ts\nslice findings]
  SLICER --> TIER0[tier0-scan.ts\nquick surface scan]
  TIER0 --> DISPATCH[run.sh\ndispatch analyzer]
  DISPATCH --> ANALYZER[diagnostics-analyzer\nsub-agent]
  ANALYZER --> RENDER[render.ts\nbuild report]
  RENDER --> REPORT[report.html\ndelivered to user]

  DISPATCH --> APPLYWORKER[apply-worker\nsub-agent]
  APPLYWORKER -->|PRs| GH[GitHub PRs]

  classDef script fill:#1c1c2a,stroke:#06b6d4,color:#f5f5f9;
  classDef agent fill:#1c1c2a,stroke:#a78bfa,color:#f5f5f9;
  classDef output fill:#1c1c2a,stroke:#10b981,color:#f5f5f9;
  class SLICER,TIER0,RENDER script;
  class ANALYZER,APPLYWORKER agent;
  class REPORT,GH output;
        </div>

        <div class="rationale"><strong>How to fill:</strong> Replace the placeholder flowchart above with the actual runtime context map for Wave-{{WAVE_N}}. Colour classes: <code>script</code> (cyan), <code>agent</code> (purple), <code>output</code> (green).</div>
      </div>
    </div>

    <!-- ── Audit Timeline ── -->
    <div class="subpanel" id="t3-timeline">
      <div class="section">
        <h3>&#9203; Audit Timeline</h3>
        <p class="sub">Ordered record of significant design decisions, PR landings, and dogfood events for Wave-{{WAVE_N}}.</p>

        <!--
          Fill events in reverse-chronological order (newest at top).
          Classes: .ev.done (green dot) · .ev.current (yellow pulsing dot) · .ev (purple dot)
        -->
        <div class="timeline">
          <div class="ev current">
            <div class="date"><!-- YYYY-MM-DD --></div>
            <div class="title"><!-- current event --></div>
            <div class="desc"><!-- details --></div>
          </div>
          <div class="ev done">
            <div class="date"><!-- YYYY-MM-DD --></div>
            <div class="title"><!-- completed event --></div>
            <div class="desc"><!-- details --></div>
          </div>
          <div class="ev done">
            <div class="date"><!-- YYYY-MM-DD --></div>
            <div class="title">Wave-{{WAVE_N}} kickoff</div>
            <div class="desc"><!-- wave start context --></div>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Design Principles Audit ── -->
    <div class="subpanel" id="t3-principles">
      <div class="section">
        <h3>&#128202; Design Principles Audit</h3>
        <p class="sub">Cross-reference each principle against Wave-{{WAVE_N}} changes. Mark pass / skip / fail per principle. Links to §8 in the Skill Overview tab for full principle text.</p>

        <table class="matrix">
          <thead><tr>
            <th width="10%">Principle</th>
            <th width="25%">Title</th>
            <th width="12%">Status</th>
            <th width="30%">Evidence / Notes</th>
            <th width="23%">Wave touch</th>
          </tr></thead>
          <tbody>
            <tr>
              <td><code>PR-001</code></td>
              <td><!-- title from §8 --></td>
              <td><span class="pill p-white">&#9898; not-checked</span></td>
              <td><em>wave changes don't touch this surface</em></td>
              <td><!-- file(s) if any --></td>
            </tr>
            <tr>
              <td><code>PR-019</code></td>
              <td>No inline Python heredocs</td>
              <td><span class="pill p-green">&#128994; pass</span></td>
              <td>fetch.sh: no python3 heredocs found (grep clean)</td>
              <td><code>scripts/cli/run.sh</code></td>
            </tr>
            <tr>
              <td><code>PR-024</code> <span class="badge b-new">proposed</span></td>
              <td>Portability — no hard-coded paths</td>
              <td><span class="pill p-yellow">&#127761; pending</span></td>
              <td><em>audit not yet run for this wave</em></td>
              <td><code>scripts/**</code></td>
            </tr>
            <tr>
              <td><code>PR-025</code> <span class="badge b-new">proposed</span></td>
              <td>Renderer smoke-test</td>
              <td><span class="pill p-yellow">&#127761; pending</span></td>
              <td><em>smoke test not yet written</em></td>
              <td><code>assets/templates/report.html.tpl</code></td>
            </tr>
            <tr>
              <td><code>PR-026</code> <span class="badge b-new">proposed</span></td>
              <td>Cross-platform install</td>
              <td><span class="pill p-yellow">&#127761; pending</span></td>
              <td><em>Linux CI matrix not yet added</em></td>
              <td><code>scripts/setup/*</code></td>
            </tr>
          </tbody>
        </table>

        <div class="delta"><strong>Proposed principles (PR-024/025/026):</strong> These are hypothesis-stage. The audit row tracks whether this wave's changes are compatible with the proposed enforcement rule. A "pass" here strengthens the case for formal adoption; a "fail" needs a design discussion first.</div>
      </div>
    </div>

  </section><!-- end t3 -->


  <!-- ══════════════════════════════════════════════════════════════════
       TAB ④ — DOCUMENT MAP (NEW)
       Informational dependency graph + change-propagation table
       ══════════════════════════════════════════════════════════════════ -->
  <section class="panel" id="t4">

    <div class="section">
      <h3>&#128209; Document Map — informational dependencies (upstream / downstream)</h3>
      <p class="sub">When a doc changes, what else needs to follow? This Mermaid graph surfaces the dependency graph so we don't miss any propagation. Update the graph when the skill's reference tree changes.</p>

      <div class="mermaid">
%%{init: {'theme':'dark'}}%%
flowchart LR
  SKILL[SKILL.md] -->|"§0 ref"| DETECT[scripts/setup/detect.ts]
  SKILL -->|"§4 BoM"| RUNSH[scripts/cli/run.sh]
  SKILL -->|"§4 BoM"| ALL_SCRIPTS[scripts/*.ts]
  SKILL -->|"§5 agents"| ANALYZER[assets/agents/diagnostics-analyzer.md]
  SKILL -->|"§5 agents"| APPLYWORKER[assets/agents/diagnostics-apply-worker.md]
  SKILL -->|"§6 refs"| REF[references/reference.md]
  SKILL -->|"§6 refs"| PRINC[references/principles.md]
  SKILL -->|"§6 refs"| WF_ONBOARD[references/workflows/onboarding.md]
  SKILL -->|"§6 refs"| WF_DIAG[references/workflows/diagnostics.md]
  SKILL -->|"§6 refs"| WF_ORCH[references/workflows/orchestrator-protocol.md]
  SKILL -->|"§6 refs"| WF_APPLY[references/workflows/apply-dispatch.md]
  SKILL -->|"§6 refs"| WF_RCA[references/workflows/rca.md]
  SKILL -->|"§7 config"| CONFIG[references/config.md]
  WF_ORCH -->|"loaded by"| SETUP[scripts/setup/*]
  WF_DIAG -->|"drives"| SLICER[scripts/slicer.ts]
  WF_DIAG -->|"drives"| TIER0[scripts/tier0-scan.ts]
  WF_RCA -->|"drives"| RENDER[scripts/report/render.ts]
  RENDER -->|"uses"| TPL[assets/templates/report.html.tpl]
  WF_APPLY -->|"drives"| APPLYWORKER
  WF_APPLY -->|"format"| APPLY_FMT[references/workflows/apply-pr-comment-format.md]
  APPLY_FMT -->|"template"| PRBODY[assets/templates/pr-body.md.tpl]
  CONFIG -->|"schema"| SCHEMA[scripts/config/schema.ts]
  CONFIG -->|"template"| CFGTPL[assets/templates/config.yaml.tpl]
  PRINC -.->|"enforces"| ALL_SCRIPTS
  PRINC -.->|"enforces"| TPL

  classDef doc fill:#1c1c2a,stroke:#a78bfa,color:#f5f5f9;
  classDef code fill:#1c1c2a,stroke:#06b6d4,color:#f5f5f9;
  classDef tpl fill:#1c1c2a,stroke:#10b981,color:#f5f5f9;
  class SKILL,REF,PRINC,WF_ONBOARD,WF_DIAG,WF_ORCH,WF_APPLY,WF_RCA,CONFIG,APPLY_FMT doc;
  class DETECT,RUNSH,ALL_SCRIPTS,SETUP,SLICER,TIER0,RENDER,SCHEMA code;
  class TPL,PRBODY,CFGTPL tpl;
  class ANALYZER,APPLYWORKER doc;
      </div>

      <div class="rationale"><strong>Legend:</strong> Purple nodes = documentation files (.md). Cyan nodes = code / scripts (.ts · .sh). Green nodes = runtime templates (.tpl). Dashed arrows = enforcement relationships (principles constrain code quality, not data flow). Solid arrows = data / configuration flow.</div>
    </div>

    <div class="section">
      <h4>Change-propagation table — when X changes, also update Y</h4>
      <p class="sub">Before merging a PR that touches any file in the left column, verify ALL downstream items are also updated.</p>

      <table class="matrix">
        <thead><tr>
          <th width="30%">If you change…</th>
          <th width="35%">…also update (downstream)</th>
          <th width="35%">Why</th>
        </tr></thead>
        <tbody>
          <tr>
            <td><code>SKILL.md §4 BoM</code></td>
            <td><code>scripts/cli/run.sh</code> comment block + <code>references/reference.md</code> tree</td>
            <td>Script invocation convention must match the BoM spec. Reference tree must list all scripts.</td>
          </tr>
          <tr>
            <td><code>references/workflows/diagnostics.md</code></td>
            <td><code>scripts/slicer.ts</code> + <code>scripts/tier0-scan.ts</code> inline comments</td>
            <td>Workflow document drives script behaviour. Script comments cite the workflow step.</td>
          </tr>
          <tr>
            <td><code>references/workflows/rca.md</code> taxonomy</td>
            <td><code>SKILL.md §9</code> + <code>scripts/report/render.ts</code> + <code>assets/templates/report.html.tpl</code> badge classes</td>
            <td>3-axis taxonomy is the source of truth. Report badges + render logic derive from it.</td>
          </tr>
          <tr>
            <td><code>references/principles.md</code> (any PR-N)</td>
            <td>Wave audit matrix (Audit tab §8) + cross-cutting scripts in scope of that principle</td>
            <td>Principles enforce skill quality. Each wave's audit verifies compliance.</td>
          </tr>
          <tr>
            <td><code>assets/templates/report.html.tpl</code></td>
            <td><code>scripts/report/render.ts</code> renderFindingPanel() call-sites</td>
            <td>Renderer-template contract: render.ts constructs the data the template expects. They must stay in sync.</td>
          </tr>
          <tr>
            <td><code>scripts/config/schema.ts</code></td>
            <td><code>references/config.md</code> field table + <code>assets/templates/config.yaml.tpl</code></td>
            <td>Schema is the source of truth for config shape. Docs and template must reflect it.</td>
          </tr>
          <tr>
            <td><code>assets/agents/*.md</code> (agent spec)</td>
            <td><code>SKILL.md §5</code> agent roster + <code>references/workflows/orchestrator-protocol.md</code> Steps 6 &amp; 11</td>
            <td>Agent registry in §5 must match actual agent files. Orchestrator protocol lists agent names explicitly.</td>
          </tr>
          <tr>
            <td><code>references/workflows/apply-dispatch.md</code></td>
            <td><code>assets/agents/diagnostics-apply-worker.md</code> + <code>references/workflows/apply-pr-comment-format.md</code></td>
            <td>Apply workflow drives the apply-worker agent and the PR comment format used in apply PRs.</td>
          </tr>
          <tr>
            <td><code>references/workflows/onboarding.md</code></td>
            <td><code>scripts/setup/detect.ts</code> + <code>SKILL.md §0</code></td>
            <td>Onboarding workflow is the spec for the setup detection script.</td>
          </tr>
        </tbody>
      </table>

      <div class="delta"><strong>How to maintain:</strong> When a PR adds a new cross-file dependency (e.g. a new script that reads from a config key, or a new template field the renderer writes), add a row here BEFORE merging. This table is the propagation contract.</div>
    </div>

    <!-- Downstream / upstream summary -->
    <div class="section">
      <h3>Upstream inputs to this wave</h3>
      <p class="sub">Dependencies this wave relies on that must be stable (from prior waves, other PRs).</p>
      <table>
        <thead><tr><th width="30%">Artifact</th><th width="25%">Source</th><th width="20%">Stability</th><th width="25%">Notes</th></tr></thead>
        <tbody>
          <tr>
            <td><code><!-- artifact --></code></td>
            <td><!-- wave / PR / branch --></td>
            <td><span class="pill p-green">&#128994; stable</span></td>
            <td><!-- notes --></td>
          </tr>
          <tr>
            <td><code><!-- artifact --></code></td>
            <td><!-- wave / PR / branch --></td>
            <td><span class="pill p-yellow">&#127761; in-flight</span></td>
            <td><!-- notes --></td>
          </tr>
        </tbody>
      </table>

      <h3 style="margin-top:24px;">Downstream consumers of this wave</h3>
      <p class="sub">What breaks or needs updating if this wave's artifacts change shape.</p>
      <table>
        <thead><tr><th width="30%">Consumer</th><th width="25%">Depends on</th><th width="25%">Impact if broken</th><th width="20%">Notes</th></tr></thead>
        <tbody>
          <tr>
            <td><code><!-- consumer --></code></td>
            <td><code><!-- artifact --></code></td>
            <td><!-- impact --></td>
            <td><!-- notes --></td>
          </tr>
        </tbody>
      </table>
    </div>

  </section><!-- end t4 -->


  <!-- ─── FLOATING ACTION BAR ──────────────────────────────────────── -->
  <div class="action-bar">
    <button class="primary" onclick="copyDecisions()">&#128203; Copy Decisions (all tabs)</button>
    <button class="ghost" onclick="resetAll()">&#8635; Reset</button>
  </div>

</main>


<!-- ─── TAB SWITCHING JS ─────────────────────────────────────────────── -->
<script>
(function() {

  // ── Top-level tab switching ──────────────────────────────────────────
  // Each top-level tab button has data-tab="tN".
  // Sub-tab state is preserved when switching top-level tabs (not reset).
  document.querySelectorAll('nav.tabs button[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('nav.tabs button[data-tab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('main > .panel').forEach(p => p.classList.remove('active'));
      const panel = document.getElementById(target);
      if (panel) panel.classList.add('active');
      window.scrollTo({top: 0, behavior: 'instant'});
      // Trigger Mermaid lazy render for the newly visible panel
      setTimeout(() => renderMermaidInPanel(panel), 50);
    });
  });

  // ── Sub-tab switching ────────────────────────────────────────────────
  // Each sub-tab button has data-subtab="tN-xxx".
  // Sub-tabs are scoped to their parent panel via the nearest nav.subtabs ancestor.
  // Switching sub-tabs in panel t1 does NOT affect sub-tab state in t2/t3/t4.
  document.querySelectorAll('nav.subtabs button[data-subtab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.subtab;
      // Scope to the parent panel's subtab navigation
      const parentNav = btn.closest('nav.subtabs');
      if (!parentNav) return;
      // Deactivate all buttons in THIS subtab nav
      parentNav.querySelectorAll('button[data-subtab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Find the parent panel that contains this nav
      const parentPanel = parentNav.closest('.panel');
      if (!parentPanel) return;
      // Deactivate all subpanels inside this panel
      parentPanel.querySelectorAll('.subpanel').forEach(sp => sp.classList.remove('active'));
      // Activate the target subpanel
      const subpanel = document.getElementById(targetId);
      if (subpanel) {
        subpanel.classList.add('active');
        // Trigger Mermaid lazy render
        setTimeout(() => renderMermaidInPanel(subpanel), 50);
      }
    });
  });

})();
</script>


<!-- ─── ACTION BAR — copy decisions / reset ──────────────────────────── -->
<script>
function copyDecisions() {
  // Collect all radio group decisions + textarea notes across ALL panels
  const phases = ['pA', 'pB', 'pC', 'pD', 'pE', 'wave-final'];
  const labels = {
    pA: 'Phase A',
    pB: 'Phase B',
    pC: 'Phase C',
    pD: 'Phase D',
    pE: 'Phase E / Final squash',
    'wave-final': 'Wave final decision'
  };
  const lines = [
    '# MUTAGENT-DIAGNOSTICS — Wave-{{WAVE_N}} decisions',
    '',
    'Generated: ' + new Date().toISOString(),
    ''
  ];
  phases.forEach(name => {
    const radios = document.querySelectorAll('input[name="' + name + '"]');
    let decision = 'NO SELECTION';
    radios.forEach(r => { if (r.checked) decision = r.value.toUpperCase(); });
    const block = radios.length ? radios[0].closest('.lockin') : null;
    const notes = block ? (block.querySelector('textarea')?.value.trim() || '') : '';
    lines.push('## ' + (labels[name] || name));
    lines.push('- **Decision**: ' + decision);
    lines.push('- **Notes**: ' + (notes || '(none)'));
    lines.push('');
  });
  const out = lines.join('\n');
  navigator.clipboard.writeText(out).then(() => {
    const btn = document.querySelector('.action-bar button.primary');
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = 'Copied &#10003;';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }).catch(() => { window.prompt('Copy decisions:', out); });
}

function resetAll() {
  if (!confirm('Reset all phase approvals and wave decisions?')) return;
  document.querySelectorAll('input[type=radio]').forEach(r => r.checked = false);
  document.querySelectorAll('textarea').forEach(t => t.value = '');
}
</script>


<!-- ─── MERMAID with MUTAGENT-themed colors + tab/sub-tab aware rendering ──── -->
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>
(function() {
  const themeConfig = {
    startOnLoad: false,  // managed manually for tab-awareness
    theme: "dark",
    themeVariables: {
      primaryColor: "#1f1f2e", primaryTextColor: "#f5f5f9", primaryBorderColor: "#a78bfa",
      lineColor: "#a78bfa", secondaryColor: "#252535", tertiaryColor: "#1c1c2a",
      background: "#0a0a10", mainBkg: "#1f1f2e", secondBkg: "#252535", textColor: "#f5f5f9",
      nodeBorder: "#a78bfa", clusterBkg: "#14141e", clusterBorder: "#a78bfa",
      labelTextColor: "#f5f5f9", labelBoxBkgColor: "#1f1f2e",
      cScale0: "#a78bfa", cScale1: "#06b6d4", cScale2: "#10b981", cScale3: "#f59e0b", cScale4: "#f0abfc"
    },
    securityLevel: "loose",
    flowchart: { useMaxWidth: true, curve: "basis" }
  };

  // Render all unprocessed .mermaid elements that are currently VISIBLE
  // (i.e., inside an .active .panel > .active .subpanel OR directly in .active .panel)
  window.renderMermaidInPanel = function(container) {
    if (!container || typeof mermaid === "undefined") return;
    mermaid.initialize(themeConfig);
    const pending = container.querySelectorAll(".mermaid:not([data-processed])");
    if (pending.length) {
      mermaid.run({ nodes: Array.from(pending) }).catch(e => console.error("mermaid:", e));
    }
  };

  function renderVisibleOnLoad() {
    if (typeof mermaid === "undefined") return;
    mermaid.initialize(themeConfig);
    // Collect all .mermaid elements that are inside active panels/subpanels
    const all = document.querySelectorAll(".mermaid:not([data-processed])");
    const visible = Array.from(all).filter(el => {
      // Must be inside an active panel
      const panel = el.closest(".panel");
      if (panel && !panel.classList.contains("active")) return false;
      // If inside a subpanel, that subpanel must also be active
      const subpanel = el.closest(".subpanel");
      if (subpanel && !subpanel.classList.contains("active")) return false;
      return true;
    });
    if (visible.length) {
      mermaid.run({ nodes: visible }).catch(e => console.error("mermaid:", e));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderVisibleOnLoad);
  } else {
    renderVisibleOnLoad();
  }
})();
</script>

</body>
</html>
