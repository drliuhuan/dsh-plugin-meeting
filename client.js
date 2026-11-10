// dsh-plugin-meeting — Web client half.
//
// Loaded as a classic script through DSH's module loader, so React comes from
// the loader's `require` and nothing is imported at module scope.  Adds a
// Session-header toggle and one portaled right-sidebar panel.
// The panel is mounted from the header component and portaled to document.body,
// so the shell frame's overflow/containing block cannot clip it when the app is
// shifted left to make room for the sidebar.
// The panel is a projection of the Host snapshot plus SSE deltas; all audio,
// ASR and model work stays in the Host.

(function () {
  'use strict';

  var PLUGIN_ID = 'dsh-plugin-meeting';
  var API = {
    state: '/dsh-meeting/state',
    events: '/dsh-meeting/events',
    start: '/dsh-meeting/start',
    stop: '/dsh-meeting/stop',
    ask: '/dsh-meeting/ask',
    settings: '/dsh-meeting/settings',
    profile: '/dsh-meeting/profile',
    script: '/dsh-meeting/script',
    prepare: '/dsh-meeting/prepare',
    devices: '/dsh-meeting/devices',
    history: '/dsh-meeting/history',
    load: '/dsh-meeting/load',
    retryCorrection: '/dsh-meeting/retry-correction',
    summary: '/dsh-meeting/summary',
    speaker: '/dsh-meeting/speaker',
    agenda: '/dsh-meeting/agenda',
    agendaImage: '/dsh-meeting/agenda-image',
    agendaFile: '/dsh-meeting/agenda-file',
    agendaCurrent: '/dsh-meeting/agenda-current',
    turnSpeaker: '/dsh-meeting/turn-speaker',
    cue: '/dsh-meeting/cue',
    agendaEntries: '/dsh-meeting/agenda-entries',
    newMeeting: '/dsh-meeting/new'
  };
  var STYLE_ID = 'dsh-meeting-style';
  var STORAGE_KEY = 'dsh-meeting:form:v2';
  var MAX_RENDER_LINES = 320;

  var ROLES = [
    { id: '', label: '未设置' },
    { id: 'host', label: '主持人' },
    { id: 'speaker', label: '讲者' },
    { id: 'panelist', label: '讨论嘉宾' },
    { id: 'attendee', label: '参会者' }
  ];

  var DOMAINS = [
    { id: 'general', label: '通用会议' },
    { id: 'medical', label: '医学 / 临床' },
    { id: 'tech', label: '科技 / IT' },
    { id: 'game', label: '游戏' },
    { id: 'finance', label: '金融' },
    { id: 'legal', label: '法律' },
    { id: 'education', label: '教育' },
    { id: 'manufacturing', label: '制造 / 工程' },
    { id: 'marketing', label: '市场 / 销售' },
    { id: 'research', label: '科研' },
    { id: 'custom', label: '自定义领域' }
  ];
  var TARGETS = [
    { id: 'off', label: '不翻译（默认）' },
    { id: 'en', label: 'English' },
    { id: 'zh', label: '简体中文' },
    { id: 'ja', label: '日本語' },
    { id: 'ko', label: '한국어' }
  ];
  var ASR_LANGS = [
    { id: 'auto', label: '自动识别' },
    { id: 'zh', label: '中文' },
    { id: 'en', label: 'English' },
    { id: 'yue', label: '粤语' },
    { id: 'ja', label: '日本語' },
    { id: 'ko', label: '한국어' }
  ];
  var SUMMARY_LANGS = [
    { id: 'zh', label: '简体中文' },
    { id: 'en', label: 'English' }
  ];
  var PHASE_TEXT = {
    unavailable: '语音服务未启用',
    'missing-provider': '未找到本地识别器',
    unprepared: '语音模型尚未准备',
    checking: '正在检查模型缓存',
    downloading: '正在下载语音模型',
    loading: '正在加载语音模型',
    waking: '正在唤醒语音进程',
    ready: '语音模型已就绪',
    standby: '语音模型已就绪',
    failed: '语音模型准备失败',
    cancelled: '语音模型准备已取消',
    idle: '语音模型空闲',
    unknown: '语音模型状态未知'
  };

  var store = { open: false, tab: 'transcript', status: 'idle' };
  var storeListeners = new Set();

  function setStore(patch) {
    store = Object.assign({}, store, typeof patch === 'function' ? patch(store) : patch);
    storeListeners.forEach(function (listener) {
      try {
        listener();
      } catch (error) {
        /* a dead subscriber must not break the toggle */
      }
    });
  }

  function subscribeStore(listener) {
    storeListeners.add(listener);
    return function () {
      storeListeners.delete(listener);
    };
  }

  function insertStyle() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.dshm-toggle{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border:1px solid transparent;',
      'border-radius:var(--dsw-radius-sm,6px);background:0 0;color:var(--dsw-alias-label-secondary,#b9b9b9);',
      'font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}',
      '.dshm-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f2f2f2)}',
      '.dshm-toggle[data-active="true"]{color:var(--dsw-alias-state-business-primary,#7fb0ff);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#7fb0ff) 45%,transparent)}',
      '.dshm-toggle[data-listening="true"]{color:#51d88a;border-color:rgba(81,216,138,.55);',
      'animation:dshm-breathe 2.2s ease-in-out infinite}',
      '.dshm-toggle[data-listening="true"] svg{filter:drop-shadow(0 0 4px rgba(81,216,138,.85))}',
      '.dshm-toggle[data-busy="true"]{color:#f0b45a;border-color:rgba(240,180,90,.45)}',
      '.dshm-toggle[data-error="true"]{color:#ff8a8a;border-color:rgba(255,138,138,.5)}',
      '@keyframes dshm-breathe{0%,100%{box-shadow:0 0 0 0 rgba(81,216,138,0);opacity:.82}',
      '50%{box-shadow:0 0 0 5px rgba(81,216,138,.2);opacity:1}}',
      '.dshm-toggle svg{width:14px;height:14px;flex:none}',
      '.dshm-toggle-label{display:inline}',
      '@media (max-width:1180px){.dshm-toggle-label{display:none}}',

      '.dshm-panel{position:fixed;top:0;right:0;bottom:0;width:var(--dsh-meeting-width,540px);z-index:74;display:flex;',
      'flex-direction:column;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-right:0;border-top:0;border-bottom:0;',
      'border-radius:0;overflow:hidden;background:var(--dsw-alias-bg-module-platform,#1f1f1f);color:var(--dsw-alias-label-primary,#f2f2f2);',
      'box-shadow:-18px 0 48px rgba(0,0,0,.28);font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
      'html.dsh-meeting-sidebar #root{margin-right:var(--dsh-meeting-width,540px)!important;transition:margin-right .22s ease}',
      'html[data-windows-titlebar] .dshm-panel{top:var(--dsh-windows-titlebar-height,40px)}',
      '@media (max-width:900px){',
      'html.dsh-meeting-sidebar #root{margin-right:0!important}',
      '.dshm-panel{top:8px;right:8px;bottom:8px;left:8px;width:auto;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.42)}',
      '}',
      '@media (max-width:720px){.dshm-panel{top:8px;right:8px;bottom:8px;left:8px;width:auto;border-radius:12px}}',
      '.dshm-head{padding:13px 14px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));flex:none}',
      '.dshm-titleRow{display:flex;align-items:flex-start;gap:9px}',
      '.dshm-dot{width:9px;height:9px;border-radius:999px;margin-top:5px;flex:none;background:var(--dsw-alias-label-caption,#777)}',
      '.dshm-dot[data-tone="live"]{background:#51d88a;box-shadow:0 0 0 4px rgba(81,216,138,.16);animation:dshm-pulse 1.6s ease-in-out infinite}',
      '.dshm-dot[data-tone="busy"]{background:#f0b45a}',
      '.dshm-dot[data-tone="error"]{background:#ff7b7b}',
      '@keyframes dshm-pulse{0%,100%{opacity:1}50%{opacity:.45}}',
      '.dshm-title{font-size:14px;font-weight:650;line-height:20px}',
      '.dshm-sub{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9a9a9a);margin-top:1px}',
      '.dshm-headActions{margin-left:auto;display:flex;align-items:center;gap:4px;flex:none}',
      '.dshm-iconBtn{width:26px;height:26px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:0 0;',
      'color:var(--dsw-alias-label-secondary,#b9b9b9);font:inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}',
      '.dshm-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f2f2f2)}',
      '.dshm-iconBtn[data-on="true"]{color:var(--dsw-alias-state-business-primary,#7fb0ff)}',

      '.dshm-bar{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));flex:none}',
      '.dshm-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));border-radius:999px;',
      'background:0 0;color:var(--dsw-alias-label-primary,#f2f2f2);font:inherit;font-size:12px;font-weight:600;',
      'padding:6px 12px;cursor:pointer;white-space:nowrap}',
      '.dshm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '.dshm-btn:disabled{opacity:.5;cursor:default}',
      '.dshm-btn[data-kind="primary"]{background:var(--dsw-alias-state-business-primary,#3f7cff);border-color:transparent;color:#fff}',
      '.dshm-btn[data-kind="primary"]:hover:not(:disabled){filter:brightness(1.08)}',
      '.dshm-btn[data-kind="danger"]{border-color:rgba(255,123,123,.5);color:#ff9a9a}',
      '.dshm-btn[data-kind="ghost"]{border-color:transparent;color:var(--dsw-alias-label-secondary,#b9b9b9)}',
      '.dshm-btn[data-kind="small"]{padding:3px 9px;font-size:11px}',
      '.dshm-timer{margin-left:auto;font:12px ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-tertiary,#9a9a9a)}',
      '.dshm-tabs{display:flex;gap:2px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));flex:none}',
      '.dshm-agendaBar{display:flex;align-items:center;gap:6px;padding:5px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));',
      'font-size:10.5px;line-height:1.4;flex:none;color:var(--dsw-alias-label-tertiary,#9a9a9a);white-space:nowrap;overflow:hidden}',
      '.dshm-agendaBar[data-status="current"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3f7cff) 10%,transparent)}',
      '.dshm-agendaNow{font-weight:650;color:var(--dsw-alias-state-business-primary,#7fb0ff);flex:none}',
      '.dshm-agendaText{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,#c7c7c7)}',
      '.dshm-agendaClock{margin-left:auto;font:10px ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-caption,#777);flex:none}',
      '.dshm-agendaBarWrap{position:relative;flex:none}',
      '.dshm-agendaBar[role="button"]{cursor:pointer}',
      '.dshm-agendaBar[data-status="pinned"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3f7cff) 16%,transparent)}',
      '.dshm-menu{position:absolute;z-index:60;top:100%;left:8px;right:8px;max-height:46vh;overflow:auto;padding:4px;border-radius:10px;',
      'background:var(--dsw-alias-bg-popover,#1e1e1f);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));box-shadow:0 10px 30px rgba(0,0,0,.35)}',
      '.dshm-menuItem{display:block;width:100%;text-align:left;background:0 0;border:0;color:inherit;font:inherit;font-size:11px;',
      'padding:6px 8px;border-radius:7px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshm-menuItem:hover{background:rgba(127,176,255,.16)}',
      '.dshm-menuItem[data-current="true"]{background:rgba(127,176,255,.24);font-weight:650}',
      '.dshm-menuInline{position:static;margin:6px 0 0;max-height:260px}',
      '.dshm-dropOverlay{position:absolute;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;text-align:center;padding:18px;',
      'font-size:12px;color:var(--dsw-alias-state-business-primary,#7fb0ff);background:color-mix(in srgb,var(--dsw-alias-bg-base,#141414) 82%,transparent);',
      'border:2px dashed var(--dsw-alias-state-business-primary,#3f7cff);border-radius:12px;pointer-events:none}',
      '.dshm-menuLabel{font-size:9.5px;color:var(--dsw-alias-label-caption,#777);padding:4px 8px 2px}',
      '.dshm-menuCustom{display:grid;grid-template-columns:1fr 1fr auto;gap:4px;padding:6px 8px 2px;border-top:1px solid rgba(255,255,255,.1);margin-top:4px}',
      '.dshm-table{display:flex;flex-direction:column;gap:5px;margin-top:7px}',
      '.dshm-tableRow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) 26px;gap:4px;align-items:center}',
      '.dshm-tableHead{font-size:10px;color:var(--dsw-alias-label-caption,#777);gap:4px}',
      '.dshm-timeInput{font-family:ui-monospace,Consolas,monospace;font-size:11px}',
      '.dshm-cue{padding:7px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}',
      '.dshm-cue:first-of-type{border-top:0}',
      '.dshm-cueText{margin:4px 0 0;font-size:12px;line-height:1.65;white-space:pre-wrap}',
      '.dshm-tab{appearance:none;border:none;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:var(--dsw-alias-label-secondary,#b9b9b9);',
      'font:inherit;font-size:12px;font-weight:600;padding:6px 10px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}',
      '.dshm-tab[data-on="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#f2f2f2)}',
      '.dshm-badge{min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-state-business-primary,#3f7cff);',
      'color:#fff;font-size:10px;line-height:16px;text-align:center}',

      '.dshm-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}',
      '.dshm-body::-webkit-scrollbar{width:8px}.dshm-body::-webkit-scrollbar-thumb{background:rgba(128,128,128,.35);border-radius:8px}',
      '.dshm-section{padding:12px 14px}',
      '.dshm-card{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:12px;padding:11px 12px;margin:0 0 10px;',
      'background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#2b2b2b) 72%,transparent)}',
      '.dshm-cardTitle{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:650;margin:0 0 4px}',
      '.dshm-muted{color:var(--dsw-alias-label-tertiary,#9a9a9a);font-size:11.5px;line-height:1.55;margin:0}',
      '.dshm-note{color:var(--dsw-alias-label-secondary,#c7c7c7);font-size:11.5px;line-height:1.6}',
      '.dshm-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px}',
      '@media (max-width:520px){.dshm-grid{grid-template-columns:1fr}}',
      '.dshm-field{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.dshm-field > span{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9a9a9a);font-weight:600;letter-spacing:.02em}',
      '.dshm-input,.dshm-select,.dshm-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));',
      'border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.18));color:var(--dsw-alias-label-primary,#f2f2f2);',
      'font:inherit;font-size:12px;padding:7px 8px;outline:none}',
      '.dshm-input:focus,.dshm-select:focus,.dshm-textarea:focus{border-color:var(--dsw-alias-state-business-primary,#3f7cff);',
      'box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#3f7cff) 25%,transparent)}',
      '.dshm-textarea{resize:vertical;min-height:48px;line-height:1.5}',
      '.dshm-check{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#c7c7c7);cursor:pointer}',
      '.dshm-check input{accent-color:var(--dsw-alias-state-business-primary,#3f7cff)}',
      '.dshm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshm-progress{height:6px;border-radius:999px;background:rgba(128,128,128,.25);overflow:hidden;margin:8px 0 4px}',
      '.dshm-progress > i{display:block;height:100%;background:var(--dsw-alias-state-business-primary,#3f7cff);transition:width .25s ease}',
      '.dshm-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:180px;padding:28px 22px;text-align:center}',
      '.dshm-emptyIcon{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
      'background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3f7cff) 16%,transparent);color:var(--dsw-alias-state-business-primary,#7fb0ff)}',
      '.dshm-emptyTitle{font-size:13px;font-weight:650}',

      '.dshm-lines{padding:4px 14px 14px}',
      '.dshm-group{border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.2));',
      'background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#2b2b2b) 32%,transparent);',
      'border-radius:0 10px 10px 0;padding:7px 9px 2px;margin:6px 0 8px}',
      '.dshm-groupHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px}',
      '.dshm-groupOrg{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}',
      '.dshm-groupTime{margin-left:auto;font:10px ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-caption,#777)}',
      '.dshm-turn{border-left:3px solid var(--dsw-alias-border-l2,rgba(255,255,255,.2));',
      'background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#2b2b2b) 34%,transparent);',
      'border-radius:0 12px 12px 0;padding:8px 10px 7px;margin:7px 0 9px}',
      '.dshm-turnHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px}',
      '.dshm-turnText{font-size:13px;line-height:1.68;word-break:break-word;white-space:pre-wrap}',
      '.dshm-turnText[data-pending="true"]{color:var(--dsw-alias-label-secondary,#c7c7c7)}',
      '.dshm-segment{display:flex;gap:6px;font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#9a9a9a);margin-top:2px}',
      '.dshm-segmentTime{font:10px ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-caption,#777);flex:none}',
      '.dshm-followWrap{position:sticky;bottom:10px;display:flex;justify-content:center;padding:0 14px 12px;pointer-events:none}',
      '.dshm-followBtn{pointer-events:auto;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.2));border-radius:999px;',
      'background:rgba(30,30,30,.94);color:var(--dsw-alias-label-primary,#f2f2f2);font:inherit;font-size:11px;padding:6px 12px;',
      'box-shadow:0 6px 20px rgba(0,0,0,.35);cursor:pointer}',
      '.dshm-followBtn:hover{background:rgba(45,45,45,.98)}',
      '.dshm-line{padding:9px 0 8px;border-bottom:1px dotted var(--dsw-alias-border-l2,rgba(255,255,255,.1))}',
      '.dshm-line:last-child{border-bottom:none}',
      '.dshm-lineHead{display:flex;align-items:center;gap:6px;margin-bottom:3px}',
      '.dshm-time{font:10.5px ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-caption,#777)}',
      '.dshm-speaker{font-size:10px;line-height:15px;padding:0 6px;border-radius:999px;border:1px solid currentColor;',
      'opacity:.9;white-space:nowrap}',
      '.dshm-speakerRow{display:flex;align-items:center;gap:7px;margin-top:6px}',
      '.dshm-speakerDot{width:9px;height:9px;border-radius:50%;flex:none}',
      '.dshm-speakerId{font:10px ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-caption,#777);width:24px;flex:none}',
      '.dshm-orgInput{max-width:128px}',
      '.dshm-agendaList{margin-top:7px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));padding-top:6px}',
      '.dshm-agendaItem{display:flex;gap:8px;align-items:baseline;font-size:10.5px;line-height:1.5;padding:2px 4px;border-radius:6px;',
      'color:var(--dsw-alias-label-tertiary,#9a9a9a)}',
      '.dshm-agendaItem[data-current="true"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3f7cff) 14%,transparent);',
      'color:var(--dsw-alias-label-primary,#f2f2f2)}',
      '.dshm-agendaTime{font:10px ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-caption,#777);flex:none;width:76px}',
      '.dshm-card[data-drag="true"]{border-color:var(--dsw-alias-state-business-primary,#3f7cff);',
      'box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#3f7cff) 24%,transparent)}',
      '.dshm-dropHint{border:1px dashed var(--dsw-alias-state-business-primary,#3f7cff);border-radius:8px;padding:8px;text-align:center;',
      'font-size:11px;color:var(--dsw-alias-state-business-primary,#7fb0ff);margin-top:6px}',
      '.dshm-pill{font-size:9.5px;line-height:15px;padding:0 5px;border-radius:999px;border:1px solid transparent;',
      'color:var(--dsw-alias-label-tertiary,#9a9a9a)}',
      '.dshm-pill[data-tone="good"]{color:#7ddca4;border-color:rgba(125,220,164,.28)}',
      '.dshm-pill[data-tone="busy"]{color:#f0c078;border-color:rgba(240,192,120,.28)}',
      '.dshm-pill[data-tone="bad"]{color:#ff9a9a;border-color:rgba(255,154,154,.28)}',
      '.dshm-text{font-size:13px;line-height:1.62;word-break:break-word}',
      '.dshm-text[data-pending="true"]{color:var(--dsw-alias-label-secondary,#c7c7c7)}',
      '.dshm-translation{margin-top:3px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-tertiary,#a9a9a9);word-break:break-word}',
      '.dshm-raw{margin-top:4px;font-size:10.5px;color:var(--dsw-alias-label-caption,#777)}',
      '.dshm-raw summary{cursor:pointer;user-select:none}',
      '.dshm-raw p{margin:3px 0 0;color:var(--dsw-alias-label-tertiary,#9a9a9a);line-height:1.5}',
      '.dshm-recognizing{display:flex;align-items:center;gap:7px;padding:8px 14px;color:var(--dsw-alias-label-tertiary,#9a9a9a);font-size:11.5px}',
      '.dshm-dots span{display:inline-block;width:4px;height:4px;border-radius:50%;background:currentColor;margin-right:2px;animation:dshm-blink 1.1s infinite}',
      '.dshm-dots span:nth-child(2){animation-delay:.15s}.dshm-dots span:nth-child(3){animation-delay:.3s}',
      '@keyframes dshm-blink{0%,80%,100%{opacity:.25}40%{opacity:1}}',

      '.dshm-markdown{font-size:12.5px;line-height:1.7;word-break:break-word}',
      '.dshm-markdown h1,.dshm-markdown h2,.dshm-markdown h3,.dshm-markdown h4{margin:12px 0 5px;line-height:1.35}',
      '.dshm-markdown h1{font-size:15px}.dshm-markdown h2{font-size:13.5px}.dshm-markdown h3{font-size:12.5px}',
      '.dshm-markdown p{margin:4px 0 7px}',
      '.dshm-markdown ul,.dshm-markdown ol{margin:3px 0 8px;padding-left:19px}',
      '.dshm-markdown li{margin:2px 0}',
      '.dshm-markdown code{font:11.5px ui-monospace,Consolas,monospace;background:rgba(128,128,128,.16);border-radius:4px;padding:1px 4px}',
      '.dshm-markdown pre{background:rgba(0,0,0,.25);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:8px;',
      'padding:9px 10px;overflow:auto;font:11.5px/1.55 ui-monospace,Consolas,monospace}',
      '.dshm-markdown blockquote{margin:4px 0;padding:2px 10px;border-left:3px solid var(--dsw-alias-border-l2,rgba(255,255,255,.25));',
      'color:var(--dsw-alias-label-tertiary,#aaa)}',
      '.dshm-markdown a{color:var(--dsw-alias-state-business-primary,#7fb0ff);text-decoration:none}',
      '.dshm-markdown a:hover{text-decoration:underline}',
      '.dshm-markdown strong{font-weight:650}',

      '.dshm-qa{display:flex;flex-direction:column;min-height:100%;padding:10px 14px 14px;box-sizing:border-box}',
      '.dshm-answers{flex:1;display:flex;flex-direction:column;gap:10px;padding-bottom:8px}',
      '.dshm-answer{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:12px;padding:9px 11px;',
      'background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#2b2b2b) 62%,transparent)}',
      '.dshm-q{font-size:12px;font-weight:650;margin:0 0 5px;color:var(--dsw-alias-label-primary,#f2f2f2)}',
      '.dshm-a{font-size:12.5px;line-height:1.68;white-space:normal;word-break:break-word}',
      '.dshm-aStatus{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9a9a9a);margin:2px 0 3px}',
      '.dshm-sources{margin-top:7px;display:flex;flex-direction:column;gap:3px}',
      '.dshm-source{font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary,#a9a9a9);text-decoration:none}',
      '.dshm-source:hover{color:var(--dsw-alias-state-business-primary,#7fb0ff)}',
      '.dshm-askBar{display:flex;align-items:flex-end;gap:7px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));flex:none}',
      '.dshm-askInput{flex:1;min-height:38px;max-height:120px;resize:vertical}',
      '.dshm-chips{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0 0}',
      '.dshm-chip{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:999px;background:0 0;',
      'color:var(--dsw-alias-label-secondary,#c7c7c7);font:inherit;font-size:10.5px;padding:4px 8px;cursor:pointer}',
      '.dshm-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',

      '.dshm-history{position:absolute;inset:0;z-index:5;background:var(--dsw-alias-bg-module-platform,#1f1f1f);display:flex;flex-direction:column}',
      '.dshm-historyHead{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}',
      '.dshm-historyList{flex:1;overflow:auto;padding:8px 14px 14px}',
      '.dshm-historyItem{width:100%;text-align:left;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:10px;',
      'background:0 0;color:inherit;font:inherit;padding:8px 10px;margin-bottom:7px;cursor:pointer}',
      '.dshm-historyItem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}',
      '.dshm-historyTitle{font-size:12px;font-weight:650;margin:0 0 2px}',
      '.dshm-historyMeta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}',
      '.dshm-historyPreview{font-size:10.5px;color:var(--dsw-alias-label-caption,#888);margin-top:3px;line-height:1.45}',

      '.dshm-toast{position:absolute;left:12px;right:12px;bottom:12px;z-index:6;border-radius:10px;padding:8px 10px;',
      'background:rgba(30,30,30,.96);border:1px solid rgba(255,255,255,.14);color:#f2f2f2;font-size:11.5px;line-height:1.45;',
      'box-shadow:0 8px 24px rgba(0,0,0,.35)}',
      '.dshm-toast[data-tone="error"]{border-color:rgba(255,123,123,.5);color:#ffd0d0}',
      '.dshm-error{border:1px solid rgba(255,123,123,.42);background:rgba(255,123,123,.08);color:#ffb3b3;',
      'border-radius:10px;padding:8px 10px;font-size:11.5px;line-height:1.5;margin:0 0 9px;white-space:pre-wrap;word-break:break-word}',
      '.dshm-warning{border:1px solid rgba(240,180,90,.35);background:rgba(240,180,90,.07);color:#f0c078;border-radius:10px;',
      'padding:7px 9px;font-size:11px;line-height:1.5;margin:0 0 8px}',
      '.dshm-foot{display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));',
      'font-size:10.5px;color:var(--dsw-alias-label-caption,#777);flex:none}',
      '.dshm-foot .dshm-spacer{flex:1}',
      '.dshm-spinner{width:12px;height:12px;border:2px solid rgba(128,128,128,.3);border-top-color:currentColor;border-radius:50%;',
      'animation:dshm-spin .8s linear infinite;display:inline-block;vertical-align:-2px}',
      '@keyframes dshm-spin{to{transform:rotate(360deg)}}'
    ].join('');
    document.head.appendChild(style);
  }

  function formatClock(ms) {
    var total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    var minutes = Math.floor(total / 60);
    var seconds = Math.floor(total % 60);
    return (minutes < 10 ? '0' : '') + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
  }

  function formatDate(ms) {
    try {
      return new Date(ms).toLocaleString('zh-CN', { hour12: false });
    } catch {
      return '';
    }
  }

  var SPEAKER_COLORS = ['#7fb0ff', '#7ddca4', '#f0c078', '#d9a7ff', '#ff9a9a', '#67d6e8', '#f0a6d0', '#b8e986'];

  function speakerColor(id) {
    if (id === 'self') return '#51d88a';
    var match = /^sp(\d+)$/.exec(String(id || ''));
    var index = match ? Number(match[1]) - 1 : 0;
    return SPEAKER_COLORS[Math.abs(index) % SPEAKER_COLORS.length];
  }

  function clockMin(minutes) {
    if (minutes === null || minutes === undefined || !isFinite(minutes)) return '';
    var value = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return (value < 600 ? '0' : '') + Math.floor(value / 60) + ':' + (value % 60 < 10 ? '0' : '') + (value % 60);
  }

  // Editable agenda table: the same shape in the setup flow and in settings.
  function rowsFromEntries(entries) {
    return (Array.isArray(entries) ? entries : []).map(function (entry) {
      return {
        start: entry && entry.startMin !== null && entry.startMin !== undefined ? clockMin(entry.startMin) : '',
        end: entry && entry.endMin !== null && entry.endMin !== undefined ? clockMin(entry.endMin) : '',
        speaker: (entry && entry.speaker) || '',
        org: (entry && entry.org) || '',
        topic: (entry && entry.topic) || ''
      };
    });
  }

  function entriesFromRows(rows) {
    return (Array.isArray(rows) ? rows : []).map(function (row) {
      return {
        start: String(row.start || '').trim(),
        end: String(row.end || '').trim(),
        speaker: String(row.speaker || '').trim(),
        org: String(row.org || '').trim(),
        topic: String(row.topic || '').trim()
      };
    }).filter(function (row) {
      return row.start || row.speaker || row.topic;
    });
  }

  function currentAgendaClient(entries) {
    var list = Array.isArray(entries) ? entries.filter(function (entry) { return entry && entry.startMin !== null && entry.startMin !== undefined; }) : [];
    if (list.length === 0) return { status: 'empty', entry: null, clock: '' };
    var now = new Date();
    var minutes = now.getHours() * 60 + now.getMinutes();
    var current = null;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].startMin <= minutes && list[i].endMin !== null && minutes < list[i].endMin) {
        current = list[i];
        break;
      }
    }
    if (current) return { status: 'current', entry: current, clock: clockMin(minutes) };
    for (var j = 0; j < list.length; j += 1) {
      if (list[j].startMin > minutes) return { status: 'next', entry: list[j], clock: clockMin(minutes) };
    }
    return { status: 'ended', entry: list[list.length - 1], clock: clockMin(minutes) };
  }

  function agendaEntryText(entry) {
    if (!entry) return '';
    var time = entry.startMin !== null && entry.startMin !== undefined
      ? clockMin(entry.startMin) + (entry.endMin !== null && entry.endMin !== undefined ? '-' + clockMin(entry.endMin) : '')
      : '未定时间';
    var who = entry.speaker ? entry.speaker + (entry.org ? '（' + entry.org + '）' : '') : '';
    return time + ' ' + who + (who && entry.topic ? '：' : '') + (entry.topic || '');
  }

  // Mirrors lib/script.mjs: the client needs the same "is this slot mine?"
  // hint to explain why nothing was generated without a round trip.
  function normalizePersonName(value) {
    return String(value || '').replace(/[\s·•・]/g, '').trim().toLowerCase();
  }

  function nameMatches(speaker, userName) {
    var left = normalizePersonName(speaker);
    var right = normalizePersonName(userName);
    if (left.length === 0 || right.length === 0) return false;
    return left === right || left.indexOf(right) >= 0 || right.indexOf(left) >= 0;
  }

  function agendaMatchesUser(entries, userName) {
    var name = String(userName || '').trim();
    if (name.length === 0) return false;
    return (Array.isArray(entries) ? entries : []).some(function (entry) {
      return entry && nameMatches(entry.speaker, name);
    });
  }

  function groupTranscript(lines) {
    var groups = [];
    (Array.isArray(lines) ? lines : []).forEach(function (line) {
      var last = groups[groups.length - 1];
      if (last && line.speakerId && last.speakerId === line.speakerId) {
        last.lines.push(line);
      } else {
        groups.push({
          key: line.id,
          speakerId: line.speakerId || null,
          speakerName: line.speakerName || null,
          speakerOrg: line.speakerOrg || null,
          speakerSuggested: line.speakerSuggested === true,
          lines: [line]
        });
      }
    });
    return groups;
  }

  function turnsFromTranscript(lines) {
    var groups = groupTranscript(lines);
    return groups.map(function (group, index) {
      var text = group.lines.map(function (line) { return line.text || line.raw || ''; }).filter(Boolean).join(' ');
      var translation = group.lines.map(function (line) { return line.translation || ''; }).filter(Boolean).join(' ');
      var first = group.lines[0];
      var last = group.lines[group.lines.length - 1];
      return {
        id: 'fallback-' + index,
        speakerId: group.speakerId,
        speakerName: group.speakerName,
        speakerOrg: group.speakerOrg,
        speakerSuggested: group.speakerSuggested,
        startMs: first.startMs,
        endMs: last.endMs,
        text: text,
        translation: translation,
        correctionStatus: group.lines.some(function (line) { return line.correctionStatus === 'pending' || line.correctionStatus === 'correcting'; }) ? 'pending' : 'done',
        refinedAt: 0,
        segments: group.lines
      };
    });
  }

  function readSavedForm() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function saveForm(form) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    } catch {
      /* private mode */
    }
  }

  function defaultForm(settings) {
    var source = settings && typeof settings === 'object' ? settings : {};
    return {
      title: typeof source.title === 'string' ? source.title : '',
      role: typeof source.role === 'string' ? source.role : '',
      domain: typeof source.domain === 'string' ? source.domain : 'general',
      customDomain: typeof source.customDomain === 'string' ? source.customDomain : '',
      topic: typeof source.topic === 'string' ? source.topic : '',
      glossary: typeof source.glossary === 'string' ? source.glossary : '',
      targetLang: typeof source.targetLang === 'string' ? source.targetLang : 'off',
      asrLang: typeof source.asrLang === 'string' ? source.asrLang : 'auto',
      summaryLang: typeof source.summaryLang === 'string' ? source.summaryLang : 'zh',
      webSearch: source.webSearch !== false,
      speakers: source.speakers !== false,
      speakerThreshold: typeof source.speakerThreshold === 'number' ? source.speakerThreshold : 0.66,
      micEnabled: source.micEnabled !== false,
      micDeviceId: typeof source.micDeviceId === 'string' ? source.micDeviceId : '',
      deviceId: typeof source.deviceId === 'string' ? source.deviceId : '',
      sensitivity: typeof source.sensitivity === 'number' ? source.sensitivity : 0.5
    };
  }

  function formFromActive(active) {
    if (!active) return defaultForm({});
    return {
      title: active.title || '',
      role: active.role || '',
      domain: active.domain || 'general',
      customDomain: active.customDomain || '',
      topic: active.topic || '',
      glossary: active.glossary || '',
      targetLang: active.targetLang || 'off',
      asrLang: active.asrLang || 'auto',
      summaryLang: active.summaryLang || 'zh',
      webSearch: active.webSearch !== false,
      speakers: active.speakersEnabled !== false,
      speakerThreshold: typeof active.speakerThreshold === 'number' ? active.speakerThreshold : 0.66,
      micEnabled: active.micEnabled !== false,
      micDeviceId: active.micDeviceId || '',
      deviceId: active.deviceId || '',
      sensitivity: typeof active.sensitivity === 'number' ? active.sensitivity : 0.5
    };
  }

  function statusTone(snapshot) {
    var active = snapshot && snapshot.active ? snapshot.active : null;
    if (!active) return 'idle';
    if (active.status === 'listening' || active.status === 'capturing') return 'listening';
    if (active.status === 'preparing' || active.status === 'stopping') return 'busy';
    if (active.status === 'error') return 'error';
    return 'idle';
  }

  function statusInfo(active, asr, busy) {    if (busy === 'start') return { tone: 'busy', text: '正在开始…' };
    if (busy === 'stop') return { tone: 'busy', text: '正在收尾…' };
    if (!active) {
      if (!asr || asr.available === false) return { tone: 'error', text: '语音服务未启用' };
      return { tone: 'idle', text: '未开始 · 点击「开始听会」' };
    }
    if (active.readOnly) return { tone: 'idle', text: '历史会议 · 只读' };
    switch (active.status) {
      case 'preparing': return { tone: 'busy', text: '正在准备语音模型…' };
      case 'capturing': return { tone: 'live', text: '正在采集系统音频…' };
      case 'listening': return { tone: 'live', text: '正在听会 · 实时校正与翻译' };
      case 'stopping': return { tone: 'busy', text: '正在收尾并生成最终纪要…' };
      case 'ended': return { tone: 'idle', text: '会议已结束' };
      case 'error': return { tone: 'error', text: '已停止：' + (active.error || '未知错误') };
      default: return { tone: 'idle', text: String(active.status || '未开始') };
    }
  }

  function prepareProgress(asr) {
    if (!asr || !asr.preparation) return null;
    var prep = asr.preparation;
    if (prep.phase === 'downloading' && Number(prep.totalBytes) > 0) {
      return Math.max(0, Math.min(100, Math.round((Number(prep.completedBytes) / Number(prep.totalBytes)) * 100)));
    }
    return null;
  }

  function phaseText(asr) {
    if (!asr) return '语音服务状态未知';
    return PHASE_TEXT[asr.phase] || ('语音模型状态：' + (asr.phase || 'unknown'));
  }

  function safeUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
  }

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: PLUGIN_ID,
      factory: function (require) {
        var React = require('react');
        var ReactDOM = null;
        try {
          ReactDOM = require('react-dom');
        } catch (error) {
          ReactDOM = null;
        }
        var h = React.createElement;

        function useStore() {
          if (typeof React.useSyncExternalStore === 'function') {
            return React.useSyncExternalStore(subscribeStore, function () { return store; });
          }
          var state = React.useState(store);
          React.useEffect(function () {
            return subscribeStore(function () { state[1](store); });
          }, []);
          return state[0];
        }

        function api(path, body, method) {
          return fetch(path, {
            method: method || (body === undefined ? 'GET' : 'POST'),
            headers: body === undefined ? undefined : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            credentials: 'same-origin',
            cache: 'no-store'
          }).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (payload) {
              if (!response.ok || payload.ok === false) {
                var error = new Error(payload.error || ('HTTP ' + response.status));
                error.code = payload.code;
                throw error;
              }
              return payload;
            });
          });
        }

        function Markdown(props) {
          var text = typeof props.text === 'string' ? props.text : '';
          if (text.trim().length === 0) return h('p', { className: 'dshm-muted' }, '暂无内容。');
          var lines = text.split(/\r?\n/);
          var blocks = [];
          var paragraph = [];
          var listItems = null;
          var listOrdered = false;
          var codeLines = null;

          function flushParagraph() {
            if (paragraph.length === 0) return;
            blocks.push(h('p', { key: 'p' + blocks.length }, inline(paragraph.join(' '), 'p' + blocks.length)));
            paragraph = [];
          }
          function flushList() {
            if (listItems === null) return;
            blocks.push(h(listOrdered ? 'ol' : 'ul', { key: 'l' + blocks.length }, listItems));
            listItems = null;
            listOrdered = false;
          }
          function flushCode() {
            if (codeLines === null) return;
            blocks.push(h('pre', { key: 'c' + blocks.length }, h('code', null, codeLines.join('\n'))));
            codeLines = null;
          }

          for (var i = 0; i < lines.length; i += 1) {
            var line = lines[i];
            if (/^```/.test(line)) {
              if (codeLines === null) {
                flushParagraph();
                flushList();
                codeLines = [];
              } else {
                flushCode();
              }
              continue;
            }
            if (codeLines !== null) {
              codeLines.push(line);
              continue;
            }
            if (/^\s*$/.test(line)) {
              flushParagraph();
              flushList();
              continue;
            }
            var heading = /^(#{1,4})\s+(.*)$/.exec(line);
            if (heading) {
              flushParagraph();
              flushList();
              var level = heading[1].length;
              blocks.push(h('h' + level, { key: 'h' + blocks.length }, inline(heading[2], 'h' + blocks.length)));
              continue;
            }
            var bullet = /^\s*[-*]\s+(.*)$/.exec(line);
            if (bullet) {
              flushParagraph();
              if (listItems === null || listOrdered) {
                flushList();
                listItems = [];
              }
              listItems.push(h('li', { key: 'li' + listItems.length }, inline(bullet[1], 'li' + blocks.length + '-' + listItems.length)));
              continue;
            }
            var numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
            if (numbered) {
              flushParagraph();
              if (listItems === null || !listOrdered) {
                flushList();
                listItems = [];
                listOrdered = true;
              }
              listItems.push(h('li', { key: 'li' + listItems.length }, inline(numbered[1], 'li' + blocks.length + '-' + listItems.length)));
              continue;
            }
            var quote = /^\s*>\s?(.*)$/.exec(line);
            if (quote) {
              flushParagraph();
              flushList();
              blocks.push(h('blockquote', { key: 'q' + blocks.length }, inline(quote[1], 'q' + blocks.length)));
              continue;
            }
            paragraph.push(line);
          }
          flushParagraph();
          flushList();
          flushCode();
          return h('div', { className: 'dshm-markdown' }, blocks);
        }

        function inline(text, prefix) {
          var nodes = [];
          var pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
          var last = 0;
          var match;
          var index = 0;
          while ((match = pattern.exec(text)) !== null) {
            if (match.index > last) nodes.push(text.slice(last, match.index));
            var token = match[0];
            if (/^\*\*/.test(token)) {
              nodes.push(h('strong', { key: prefix + '-b' + index }, token.slice(2, -2)));
            } else if (/^\*/.test(token)) {
              nodes.push(h('em', { key: prefix + '-i' + index }, token.slice(1, -1)));
            } else if (/^`/.test(token)) {
              nodes.push(h('code', { key: prefix + '-c' + index }, token.slice(1, -1)));
            } else {
              var link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
              var url = link ? safeUrl(link[2]) : '';
              if (link && url) {
                nodes.push(h('a', { key: prefix + '-a' + index, href: url, target: '_blank', rel: 'noreferrer' }, link[1]));
              } else if (link) {
                nodes.push(link[1]);
              } else {
                nodes.push(token);
              }
            }
            last = match.index + token.length;
            index += 1;
          }
          if (last < text.length) nodes.push(text.slice(last));
          return nodes;
        }

        function WaveIcon() {
          return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
            h('path', { d: 'M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2M21 12h0' })
          );
        }

        function Line(props) {
          var line = props.line;
          var corrected = line.text && line.text.length > 0 ? line.text : line.raw;
          var pending = line.correctionStatus === 'pending' || line.correctionStatus === 'correcting';
          var failed = line.correctionStatus === 'error';
          var changed = line.raw && line.text && line.raw !== line.text;
          return h('div', { className: 'dshm-line' },
            h('div', { className: 'dshm-lineHead' },
              h('span', { className: 'dshm-time' }, formatClock(line.startMs)),
              line.speakerName && !props.compact
                ? h('span', {
                  className: 'dshm-speaker',
                  style: { borderColor: speakerColor(line.speakerId), color: speakerColor(line.speakerId) }
                }, line.speakerName)
                : null,
              pending ? h('span', { className: 'dshm-pill', 'data-tone': 'busy' }, '校正中') : null,
              changed && !pending ? h('span', { className: 'dshm-pill', 'data-tone': 'good' }, '已校正') : null,
              failed ? h('span', { className: 'dshm-pill', 'data-tone': 'bad' }, '校正失败') : null
            ),
            h('div', { className: 'dshm-text', 'data-pending': pending ? 'true' : 'false' }, corrected),
            line.translation ? h('div', { className: 'dshm-translation' }, line.translation) : null,
            changed
              ? h('details', { className: 'dshm-raw' },
                h('summary', null, '识别原文'),
                h('p', null, line.raw))
              : null,
            failed && line.correctionError ? h('div', { className: 'dshm-raw' }, h('p', null, line.correctionError)) : null
          );
        }

        function Turn(props) {
          var turn = props.turn;
          var speakerName = turn.speakerId === 'self' ? '自己' : (turn.speakerName || '');
          var color = speakerColor(turn.speakerId);
          var pending = turn.correctionStatus === 'pending';
          var segments = Array.isArray(turn.segments) ? turn.segments : [];
          var duration = Math.max(0, (Number(turn.endMs) || 0) - (Number(turn.startMs) || 0));
          var speakers = Array.isArray(props.speakers) ? props.speakers : [];
          var roster = Array.isArray(props.roster) ? props.roster : [];
          var [customName, setCustomName] = React.useState('');
          var [customOrg, setCustomOrg] = React.useState('');
          var canPick = Boolean(props.onPickSpeaker || props.onPickPerson);
          return h('div', { className: 'dshm-turn', style: { borderLeftColor: color } },
            h('div', { className: 'dshm-turnHead' },
              h('span', {
                className: 'dshm-speaker',
                style: { borderColor: color, color: color, cursor: canPick ? 'pointer' : 'default' },
                title: canPick ? '点击指定发言人或输入名字' : undefined,
                onClick: canPick
                  ? function () { props.onToggleMenu(turn.id); }
                  : undefined
              }, (speakerName || '未命名') + (canPick ? ' ▾' : '')),
              turn.speakerOrg ? h('span', { className: 'dshm-groupOrg' }, turn.speakerOrg) : null,
              turn.speakerSuggested ? h('span', { className: 'dshm-pill', 'data-tone': 'busy' }, '日程推测') : null,
              pending ? h('span', { className: 'dshm-pill', 'data-tone': 'busy' }, '校正中') : null,
              turn.refinedAt ? h('span', { className: 'dshm-pill', 'data-tone': 'good' }, '整段校正') : null,
              turn.correctionStatus === 'partial' ? h('span', { className: 'dshm-pill', 'data-tone': 'bad' }, '部分未校正') : null,
              h('span', { className: 'dshm-groupTime' }, formatClock(turn.startMs) + '–' + formatClock(turn.endMs) + (duration >= 60000 ? ' · ' + Math.round(duration / 60000) + ' 分钟' : ''))
            ),
            props.menu
              ? h('div', { className: 'dshm-menu dshm-menuInline' },
                roster.length > 0 ? h('div', { className: 'dshm-menuLabel' }, '与会人员（来自日程）') : null,
                roster.map(function (person) {
                  return h('button', {
                    key: 'r:' + person.name, type: 'button', className: 'dshm-menuItem',
                    'data-current': turn.speakerName === person.name ? 'true' : 'false',
                    onClick: function () { props.onPickPerson(turn.id, person.name, person.org); }
                  }, person.name + (person.org ? '（' + person.org + '）' : ''));
                }),
                speakers.length > 0 ? h('div', { className: 'dshm-menuLabel' }, '已识别的发言人') : null,
                speakers.map(function (speaker) {
                  return h('button', {
                    key: speaker.id, type: 'button', className: 'dshm-menuItem',
                    'data-current': turn.speakerId === speaker.id ? 'true' : 'false',
                    onClick: function () { props.onPickSpeaker(turn.id, speaker.id); }
                  }, (speaker.name || '未命名') + (speaker.org ? '（' + speaker.org + '）' : ''));
                }),
                h('button', {
                  key: 'self', type: 'button', className: 'dshm-menuItem',
                  'data-current': turn.speakerId === 'self' ? 'true' : 'false',
                  onClick: function () { props.onPickSpeaker(turn.id, 'self'); }
                }, '自己（我的麦克风）'),
                h('button', {
                  key: 'none', type: 'button', className: 'dshm-menuItem',
                  onClick: function () { props.onPickSpeaker(turn.id, null); }
                }, '未指定'),
                h('div', { className: 'dshm-menuCustom' },
                  h('input', {
                    className: 'dshm-input', value: customName, placeholder: '名字',
                    onChange: function (event) { setCustomName(event.target.value); }
                  }),
                  h('input', {
                    className: 'dshm-input', value: customOrg, placeholder: '单位',
                    onChange: function (event) { setCustomOrg(event.target.value); }
                  }),
                  h('button', {
                    type: 'button', className: 'dshm-btn', 'data-kind': 'small',
                    disabled: !customName.trim(),
                    onClick: function () {
                      if (customName.trim()) props.onPickPerson(turn.id, customName.trim(), customOrg.trim());
                    }
                  }, '指定')))
              : null,
            h('div', { className: 'dshm-turnText', 'data-pending': pending ? 'true' : 'false' }, turn.text || (pending ? '识别中…' : '')),
            turn.translation ? h('div', { className: 'dshm-translation' }, turn.translation) : null,
            segments.length > 0
              ? h('details', { className: 'dshm-raw' },
                h('summary', null, '识别原文（' + segments.length + ' 段）'),
                segments.map(function (segment) {
                  return h('div', { key: segment.id, className: 'dshm-segment' },
                    h('span', { className: 'dshm-segmentTime' }, formatClock(segment.startMs)),
                    h('span', null, segment.raw || '')
                  );
                })
              )
              : null
          );
        }

        function AnswerBubble(props) {
          var answer = props.answer;
          var busy = answer.status === 'searching' || answer.status === 'thinking';
          return h('div', { className: 'dshm-answer' },
            h('p', { className: 'dshm-q' }, answer.question),
            h('div', { className: 'dshm-aStatus' },
              busy ? h('span', { className: 'dshm-spinner' }) : null,
              h('span', null,
                answer.status === 'searching' ? '正在检索会议与外部资料…'
                  : answer.status === 'thinking' ? '正在组织回答…'
                    : answer.status === 'error' ? '回答失败'
                      : '回答'
              )
            ),
            answer.text
              ? h(Markdown, { text: answer.text })
              : busy ? h('div', { className: 'dshm-a' }, h('span', { className: 'dshm-dots' }, h('span'), h('span'), h('span'))) : null,
            answer.error ? h('div', { className: 'dshm-warning' }, answer.error) : null,
            answer.searchError ? h('p', { className: 'dshm-muted' }, '联网检索：' + answer.searchError) : null,
            answer.sources && answer.sources.length > 0
              ? h('div', { className: 'dshm-sources' },
                h('p', { className: 'dshm-muted' }, '外部来源'),
                answer.sources.map(function (source, index) {
                  var url = safeUrl(source.url);
                  return url
                    ? h('a', { key: index, className: 'dshm-source', href: url, target: '_blank', rel: 'noreferrer' }, '↗ ' + source.title)
                    : null;
                }))
              : null
          );
        }

        function MeetingToggle() {
          var state = useStore();
          React.useEffect(function () {
            var alive = true;
            function load() {
              api(API.state).then(function (payload) {
                if (alive) setStore({ status: statusTone(payload) });
              }).catch(function () {
                // a failed poll leaves the last known tone in place
              });
            }
            load();
            var timer = setInterval(load, 5000);
            return function () {
              alive = false;
              clearInterval(timer);
            };
          }, []);

          React.useEffect(function () {
            if (typeof document === 'undefined') return;
            var root = document.documentElement;
            if (state.open) root.classList.add('dsh-meeting-sidebar');
            else root.classList.remove('dsh-meeting-sidebar');
            return function () { root.classList.remove('dsh-meeting-sidebar'); };
          }, [state.open]);

          var listening = state.status === 'listening';
          var busy = state.status === 'busy';
          var failed = state.status === 'error';
          var button = h('button', {
            type: 'button',
            className: 'dshm-toggle',
            'data-active': state.open ? 'true' : 'false',
            'data-listening': listening ? 'true' : 'false',
            'data-busy': busy ? 'true' : 'false',
            'data-error': failed ? 'true' : 'false',
            title: listening ? '会议助手正在听会（点击查看）' : '会议助手：实时转写、校正、翻译、纪要与提问',
            'aria-label': listening ? '会议助手正在听会' : '打开会议助手',
            onClick: function () {
              setStore(function (current) { return { open: !current.open }; });
            }
          }, h(WaveIcon, null), h('span', { className: 'dshm-toggle-label' }, listening ? '听会中' : '会议助手'));

          if (!state.open) return button;
          var panel = h(PanelBoundary, null, h(MeetingPanel, null));
          // Always mount the panel at the viewport level.  The header seat is
          // guaranteed to exist (the user clicked this button); the overlay
          // seat and the shell frame's overflow/containing block are not.
          if (ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined') {
            return h(React.Fragment, null, button, ReactDOM.createPortal(panel, document.body));
          }
          return h(React.Fragment, null, button, panel);
        }

        function MeetingOverlay() {
          var state = useStore();
          React.useEffect(function () {
            if (typeof document === 'undefined') return;
            var root = document.documentElement;
            if (state.open) root.classList.add('dsh-meeting-sidebar');
            else root.classList.remove('dsh-meeting-sidebar');
            return function () { root.classList.remove('dsh-meeting-sidebar'); };
          }, [state.open]);
          if (!state.open) return null;
          var panel = h(PanelBoundary, null, h(MeetingPanel, null));
          if (ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined') {
            // The shell frame is overflow:hidden and may establish a containing
            // block; a fixed child inside it can be clipped once #root is
            // narrowed for the sidebar.  Portal to body so the panel is always
            // a viewport-level right sidebar.
            return ReactDOM.createPortal(panel, document.body);
          }
          return panel;
        }

        class PanelBoundary extends React.Component {
          constructor(props) {
            super(props);
            this.state = { error: null };
          }

          static getDerivedStateFromError(error) {
            return { error: error };
          }

          componentDidCatch(error) {
            try {
              fetch('/dsh-meeting/client-error', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ message: String(error && error.message || error), stack: String(error && error.stack || '') })
              });
            } catch (ignored) {
              // best-effort diagnostics only
            }
          }

          render() {
            if (this.state.error) {
              return h('div', { className: 'dshm-panel' },
                h('div', { className: 'dshm-head' },
                  h('div', { className: 'dshm-titleRow' },
                    h('span', { className: 'dshm-dot', 'data-tone': 'error' }),
                    h('div', null,
                      h('div', { className: 'dshm-title' }, '会议助手加载失败'),
                      h('div', { className: 'dshm-sub' }, '请刷新页面；错误已记录到 Host 诊断')
                    ),
                    h('div', { className: 'dshm-headActions' },
                      h('button', { type: 'button', className: 'dshm-iconBtn', onClick: function () { setStore({ open: false }); } }, '✕')
                    )
                  )
                ),
                h('div', { className: 'dshm-section' },
                  h('div', { className: 'dshm-error' }, String(this.state.error && this.state.error.message || this.state.error))
                )
              );
            }
            return this.props.children;
          }
        }

        function MeetingPanel() {
          insertStyle();
          var [snapshot, setSnapshot] = React.useState(null);
          var [loadError, setLoadError] = React.useState(null);
          var [connection, setConnection] = React.useState('connecting');
          var [busy, setBusy] = React.useState('');
          var [tab, setTab] = React.useState(store.tab || 'transcript');
          var [toast, setToast] = React.useState(null);
          var [historyOpen, setHistoryOpen] = React.useState(false);
          var [history, setHistory] = React.useState(null);
          var [historyBusy, setHistoryBusy] = React.useState(false);
          var [form, setForm] = React.useState(defaultForm({}));
          var [question, setQuestion] = React.useState('');
          var [now, setNow] = React.useState(Date.now());
          var [recognizing, setRecognizing] = React.useState(null);
          var [devices, setDevices] = React.useState([]);
          var [micDevices, setMicDevices] = React.useState([]);
          var [showSettings, setShowSettings] = React.useState(false);
          var [profile, setProfile] = React.useState({ userName: '', userOrg: '' });
          var [scriptPrompt, setScriptPrompt] = React.useState('');
          var [following, setFollowing] = React.useState(true);
          var [dragOver, setDragOver] = React.useState(false);
          var [agendaDraft, setAgendaDraft] = React.useState('');
          var [agendaFilename, setAgendaFilename] = React.useState('');
          var [agendaWarnings, setAgendaWarnings] = React.useState([]);
          var [agendaBusy, setAgendaBusy] = React.useState(false);
          var [agendaSource, setAgendaSource] = React.useState('');
          var [agendaMenuOpen, setAgendaMenuOpen] = React.useState(false);
          var [speakerMenuTurn, setSpeakerMenuTurn] = React.useState('');
          var [agendaRows, setAgendaRows] = React.useState([]);
          var [rowsDirty, setRowsDirty] = React.useState(false);
          var [forceWizard, setForceWizard] = React.useState(false);
          var [wizardDismissed, setWizardDismissed] = React.useState(false);
          var bodyRef = React.useRef(null);
          var atBottomRef = React.useRef(true);
          var initializedRef = React.useRef(false);
          var activeIdRef = React.useRef('none');
          var settingsWasOpenRef = React.useRef(false);
          var profileAppliedRef = React.useRef('');
          var scriptPromptRef = React.useRef('');
          var toastTimer = React.useRef(null);
          var sseRef = React.useRef(null);

          var active = snapshot && snapshot.active ? snapshot.active : null;
          var transcript = active && Array.isArray(active.transcript) ? active.transcript : [];
          var turns = active && Array.isArray(active.turns) && active.turns.length > 0
            ? active.turns
            : turnsFromTranscript(transcript);
          var visibleTurns = turns.slice(-80);
          var correctionErrors = transcript.filter(function (line) { return line.correctionStatus === 'error'; }).length;
          // The setup flow opens for a new meeting, and whenever the meeting
          // context is still empty; it must start at step ①, not at whatever
          // scroll offset the transcript had.
          var setupEntries = snapshot && snapshot.agenda && Array.isArray(snapshot.agenda.entries)
            ? snapshot.agenda.entries
            : [];
          var wizardVisible = !active && (forceWizard || (!wizardDismissed && (
            setupEntries.length === 0
            || String(form.topic || '').trim().length === 0
            || !form.role)));

          function notify(message, tone) {
            setToast({ message: message, tone: tone || 'info' });
            if (toastTimer.current) clearTimeout(toastTimer.current);
            toastTimer.current = setTimeout(function () { setToast(null); }, 6500);
          }

          function applyEvent(type, payload) {
            if (type === 'state') {
              setSnapshot(payload);
              setLoadError(null);
              return;
            }
            if (type === 'error') {
              setLoadError(payload && payload.message ? payload.message : '会议出错');
              return;
            }
            if (type === 'warning') {
              notify(payload && payload.message ? payload.message : '发生了一个问题', 'info');
              return;
            }
            if (type === 'recognizing') {
              setRecognizing({ startMs: payload.startMs, endMs: payload.endMs });
              return;
            }
            if (type === 'recognized') {
              setRecognizing(null);
              return;
            }
            if (type === 'script') {
              setSnapshot(function (previous) {
                return previous ? Object.assign({}, previous, { script: payload }) : previous;
              });
              return;
            }
            if (type === 'profile') {
              setSnapshot(function (previous) {
                return previous ? Object.assign({}, previous, { profile: payload }) : previous;
              });
              return;
            }
            setSnapshot(function (previous) {
              if (!previous || !previous.active) return previous;
              var next = Object.assign({}, previous);
              var meeting = Object.assign({}, next.active);
              var transcript = meeting.transcript ? meeting.transcript.slice() : [];
              var answers = meeting.answers ? meeting.answers.slice() : [];
              if (type === 'status') {
                meeting.status = payload.status || meeting.status;
                if (payload.error) meeting.error = payload.error;
                if (payload.startedAt) meeting.startedAt = payload.startedAt;
                if (payload.endedAt) meeting.endedAt = payload.endedAt;
                next.active = meeting;
                return next;
              }
              if (type === 'asr') {
                next.asr = payload;
                meeting.asrState = payload;
                next.active = meeting;
                return next;
              }
              if (type === 'speaker') {
                next.speaker = payload;
                meeting.speakerState = payload;
                if (Array.isArray(payload.speakers)) meeting.speakers = payload.speakers;
                if (payload.error) meeting.speakerError = payload.error;
                next.active = meeting;
                return next;
              }
              if (type === 'agenda') {
                next.agenda = payload;
                next.agendaNow = payload.now;
                if (next.active) meeting.agenda = payload;
                next.active = meeting;
                return next;
              }
              if (type === 'capture') {
                meeting.capture = payload;
                next.active = meeting;
                return next;
              }
              if (type === 'cue') {
                var cueList = Array.isArray(meeting.cues) ? meeting.cues.slice() : [];
                var cueFound = false;
                for (var cq = 0; cq < cueList.length; cq += 1) {
                  if (cueList[cq].key === payload.key) {
                    cueList[cq] = payload;
                    cueFound = true;
                    break;
                  }
                }
                if (!cueFound) cueList.push(payload);
                meeting.cues = cueList;
                meeting.cueState = { status: payload.status, key: payload.key };
                next.active = meeting;
                return next;
              }
              if (type === 'turn') {
                var turnList = Array.isArray(meeting.turns) ? meeting.turns.slice() : [];
                var turnFound = false;
                for (var t = 0; t < turnList.length; t += 1) {
                  if (turnList[t].id === payload.id) {
                    turnList[t] = payload;
                    turnFound = true;
                    break;
                  }
                }
                if (!turnFound) turnList.push(payload);
                meeting.turns = turnList;
                meeting.counts = Object.assign({}, meeting.counts, { turns: turnList.length });
                next.active = meeting;
                return next;
              }
              if (type === 'refine') {
                meeting.refineState = payload;
                next.active = meeting;
                return next;
              }
              if (type === 'line') {
                if (transcript.some(function (line) { return line.id === payload.id; })) return previous;
                transcript.push(payload);
                meeting.transcript = transcript;
                meeting.counts = Object.assign({}, meeting.counts, { lines: transcript.length });
                next.active = meeting;
                return next;
              }
              if (type === 'line-update') {
                var found = false;
                for (var i = 0; i < transcript.length; i += 1) {
                  if (transcript[i].id === payload.id) {
                    transcript[i] = payload;
                    found = true;
                    break;
                  }
                }
                if (!found) transcript.push(payload);
                meeting.transcript = transcript;
                meeting.counts = Object.assign({}, meeting.counts, {
                  lines: transcript.length,
                  corrected: transcript.filter(function (line) { return line.correctionStatus === 'done'; }).length
                });
                next.active = meeting;
                return next;
              }
              if (type === 'summary') {
                meeting.summary = payload;
                next.active = meeting;
                return next;
              }
              if (type === 'answer') {
                var replaced = false;
                for (var a = 0; a < answers.length; a += 1) {
                  if (answers[a].id === payload.id) {
                    answers[a] = payload;
                    replaced = true;
                    break;
                  }
                }
                if (!replaced) answers.push(payload);
                meeting.answers = answers;
                next.active = meeting;
                return next;
              }
              if (type === 'answer-delta') {
                for (var d = 0; d < answers.length; d += 1) {
                  if (answers[d].id === payload.id) {
                    answers[d] = Object.assign({}, answers[d], { text: (answers[d].text || '') + payload.delta });
                    break;
                  }
                }
                meeting.answers = answers;
                next.active = meeting;
                return next;
              }
              if (type === 'settings') {
                next.settings = payload;
                return next;
              }
              return previous;
            });
          }

          React.useEffect(function () {
            var alive = true;
            function loadState() {
              api(API.state).then(function (payload) {
                if (alive) {
                  setSnapshot(payload);
                  setLoadError(null);
                }
              }).catch(function (error) {
                if (alive) setLoadError(error.message);
              });
            }
            loadState();

            function connect() {
              try {
                var source = new EventSource(API.events);
                sseRef.current = source;
                source.onopen = function () { setConnection('open'); };
                source.onerror = function () { setConnection('reconnecting'); };
                ['state', 'status', 'asr', 'speaker', 'agenda', 'turn', 'refine', 'capture', 'line', 'line-update', 'summary', 'answer',
                  'answer-delta', 'settings', 'profile', 'script', 'warning', 'error', 'recognizing', 'recognized'].forEach(function (type) {
                  source.addEventListener(type, function (event) {
                    var payload;
                    try {
                      payload = JSON.parse(event.data);
                    } catch {
                      return;
                    }
                    applyEvent(type, payload);
                  });
                });
              } catch (error) {
                setConnection('error');
              }
            }
            connect();

            var timer = setInterval(function () { setNow(Date.now()); }, 1000);
            return function () {
              alive = false;
              clearInterval(timer);
              if (sseRef.current) {
                try { sseRef.current.close(); } catch { /* already closed */ }
                sseRef.current = null;
              }
              if (toastTimer.current) clearTimeout(toastTimer.current);
            };
          }, []);

          React.useEffect(function () {
            if (!snapshot) return;
            var id = snapshot.active ? snapshot.active.id : 'none';
            if (initializedRef.current && activeIdRef.current === id) return;
            initializedRef.current = true;
            activeIdRef.current = id;
            var saved = readSavedForm();
            var base = snapshot.active ? formFromActive(snapshot.active) : defaultForm(snapshot.settings);
            if (!snapshot.active && saved) base = Object.assign(base, saved);
            setForm(base);
            var agenda = snapshot.active ? snapshot.active.agenda : snapshot.agenda;
            setAgendaDraft(agenda && typeof agenda.text === 'string' ? agenda.text : '');
            setAgendaWarnings(agenda && Array.isArray(agenda.warnings) ? agenda.warnings : []);
          }, [snapshot]);

          // The profile is durable on the Host; mirror it into the panel.  The
          // ref guard keeps a half-typed name from being reverted by unrelated
          // SSE state events (every new transcript line refreshes the snapshot).
          React.useEffect(function () {
            if (!snapshot) return;
            var source = snapshot.profile && typeof snapshot.profile === 'object' ? snapshot.profile : {};
            var next = { userName: source.userName || '', userOrg: source.userOrg || '' };
            var key = next.userName + '\u0000' + next.userOrg + '\u0000' + next.role;
            if (profileAppliedRef.current === key) return;
            profileAppliedRef.current = key;
            setProfile(next);
          }, [snapshot]);

          // Keep the prompt editor in sync with the draft the Host reports,
          // without clobbering what the user is currently typing.
          React.useEffect(function () {
            if (!snapshot || !snapshot.script) return;
            var prompt = typeof snapshot.script.prompt === 'string' ? snapshot.script.prompt : '';
            if (scriptPromptRef.current === prompt) return;
            scriptPromptRef.current = prompt;
            setScriptPrompt(prompt);
          }, [snapshot]);

          React.useEffect(function () {
            if (snapshot) setStore({ status: statusTone(snapshot) });
          }, [snapshot]);

          React.useEffect(function () {
            if (!historyOpen) return;
            setHistoryBusy(true);
            api(API.history).then(function (payload) {
              setHistory(payload.meetings || []);
            }).catch(function (error) {
              notify('读取历史会议失败：' + error.message);
            }).then(function () { setHistoryBusy(false); });
          }, [historyOpen]);

          React.useEffect(function () {
            if (!wizardVisible || !bodyRef.current) return;
            bodyRef.current.scrollTop = 0;
            atBottomRef.current = false;
            setFollowing(false);
          }, [wizardVisible]);

          React.useEffect(function () {
            if (wizardVisible) return;
            if (tab !== 'transcript' || showSettings || !bodyRef.current || !atBottomRef.current) return;
            bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
            setFollowing(true);
          }, [tab, showSettings, wizardVisible, turns.length, turns.length > 0 ? turns[turns.length - 1].text : '', recognizing]);

          React.useEffect(function () {
            if (tab !== 'qa' || showSettings || !bodyRef.current || !atBottomRef.current) return;
            bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
          }, [tab, showSettings, active ? active.answers.length : 0, active ? (active.answers[active.answers.length - 1] || {}).text : '']);

          React.useEffect(function () {
            var wasOpen = settingsWasOpenRef.current;
            settingsWasOpenRef.current = showSettings;
            if (!bodyRef.current) return;
            if (showSettings) {
              bodyRef.current.scrollTop = 0;
              atBottomRef.current = false;
              setFollowing(false);
            } else if (wasOpen) {
              bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
              atBottomRef.current = true;
              setFollowing(true);
            }
          }, [showSettings]);

          function onScroll() {
            if (!bodyRef.current) return;
            var node = bodyRef.current;
            var bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            atBottomRef.current = bottom;
            setFollowing(bottom);
          }

          function scrollToBottom() {
            if (!bodyRef.current) return;
            bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
            atBottomRef.current = true;
            setFollowing(true);
          }

          function update(field, value) {
            setForm(function (current) {
              var next = Object.assign({}, current);
              next[field] = value;
              return next;
            });
          }

          function startMeeting() {
            if (busy) return;
            setBusy('start');
            setLoadError(null);
            saveForm(form);
            api(API.start, Object.assign({}, form, { agendaText: agendaDraft, agendaFilename: agendaFilename })).then(function (payload) {
              if (payload.state) setSnapshot(payload.state);
              setTab('transcript');
              setStore({ tab: 'transcript' });
            }).catch(function (error) {
              setLoadError(error.message);
            }).then(function () { setBusy(''); });
          }

          function stopMeeting() {
            if (busy) return;
            setBusy('stop');
            setLoadError(null);
            api(API.stop, {}).then(function (payload) {
              if (payload.state) setSnapshot(payload.state);
            }).catch(function (error) {
              setLoadError(error.message);
            }).then(function () { setBusy(''); });
          }

          function applyLiveSettings() {
            if (busy) return;
            setBusy('settings');
            api(API.settings, form).then(function (payload) {
              if (payload.state) setSnapshot(payload.state);
              notify('会议设置已更新，新识别的内容会使用新设置');
              saveForm(form);
            }).catch(function (error) {
              notify('保存设置失败：' + error.message);
            }).then(function () { setBusy(''); });
          }

          function prepareModel() {
            api(API.prepare, {}).then(function () {
              notify('已开始准备本地语音模型，下载进度会显示在这里');
            }).catch(function (error) {
              notify('准备语音模型失败：' + error.message);
            });
          }

          function renameSpeaker(id, value, org) {
            var name = String(value || '').trim();
            if (name.length === 0) return;
            api(API.speaker, { id: id, name: name, org: org === undefined ? '' : org }).then(function (payload) {
              if (payload.state) setSnapshot(payload.state);
            }).catch(function (error) {
              notify('重命名发言人失败：' + error.message);
            });
          }

          // Agenda items shift all the time: click the bar and pick the item
          // that is actually being discussed.
          function pinAgenda(index) {
            api(API.agendaCurrent, { index: index }).then(function (payload) {
              if (payload.state) setSnapshot(payload.state);
              setAgendaMenuOpen(false);
              notify(index === null ? '已恢复按时间自动判断当前日程' : '已手动指定当前日程');
            }).catch(function (error) {
              notify('切换当前日程失败：' + error.message);
            });
          }

          // Same for speakers: click a name and pick the right person.
          function pickTurnSpeaker(turnId, speakerId) {
            api(API.turnSpeaker, { turnId: turnId, speakerId: speakerId }).then(function (payload) {
              if (payload.state) setSnapshot(payload.state);
              setSpeakerMenuTurn('');
            }).catch(function (error) {
              notify('指定讲者失败：' + error.message);
            });
          }

          // Pick a name from the agenda roster, or a name + organization typed
          // in the same menu.
          function pickTurnPerson(turnId, name, org) {
            api(API.turnSpeaker, { turnId: turnId, name: name, org: org || '' }).then(function (payload) {
              if (payload.state) setSnapshot(payload.state);
              setSpeakerMenuTurn('');
              notify('已指定发言人：' + name);
            }).catch(function (error) {
              notify('指定发言人失败：' + error.message);
            });
          }

          function startNewMeeting() {
            api(API.newMeeting, {}).then(function (payload) {
              if (payload.state) setSnapshot(payload.state);
              setRowsDirty(false);
              setSpeakerMenuTurn('');
              // A new meeting always starts with the setup flow.
              setWizardDismissed(false);
              setForceWizard(true);
              switchTab('transcript');
              notify('已回到会议准备状态');
            }).catch(function (error) {
              notify('新会议失败：' + error.message);
            });
          }

          function saveProfile() {
            api(API.profile, {
              userName: profile.userName,
              userOrg: profile.userOrg,
              domain: form.domain,
              customDomain: form.customDomain
            }).then(function (payload) {
              if (payload.state) setSnapshot(payload.state);
              var script = payload.state && payload.state.script;
              if (script && script.status === 'writing') {
                notify('我的姓名已保存，正在生成我的讲词与串词');
              } else if (!profile.userName.trim()) {
                notify('已清空我的姓名');
              } else {
                notify('我的姓名已保存；日程里出现你的名字时才会生成讲词');
              }
            }).catch(function (error) {
              notify('保存我的信息失败：' + error.message);
            });
          }

          function requestCue(index) {
            api(API.cue, { index: index }).then(function (payload) {
              if (payload.state) setSnapshot(payload.state);
              notify('正在按当前进度生成串词…');
            }).catch(function (error) {
              notify('生成串词失败：' + error.message);
            });
          }

          function regenerateScripts() {
            api(API.script, { prompt: scriptPrompt }).then(function (payload) {
              if (payload.state) setSnapshot(payload.state);
              notify('正在生成我的讲词与串词…');
            }).catch(function (error) {
              notify('生成讲词失败：' + error.message);
            });
          }

          function applyAgenda(text, filename) {
            var value = text === undefined ? agendaDraft : text;
            if (!value || !String(value).trim()) {
              notify('日程是空的');
              return;
            }
            setAgendaBusy(true);
            api(API.agenda, {
              text: value,
              filename: filename || agendaFilename,
              requireLlm: Boolean(agendaSource) || /\.(pdf|docx?|pptx?|xlsx?|od[tsp]|png|jpe?g|webp|bmp|tiff?)$/i.test(filename || agendaFilename || ''),
              source: agendaSource
            }).then(function (payload) {
              if (payload.state) setSnapshot(payload.state);
              var agenda = payload.agenda || (payload.state && payload.state.agenda);
              setAgendaWarnings(agenda && Array.isArray(agenda.warnings) ? agenda.warnings : []);
              var entries = agenda && Array.isArray(agenda.entries) ? agenda.entries : [];
              var savedName = payload.state && payload.state.profile ? payload.state.profile.userName : profile.userName;
              notify('日程已用 AI 解析：' + entries.length + ' 条' +
                (agendaMatchesUser(entries, savedName) ? '，正在生成我的讲词与串词' : ''));
              setAgendaSource('');
            }).catch(function (error) {
              notify('AI 解析日程失败：' + error.message);
            }).then(function () { setAgendaBusy(false); });
          }

          // Uploading only reads the file into the draft.  Nothing is parsed
          // until the user clicks 应用日程, and then the model does the parsing.
          function loadAgendaAttachment(dataUrl, filename) {
            setAgendaBusy(true);
            api(API.agendaFile, { fileBase64: dataUrl, filename: filename }).then(function (payload) {
              if (typeof payload.text === 'string') setAgendaDraft(payload.text);
              setAgendaFilename(filename);
              setAgendaSource(payload.kind === 'image' ? 'image' : 'file');
              setAgendaWarnings([]);
              notify(payload.images > 0
                ? '已载入日程文字（另附 ' + payload.images + ' 页截图给 AI 看），点「应用日程」解析'
                : '已载入日程文字，点「应用日程」用 AI 解析');
            }).catch(function (error) {
              notify('读取日程文件失败：' + error.message);
            }).then(function () { setAgendaBusy(false); });
          }

          function applyAgendaFile(file) {
            if (!file) return;
            var name = file.name || '';
            var type = file.type || '';
            var textLike = /^text\//i.test(type) || /\.(txt|md|markdown|csv|json)$/i.test(name);
            if (!textLike) {
              if (file.size > 20 * 1024 * 1024) {
                notify('日程文件太大（上限 20MB）');
                return;
              }
              var attachmentReader = new FileReader();
              attachmentReader.onload = function () {
                loadAgendaAttachment(String(attachmentReader.result || ''), name);
              };
              attachmentReader.onerror = function () { notify('读取日程文件失败'); };
              attachmentReader.readAsDataURL(file);
              return;
            }
            if (file.size > 40000) {
              notify('文本日程太大（上限 40KB）；PDF/Word/PPT 等请直接上传文件');
              return;
            }
            var reader = new FileReader();
            reader.onload = function () {
              var text = String(reader.result || '');
              setAgendaDraft(text);
              setAgendaFilename(name);
              setAgendaSource('file');
              setAgendaWarnings([]);
              notify('已载入日程文字，点「应用日程」用 AI 解析');
            };
            reader.onerror = function () { notify('读取日程文件失败'); };
            reader.readAsText(file, 'utf-8');
          }

          // The model fills the meeting context (topic / domain / role) from the
          // agenda; mirror it into the editable form without clobbering what the
          // user already typed.
          React.useEffect(function () {
            if (!snapshot || !snapshot.settings) return;
            var settings = snapshot.settings;
            setForm(function (current) {
              var next = Object.assign({}, current);
              var changed = false;
              if (!String(current.topic || '').trim() && typeof settings.topic === 'string' && settings.topic.trim()) {
                next.topic = settings.topic;
                changed = true;
              }
              if (!current.role && typeof settings.role === 'string' && settings.role) {
                next.role = settings.role;
                changed = true;
              }
              return changed ? next : current;
            });
          }, [snapshot && snapshot.settings
            ? String(snapshot.settings.role || '') + '|' + String(snapshot.settings.topic || '')
            : '']);

          // Keep the editable agenda table in sync with the Host, unless the
          // user is in the middle of editing it.
          React.useEffect(function () {
            if (!snapshot || rowsDirty) return;
            var source = snapshot.active ? snapshot.active.agenda : snapshot.agenda;
            setAgendaRows(rowsFromEntries(source && source.entries));
          }, [snapshot && (snapshot.active ? snapshot.active.agenda : snapshot.agenda)
            ? (snapshot.active ? snapshot.active.agenda : snapshot.agenda).updatedAt
            : 0, rowsDirty]);

          function updateRow(index, field, value) {
            setAgendaRows(function (current) {
              var next = current.slice();
              next[index] = Object.assign({}, next[index]);
              next[index][field] = value;
              return next;
            });
            setRowsDirty(true);
          }

          function saveAgendaRows() {
            var entries = entriesFromRows(agendaRows);
            if (entries.length === 0) {
              notify('日程至少要有一条（时间或主题）');
              return;
            }
            setAgendaBusy(true);
            api(API.agendaEntries, {
              entries: entries,
              topic: form.topic,
              domain: form.domain,
              customDomain: form.customDomain,
              role: form.role,
              text: agendaDraft
            }).then(function (payload) {
              if (payload.state) setSnapshot(payload.state);
              setRowsDirty(false);
              notify('日程已保存（' + entries.length + ' 条）');
            }).catch(function (error) {
              notify('保存日程失败：' + error.message);
            }).then(function () { setAgendaBusy(false); });
          }

          function renderAgendaTable() {
            return h('div', { className: 'dshm-table' },
              h('div', { className: 'dshm-tableRow dshm-tableHead' },
                h('span', null, '开始'),
                h('span', null, '结束'),
                h('span', null, '讲者'),
                h('span', null, '单位'),
                h('span', null, '')),
              agendaRows.map(function (row, index) {
                return h('div', { key: 'agendaRow' + index, className: 'dshm-tableRow' },
                  h('input', {
                    className: 'dshm-input dshm-timeInput', value: row.start, placeholder: '14:00',
                    onChange: function (event) { updateRow(index, 'start', event.target.value); }
                  }),
                  h('input', {
                    className: 'dshm-input dshm-timeInput', value: row.end, placeholder: '14:30',
                    onChange: function (event) { updateRow(index, 'end', event.target.value); }
                  }),
                  h('input', {
                    className: 'dshm-input', value: row.speaker, placeholder: '姓名',
                    onChange: function (event) { updateRow(index, 'speaker', event.target.value); }
                  }),
                  h('input', {
                    className: 'dshm-input', value: row.org, placeholder: '单位',
                    onChange: function (event) { updateRow(index, 'org', event.target.value); }
                  }),
                  h('button', {
                    type: 'button', className: 'dshm-iconBtn', title: '删除这一行',
                    onClick: function () {
                      setAgendaRows(function (current) {
                        return current.filter(function (_, i) { return i !== index; });
                      });
                      setRowsDirty(true);
                    }
                  }, '✕'),
                  h('input', {
                    className: 'dshm-input', value: row.topic, placeholder: '主题 / 环节',
                    style: { gridColumn: '1 / span 5' },
                    onChange: function (event) { updateRow(index, 'topic', event.target.value); }
                  }));
              }),
              h('div', { className: 'dshm-row', style: { marginTop: '6px' } },
                h('button', {
                  type: 'button', className: 'dshm-btn', 'data-kind': 'ghost',
                  onClick: function () {
                    setAgendaRows(function (current) {
                      return current.concat([{ start: '', end: '', speaker: '', org: '', topic: '' }]);
                    });
                    setRowsDirty(true);
                  }
                }, '＋ 添加一行'),
                h('button', {
                  type: 'button', className: 'dshm-btn', 'data-kind': 'primary',
                  disabled: agendaBusy, onClick: saveAgendaRows
                }, agendaBusy ? '保存中…' : '保存日程'),
                rowsDirty ? h('span', { className: 'dshm-muted' }, '有未保存的修改') : null)
            );
          }

          function onAgendaFile(event) {
            var file = event.target.files && event.target.files[0];
            event.target.value = '';
            applyAgendaFile(file);
          }

          function onAgendaDrop(event) {
            event.preventDefault();
            event.stopPropagation();
            setDragOver(false);
            var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
            applyAgendaFile(file);
          }

          // The DSH chat window also listens for file drops, so the whole panel
          // claims the drag: without stopPropagation a file dragged onto the
          // meeting panel ends up attached to the conversation instead.
          function onPanelDragOver(event) {
            if (!event.dataTransfer) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
            setDragOver(true);
          }

          function onPanelDragEnter(event) {
            if (!event.dataTransfer) return;
            event.preventDefault();
            event.stopPropagation();
            setDragOver(true);
          }

          function onPanelDragLeave(event) {
            event.stopPropagation();
            var next = event.relatedTarget;
            if (next && event.currentTarget && event.currentTarget.contains(next)) return;
            setDragOver(false);
          }

          function onPanelDrop(event) {
            event.preventDefault();
            event.stopPropagation();
            setDragOver(false);
            var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
            if (file) applyAgendaFile(file);
          }

          // Paste an agenda: a screenshot *or* a copied file (PDF / Word / PPT /
          // Excel / txt). Images are files too, so one branch covers both.
          function onAgendaPaste(event) {
            var data = event.clipboardData;
            if (!data) return;
            var files = [];
            var items = data.items ? data.items : [];
            for (var i = 0; i < items.length; i += 1) {
              var item = items[i];
              if (!item || item.kind !== 'file') continue;
              var picked = item.getAsFile ? item.getAsFile() : null;
              if (picked) files.push(picked);
            }
            if (files.length === 0 && data.files && data.files.length > 0) {
              files = Array.prototype.slice.call(data.files);
            }
            // A plain text paste must reach the textarea untouched.
            if (files.length === 0) return;
            event.preventDefault();
            applyAgendaFile(files[0]);
            if (files.length > 1) notify('一次只能解析一个日程文件，已使用：' + (files[0].name || '剪贴板文件'));
          }

          function refreshDevices() {
            Promise.all([
              api(API.devices),
              api(API.devices + '?source=mic')
            ]).then(function (results) {
              setDevices(results[0].devices || []);
              setMicDevices(results[1].devices || []);
            }).catch(function (error) {
              notify('读取音频设备失败：' + error.message);
            });
          }

          function sendQuestion(text) {
            var value = (text === undefined ? question : text).trim();
            if (value.length === 0 || busy === 'ask') return;
            setBusy('ask');
            api(API.ask, { question: value, webSearch: form.webSearch }).then(function () {
              setQuestion('');
              setTab('qa');
              setStore({ tab: 'qa' });
            }).catch(function (error) {
              notify('提问失败：' + error.message);
            }).then(function () { setBusy(''); });
          }

          function regenerateSummary() {
            api(API.summary, {}).then(function () {
              notify('正在重新生成会议纪要');
            }).catch(function (error) {
              notify('重新生成失败：' + error.message);
            });
          }

          function retryCorrections() {
            api(API.retryCorrection, {}).then(function (payload) {
              notify('已重新排队 ' + payload.retried + ' 行校正');
            }).catch(function (error) {
              notify('重试失败：' + error.message);
            });
          }

          function loadHistory(id) {
            api(API.load, { id: id }).then(function (payload) {
              if (payload.state) setSnapshot(payload.state);
              setHistoryOpen(false);
              setTab('summary');
              setStore({ tab: 'summary' });
            }).catch(function (error) {
              notify('读取历史会议失败：' + error.message);
            });
          }

          function switchTab(nextTab) {
            setTab(nextTab);
            setStore({ tab: nextTab });
            atBottomRef.current = true;
          }

          var status = statusInfo(active, snapshot && snapshot.asr, busy);
          var startedAt = active && active.startedAt ? active.startedAt : 0;
          var elapsed = startedAt ? Math.max(0, (active.endedAt || now) - startedAt) : 0;
          var answers = active && Array.isArray(active.answers) ? active.answers : [];
          var isLive = active && !active.readOnly && ['preparing', 'capturing', 'listening', 'stopping'].indexOf(active.status) >= 0;
          var canStart = !isLive && busy !== 'start';
          var asr = snapshot && snapshot.asr ? snapshot.asr : null;
          var services = snapshot && snapshot.services ? snapshot.services : {};
          var progress = prepareProgress(asr);
          var agenda = snapshot ? (snapshot.active ? snapshot.active.agenda : snapshot.agenda) : null;
          var agendaEntries = agenda && Array.isArray(agenda.entries) ? agenda.entries : [];
          var participantRoster = (function () {
            var seen = {};
            var list = [];
            agendaEntries.forEach(function (entry) {
              var name = String((entry && entry.speaker) || '').trim();
              if (!name) return;
              var key = normalizePersonName(name);
              if (seen[key]) return;
              seen[key] = true;
              list.push({ name: name, org: String((entry && entry.org) || '').trim() });
            });
            return list;
          })();
          var agendaCurrent = currentAgendaClient(agendaEntries);

          if (!snapshot) {
            return h('div', { className: 'dshm-panel' },
              h('div', { className: 'dshm-head' },
                h('div', { className: 'dshm-titleRow' },
                  h('span', { className: 'dshm-dot', 'data-tone': 'busy' }),
                  h('div', null,
                    h('div', { className: 'dshm-title' }, '会议助手'),
                    h('div', { className: 'dshm-sub' }, '连接会议服务…')
                  ),
                  h('div', { className: 'dshm-headActions' },
                    h('button', { type: 'button', className: 'dshm-iconBtn', title: '关闭', onClick: function () { setStore({ open: false }); } }, '✕')
                  )
                )
              ),
              h('div', { className: 'dshm-empty' }, h('span', { className: 'dshm-spinner' }), h('div', { className: 'dshm-muted' }, '正在读取会议状态…'))
            );
          }

          return h('div', {
            className: 'dshm-panel',
            role: 'dialog',
            'aria-label': '会议助手',
            'data-drag': dragOver ? 'true' : 'false',
            onDragOver: onPanelDragOver,
            onDragEnter: onPanelDragEnter,
            onDragLeave: onPanelDragLeave,
            onDrop: onPanelDrop
          },
            dragOver
              ? h('div', { className: 'dshm-dropOverlay' }, '松开以载入日程文件（或点「上传 / 拖入日程」）')
              : null,
            h('div', { className: 'dshm-head' },
              h('div', { className: 'dshm-titleRow' },
                h('span', { className: 'dshm-dot', 'data-tone': status.tone }),
                h('div', null,
                  h('div', { className: 'dshm-title' }, '会议助手'),
                  h('div', { className: 'dshm-sub' }, status.text)
                ),
                h('div', { className: 'dshm-headActions' },
                  h('button', {
                    type: 'button', className: 'dshm-iconBtn', title: '历史会议',
                    'data-on': historyOpen ? 'true' : 'false',
                    onClick: function () { setHistoryOpen(!historyOpen); }
                  }, '☰'),
                  h('button', {
                    type: 'button', className: 'dshm-iconBtn', title: '会议设置',
                    'data-on': showSettings ? 'true' : 'false',
                    onClick: function () { setShowSettings(!showSettings); if (!devices.length) refreshDevices(); }
                  }, '⚙'),
                  h('button', {
                    type: 'button', className: 'dshm-iconBtn', title: '关闭',
                    onClick: function () { setStore({ open: false }); }
                  }, '✕')
                )
              ),
              h('div', { className: 'dshm-bar' },
                isLive
                  ? h('button', {
                    type: 'button', className: 'dshm-btn', 'data-kind': 'danger', disabled: busy === 'stop',
                    onClick: stopMeeting
                  }, busy === 'stop' ? h('span', null, h('span', { className: 'dshm-spinner' }), ' 收尾中…') : '结束会议')
                  : h('button', {
                    type: 'button', className: 'dshm-btn', 'data-kind': 'primary', disabled: !canStart,
                    onClick: startMeeting
                  }, busy === 'start' ? h('span', null, h('span', { className: 'dshm-spinner' }), ' 开始中…') : '开始听会'),
                active && (active.readOnly || active.status === 'ended')
                  ? h('button', { type: 'button', className: 'dshm-btn', 'data-kind': 'ghost', onClick: startNewMeeting }, '新会议')
                  : null,
                h('span', { className: 'dshm-timer' }, startedAt ? formatClock(elapsed) : '')
              )
            ),

            h('div', { className: 'dshm-tabs' },
              h('button', {
                type: 'button', className: 'dshm-tab', 'data-on': tab === 'transcript' ? 'true' : 'false',
                onClick: function () { switchTab('transcript'); }
              }, '实时转写', turns.length > 0 ? h('span', { className: 'dshm-badge' }, String(turns.length)) : null),
              h('button', {
                type: 'button', className: 'dshm-tab', 'data-on': tab === 'summary' ? 'true' : 'false',
                onClick: function () { switchTab('summary'); }
              }, '会议纪要', active && active.summary && active.summary.status === 'summarizing' ? h('span', { className: 'dshm-spinner' }) : null),
              h('button', {
                type: 'button', className: 'dshm-tab', 'data-on': tab === 'qa' ? 'true' : 'false',
                onClick: function () { switchTab('qa'); }
              }, '提问', answers.length > 0 ? h('span', { className: 'dshm-badge' }, String(answers.length)) : null),
              h('button', {
                type: 'button', className: 'dshm-tab', 'data-on': tab === 'script' ? 'true' : 'false',
                onClick: function () { switchTab('script'); }
              }, '讲词串词', snapshot && snapshot.script && snapshot.script.status === 'writing'
                ? h('span', { className: 'dshm-spinner' }) : null)
            ),

            agendaEntries.length > 0
              ? h('div', { className: 'dshm-agendaBarWrap' },
                h('div', {
                  className: 'dshm-agendaBar',
                  'data-status': agendaCurrent.status,
                  role: 'button',
                  title: '点击切换当前日程',
                  onClick: function () { setAgendaMenuOpen(!agendaMenuOpen); }
                },
                h('span', { className: 'dshm-agendaNow' }, agendaCurrent.status === 'pinned'
                  ? '当前日程（手动）'
                  : agendaCurrent.status === 'current' ? '当前日程'
                    : agendaCurrent.status === 'next' ? '下一项' : '已结束'),
                h('span', { className: 'dshm-agendaText' }, agendaCurrent.entry
                  ? agendaEntryText(agendaCurrent.entry)
                  : '点击选择当前日程'),
                h('span', { className: 'dshm-agendaClock' }, agendaCurrent.clock || '')),
                agendaMenuOpen
                  ? h('div', { className: 'dshm-menu' },
                    h('button', {
                      key: 'auto', type: 'button', className: 'dshm-menuItem',
                      'data-current': agendaCurrent.status !== 'pinned' ? 'true' : 'false',
                      onClick: function () { pinAgenda(null); }
                    }, '按时间自动判断'),
                    agendaEntries.slice(0, 60).map(function (entry, index) {
                      return h('button', {
                        key: 'e' + index, type: 'button', className: 'dshm-menuItem',
                        'data-current': agendaCurrent.entry === entry ? 'true' : 'false',
                        onClick: function () { pinAgenda(index); }
                      }, (entry.startMin !== null && entry.startMin !== undefined ? clockMin(entry.startMin) + ' · ' : '') + agendaEntryText(entry));
                    }))
                  : null)
              : null,

            h('div', { className: 'dshm-body', ref: bodyRef, onScroll: onScroll },
              loadError ? h('div', { className: 'dshm-section' }, h('div', { className: 'dshm-error' }, loadError)) : null,
              showSettings ? renderSettings() : null,
              tab === 'transcript' ? renderTranscript() : null,
              tab === 'summary' ? renderSummary() : null,
              tab === 'qa' ? renderQa() : null,
              tab === 'script' ? renderScripts() : null
            ),

            h('div', { className: 'dshm-foot' },
              h('span', null, asr ? phaseText(asr) : '语音状态未知'),
              h('span', null, '·'),
              h('span', null, services.model ? (services.model.provider + ' / ' + services.model.model) : '未配置默认模型'),
              h('span', { className: 'dshm-spacer' }),
              h('span', null, connection === 'open' ? '已连接' : connection === 'reconnecting' ? '重连中…' : '连接中…')
            ),

            historyOpen ? renderHistory() : null,
            toast ? h('div', { className: 'dshm-toast', 'data-tone': toast.tone }, toast.message) : null
          );

          function renderWizard() {
            var cues = snapshot && Array.isArray(snapshot.cues) ? snapshot.cues : [];
            var cueKindLabel = {
              opening: '开场致辞', transition: '环节交接', closing: '结束致辞', thanks: '上场感谢', manual: '即时串词'
            };
            return h('div', { className: 'dshm-section' },
              h('div', { className: 'dshm-card' },
                h('div', { className: 'dshm-cardTitle' }, '① 我是谁'),
                h('div', { className: 'dshm-grid' },
                  field('我的姓名', h('input', {
                    className: 'dshm-input', value: profile.userName, placeholder: '例如：张医生',
                    onChange: function (event) { setProfile(Object.assign({}, profile, { userName: event.target.value })); }
                  })),
                  field('我的单位', h('input', {
                    className: 'dshm-input', value: profile.userOrg, placeholder: '例如：市医院',
                    onChange: function (event) { setProfile(Object.assign({}, profile, { userOrg: event.target.value })); }
                  }))),
                h('div', { className: 'dshm-row', style: { marginTop: '8px' } },
                  h('button', { type: 'button', className: 'dshm-btn', 'data-kind': 'primary', onClick: saveProfile }, '保存我的信息'))),
                h('div', { className: 'dshm-row', style: { marginTop: '8px' } },
                  h('button', { type: 'button', className: 'dshm-btn', 'data-kind': 'primary', onClick: saveProfile }, '保存我的信息'))),
              h('div', {
                className: 'dshm-card', 'data-drag': dragOver ? 'true' : 'false',
                onDragOver: function (event) { event.preventDefault(); setDragOver(true); },
                onDragEnter: function (event) { event.preventDefault(); setDragOver(true); },
                onDragLeave: function (event) { event.preventDefault(); setDragOver(false); },
                onDrop: onAgendaDrop
              },
                h('div', { className: 'dshm-cardTitle' }, '② 导入会议日程'),
                h('p', { className: 'dshm-muted' }, '支持 txt / md / csv / json、PDF / Word / PPT / Excel 和截图。也可以直接粘贴日程文字，或把截图/文件粘贴到框里（Ctrl+V）。'),
                h('div', { className: 'dshm-row' },
                  h('label', { className: 'dshm-btn', 'data-kind': 'small', style: { cursor: 'pointer' } },
                    '上传 / 拖入日程',
                    h('input', {
                      type: 'file',
                      accept: '.txt,.md,.markdown,.csv,.json,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.odp,.ods,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,text/plain,text/csv,application/json,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,image/*',
                      style: { display: 'none' }, onChange: onAgendaFile
                    })),
                  h('button', {
                    type: 'button', className: 'dshm-btn', 'data-kind': 'primary',
                    disabled: agendaBusy || agendaDraft.trim().length === 0,
                    onClick: function () { applyAgenda(agendaDraft, agendaFilename); }
                  }, agendaBusy ? h('span', null, h('span', { className: 'dshm-spinner' }), ' AI 解析中…') : '应用日程（AI 解析）'),
                  agendaSource ? h('span', { className: 'dshm-pill', 'data-tone': 'busy' }, '已载入，待解析') : null,
                  snapshot && snapshot.agenda && snapshot.agenda.parsedBy === 'llm'
                    ? h('span', { className: 'dshm-pill', 'data-tone': 'good' }, 'AI 已解析')
                    : null),
                h('textarea', {
                  className: 'dshm-textarea', rows: 3, value: agendaDraft, style: { marginTop: '7px' },
                  placeholder: '14:00-14:30 张医生（市医院） 创面修复病例分享\n14:30-15:00 李主任（省医院）：糖尿病足多学科协作',
                  onChange: function (event) { setAgendaDraft(event.target.value); setAgendaFilename(''); setAgendaSource(''); },
                  onPaste: onAgendaPaste
                }),
                agendaWarnings.length > 0
                  ? h('div', { className: 'dshm-warning', style: { marginTop: '6px' } }, agendaWarnings.join('；'))
                  : null),
              h('div', { className: 'dshm-card' },
                h('div', { className: 'dshm-cardTitle' }, '③ 确认会议信息'),
                h('div', { className: 'dshm-grid' },
                  field('会议主题', h('input', {
                    className: 'dshm-input', value: form.topic, placeholder: '会议主题',
                    onChange: function (event) { update('topic', event.target.value); }
                  })),
                  field('会议领域', h('select', {
                    className: 'dshm-select', value: form.domain,
                    onChange: function (event) { update('domain', event.target.value); }
                  }, DOMAINS.map(function (item) { return h('option', { key: item.id, value: item.id }, item.label); }))),
                  field('我在会议中的角色', h('select', {
                    className: 'dshm-select', value: form.role,
                    onChange: function (event) { update('role', event.target.value); }
                  }, ROLES.map(function (item) { return h('option', { key: item.id, value: item.id }, item.label); }))),
                renderAgendaTable(),
                h('label', { className: 'dshm-check', style: { marginTop: '8px' } },
                  h('input', {
                    type: 'checkbox', checked: form.micEnabled !== false,
                    onChange: function (event) { update('micEnabled', event.target.checked); if (!micDevices.length) refreshDevices(); }
                  }),
                  '同时采集我的麦克风（默认开启，我的发言标为「自己」）'),
                h('div', { className: 'dshm-row', style: { marginTop: '8px' } },
                  h('button', {
                    type: 'button', className: 'dshm-btn', 'data-kind': 'primary',
                    onClick: function () {
                      // The role and the meeting context live on the Host's
                      // settings for this session; persist them before leaving.
                      api(API.settings, form).then(function (payload) {
                        if (payload.state) setSnapshot(payload.state);
                        setForceWizard(false);
                        setWizardDismissed(true);
                        notify('初始化完成，可以开始听会了');
                      }).catch(function (error) {
                        setForceWizard(false);
                        setWizardDismissed(true);
                        notify('保存会议上下文失败：' + error.message);
                      });
                    }
                  }, '完成初始化'),
                  h('button', {
                    type: 'button', className: 'dshm-btn', 'data-kind': 'ghost',
                    onClick: function () {
                      setForceWizard(false);
                      setWizardDismissed(true);
                    }
                  }, '跳过'))),
              cues.length > 0
                ? h('div', { className: 'dshm-card' },
                  h('div', { className: 'dshm-cardTitle' }, '为你生成的串词'),
                  cues.map(function (cue) {
                    return h('div', { key: cue.key, className: 'dshm-cue' },
                      h('div', { className: 'dshm-row' },
                        h('span', {
                          className: 'dshm-pill',
                          'data-tone': cue.status === 'done' ? 'good' : 'busy'
                        }, cueKindLabel[cue.kind] || '串词'),
                        h('span', { className: 'dshm-muted' }, cue.entryText || '')),
                      cue.status === 'writing'
                        ? h('p', { className: 'dshm-muted' }, h('span', { className: 'dshm-spinner' }), ' 正在生成…')
                        : cue.status === 'error'
                          ? h('div', { className: 'dshm-warning' }, cue.error || '生成失败')
                          : h('p', { className: 'dshm-cueText' }, cue.markdown));
                  }))
                : null
            );
          }

          function renderSettings() {
            return h('div', { className: 'dshm-section' },
              h('div', { className: 'dshm-card' },
                h('div', { className: 'dshm-cardTitle' }, '我的信息'),
                h('p', { className: 'dshm-muted' }, '填写姓名后，只有当日程里出现你的名字时，插件才会为你生成「讲词」和「串词」；不会替别人写稿。'),
                h('div', { className: 'dshm-grid' },
                  field('我的姓名', h('input', {
                    className: 'dshm-input', value: profile.userName, placeholder: '例如：张医生',
                    onChange: function (event) { setProfile(Object.assign({}, profile, { userName: event.target.value })); }
                  })),
                  field('我的单位', h('input', {
                    className: 'dshm-input', value: profile.userOrg, placeholder: '例如：市医院',
                    onChange: function (event) { setProfile(Object.assign({}, profile, { userOrg: event.target.value })); }
                  }))
                ),
                h('div', { className: 'dshm-row', style: { marginTop: '8px' } },
                  h('button', { type: 'button', className: 'dshm-btn', 'data-kind': 'primary', onClick: saveProfile }, '保存我的信息'),
                  (function () {
                    var saved = snapshot && snapshot.profile && snapshot.profile.userName ? snapshot.profile.userName : '';
                    return [
                      h('span', { key: 'saved', className: 'dshm-pill', 'data-tone': saved ? 'good' : 'bad' },
                        saved ? '已保存：' + saved : '未设置姓名'),
                      profile.userName.trim() !== saved
                        ? h('span', { key: 'dirty', className: 'dshm-muted' }, '（有未保存的修改）')
                        : null
                    ];
                  })()
                )
              ),
              h('div', { className: 'dshm-card' },
                h('div', { className: 'dshm-cardTitle' }, '会议上下文'),
                h('div', { className: 'dshm-grid' },
                  field('会议主题', h('input', {
                    className: 'dshm-input', value: form.topic, placeholder: '例如：2026 Q3 产品路线图评审',
                    onChange: function (event) { update('topic', event.target.value); }
                  })),
                  field('会议领域', h('select', {
                    className: 'dshm-select', value: form.domain,
                    onChange: function (event) { update('domain', event.target.value); }
                  }, DOMAINS.map(function (item) { return h('option', { key: item.id, value: item.id }, item.label); }))),
                  field('我在会议中的角色', h('select', {
                    className: 'dshm-select', value: form.role,
                    onChange: function (event) { update('role', event.target.value); }
                  }, ROLES.map(function (item) { return h('option', { key: item.id, value: item.id }, item.label); }))),
                  form.domain === 'custom'
                    ? field('自定义领域', h('input', {
                      className: 'dshm-input', value: form.customDomain, placeholder: '例如：半导体设备',
                      onChange: function (event) { update('customDomain', event.target.value); }
                    }))
                    : null,
                  field('会议标题', h('input', {
                    className: 'dshm-input', value: form.title, placeholder: '留空自动使用日期',
                    onChange: function (event) { update('title', event.target.value); }
                  })),
                  field('翻译目标', h('select', {
                    className: 'dshm-select', value: form.targetLang,
                    onChange: function (event) { update('targetLang', event.target.value); }
                  }, TARGETS.map(function (item) { return h('option', { key: item.id, value: item.id }, item.label); }))),
                  field('识别语言', h('select', {
                    className: 'dshm-select', value: form.asrLang,
                    onChange: function (event) { update('asrLang', event.target.value); }
                  }, ASR_LANGS.map(function (item) { return h('option', { key: item.id, value: item.id }, item.label); }))),
                  field('纪要语言', h('select', {
                    className: 'dshm-select', value: form.summaryLang,
                    onChange: function (event) { update('summaryLang', event.target.value); }
                  }, SUMMARY_LANGS.map(function (item) { return h('option', { key: item.id, value: item.id }, item.label); }))),
                  field('采集设备', h('select', {
                    className: 'dshm-select', value: form.deviceId,
                    onChange: function (event) { update('deviceId', event.target.value); }
                  }, [h('option', { key: 'default', value: '' }, '系统默认播放设备')].concat(devices.map(function (device) {
                    return h('option', { key: device.id, value: device.id }, device.name);
                  }))))
                ),
                h('div', { style: { marginTop: '8px' } },
                  h('label', { className: 'dshm-check' },
                    h('input', { type: 'checkbox', checked: form.webSearch, onChange: function (event) { update('webSearch', event.target.checked); } }),
                    '回答问题时允许联网查资料'
                  ),
                  h('label', { className: 'dshm-check', style: { marginTop: '6px' } },
                    h('input', { type: 'checkbox', checked: form.speakers, onChange: function (event) { update('speakers', event.target.checked); } }),
                    '按音色区分发言人（本地声纹聚类，不代表实名）'
                  )
                ),
                form.speakers
                  ? h('div', { className: 'dshm-field', style: { marginTop: '8px' } },
                    h('span', null, '发言人区分灵敏度（越高越不容易合并不同的人）'),
                    h('select', {
                      className: 'dshm-select', value: String(form.speakerThreshold),
                      onChange: function (event) { update('speakerThreshold', Number(event.target.value)); }
                    },
                    h('option', { value: '0.58' }, '高 · 0.58'),
                    h('option', { value: '0.66' }, '中 · 0.66（推荐）'),
                    h('option', { value: '0.74' }, '低 · 0.74')
                    ))
                  : null,
                h('label', { className: 'dshm-check', style: { marginTop: '6px' } },
                  h('input', {
                    type: 'checkbox', checked: form.micEnabled,
                    onChange: function (event) { update('micEnabled', event.target.checked); if (!micDevices.length) refreshDevices(); }
                  }),
                  '采集我的麦克风（我的发言标为「自己」；建议戴耳机，避免重复收录会议声音）'
                ),
                form.micEnabled
                  ? h('div', { className: 'dshm-field', style: { marginTop: '8px' } },
                    h('span', null, '麦克风设备'),
                    h('select', {
                      className: 'dshm-select', value: form.micDeviceId,
                      onChange: function (event) { update('micDeviceId', event.target.value); }
                    }, [h('option', { key: 'default', value: '' }, '系统默认麦克风')].concat(micDevices.map(function (device) {
                      return h('option', { key: device.id, value: device.id }, device.name);
                    }))))
                  : null,
                h('div', { className: 'dshm-field', style: { marginTop: '8px' } },
                  h('span', null, '术语表（原文=期望写法，每行一条）'),
                  h('textarea', {
                    className: 'dshm-textarea', value: form.glossary, rows: 2,
                    placeholder: '例如：DSH=DeepSeek Harness\nSenseVoice=本地语音识别',
                    onChange: function (event) { update('glossary', event.target.value); }
                  })
                ),
                h('div', { className: 'dshm-row', style: { marginTop: '8px' } },
                  active && !active.readOnly ? h('button', { type: 'button', className: 'dshm-btn', 'data-kind': 'primary', onClick: applyLiveSettings, disabled: busy === 'settings' }, '应用设置') : null,
                  h('button', { type: 'button', className: 'dshm-btn', 'data-kind': 'ghost', onClick: refreshDevices }, '刷新播放设备')
                )
              ),
              h('div', {
                className: 'dshm-card',
                'data-drag': dragOver ? 'true' : 'false',
                onDragOver: function (event) { event.preventDefault(); setDragOver(true); },
                onDragEnter: function (event) { event.preventDefault(); setDragOver(true); },
                onDragLeave: function (event) { event.preventDefault(); setDragOver(false); },
                onDrop: onAgendaDrop
              },
                h('div', { className: 'dshm-cardTitle' }, '会议日程',
                  h('span', { className: 'dshm-muted' }, agendaCurrent.status === 'current' ? '当前：' + agendaEntryText(agendaCurrent.entry) : agendaCurrent.status === 'next' ? '下一项：' + agendaEntryText(agendaCurrent.entry) : '未设置时间')),
                h('p', { className: 'dshm-muted' }, '上传、拖拽或直接粘贴日程：支持 txt / md / csv / json，也支持 PDF / Word / PPT / Excel 和 png / jpg / webp / bmp 图片。上传只提取文字，点「应用日程」后才由 AI 解析成时间/姓名/单位/主题，并自动识别会议主题和会议领域。'),
                h('div', { className: 'dshm-row', style: { marginTop: '6px' } },
                  h('label', { className: 'dshm-btn', 'data-kind': 'small', style: { cursor: 'pointer' } },
                    '上传 / 拖入日程',
                    h('input', {
                      type: 'file',
                      accept: '.txt,.md,.markdown,.csv,.json,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.odp,.ods,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,text/plain,text/csv,application/json,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,image/*',
                      style: { display: 'none' }, onChange: onAgendaFile
                    })
                  ),
                  h('button', {
                    type: 'button', className: 'dshm-btn', 'data-kind': 'primary',
                    disabled: agendaBusy || agendaDraft.trim().length === 0,
                    onClick: function () { applyAgenda(agendaDraft, agendaFilename); }
                  }, agendaBusy ? h('span', null, h('span', { className: 'dshm-spinner' }), ' AI 解析中…') : '应用日程'),
                  agendaSource
                    ? h('span', { className: 'dshm-pill', 'data-tone': 'busy' },
                      agendaSource === 'image' ? '已载入图片，待 AI 解析' : '已载入文件，待 AI 解析')
                    : null,
                  agenda && agenda.parsedBy === 'llm'
                    ? h('span', { className: 'dshm-pill', 'data-tone': 'good' }, 'AI 已解析')
                    : null,
                  agenda && (agenda.fileName || agenda.imageName)
                    ? h('span', { className: 'dshm-pill', 'data-tone': 'good' }, agenda.source === 'image' ? '图片 OCR' : '文件提取')
                    : null
                ),
                h('textarea', {
                  className: 'dshm-textarea', rows: 3, value: agendaDraft, style: { marginTop: '7px' },
                  placeholder: '14:00-14:30 张医生（市医院） 创面修复病例分享\n14:30-15:00 李主任（省医院）：糖尿病足多学科协作\n\n也可以直接粘贴日程文字、截图或文件（Ctrl+V）',
                  onChange: function (event) { setAgendaDraft(event.target.value); setAgendaFilename(''); setAgendaSource(''); },
                  onPaste: onAgendaPaste
                }),
                dragOver
                  ? h('div', { className: 'dshm-dropHint' }, '松开以读取日程文件')
                  : null,
                agendaWarnings.length > 0
                  ? h('div', { className: 'dshm-warning', style: { marginTop: '6px' } }, agendaWarnings.join('；'))
                  : null,
                // Structured and editable here too: the settings panel and the
                // setup flow share one table.
                agendaRows.length > 0 ? renderAgendaTable() : null,
                h('div', { className: 'dshm-row', style: { marginTop: '6px' } },
                  h('button', {
                    type: 'button', className: 'dshm-btn', 'data-kind': 'ghost',
                    onClick: function () { setForceWizard(true); setWizardDismissed(false); setShowSettings(false); }
                  }, '重新初始化会议'))
              ),
              asr && asr.available === false
                ? h('div', { className: 'dshm-card' },
                  h('div', { className: 'dshm-cardTitle' }, '需要启用本地语音识别'),
                  h('p', { className: 'dshm-note' }, '在 DSH 的插件管理中启用官方「语音输入」组合包。它会安装本地 SenseVoice 模型，音频不会离开这台电脑。'),
                  h('p', { className: 'dshm-muted' }, asr.message || '')
                )
                : null,
              asr && asr.available
                ? h('div', { className: 'dshm-card' },
                  h('div', { className: 'dshm-cardTitle' }, '本地语音模型', h('span', { className: 'dshm-muted' }, asr.providerId || '')),
                  h('p', { className: 'dshm-note' }, phaseText(asr)),
                  progress !== null
                    ? h('div', null,
                      h('div', { className: 'dshm-progress' }, h('i', { style: { width: progress + '%' } })),
                      h('p', { className: 'dshm-muted' }, progress + '% · 首次使用约需 240MB')
                    )
                    : null,
                  ['unprepared', 'failed', 'cancelled'].indexOf(asr.phase) >= 0
                    ? h('button', { type: 'button', className: 'dshm-btn', 'data-kind': 'primary', onClick: prepareModel }, '下载并准备模型')
                    : null,
                  ['checking', 'loading', 'waking', 'downloading'].indexOf(asr.phase) >= 0
                    ? h('p', { className: 'dshm-muted' }, h('span', { className: 'dshm-spinner' }), ' 准备中…')
                    : null
                )
                : null,
              active && active.speakers && active.speakers.length > 0
                ? h('div', { className: 'dshm-card' },
                  h('div', { className: 'dshm-cardTitle' }, '识别到的发言人'),
                  h('p', { className: 'dshm-muted' }, '这只是“同一个人”的分组，不知道真实姓名。可以改成「张医生」「客户」等，后续纪要和问答会使用这些名字。'),
                  active.speakers.map(function (speaker) {
                    return h('label', { key: speaker.id + ':' + speaker.name + ':' + (speaker.org || ''), className: 'dshm-speakerRow' },
                      h('span', { className: 'dshm-speakerDot', style: { background: speakerColor(speaker.id) } }),
                      h('span', { className: 'dshm-speakerId' }, speaker.id.toUpperCase()),
                      h('input', {
                        className: 'dshm-input', defaultValue: speaker.name, 'data-role': 'name',
                        placeholder: '姓名',
                        onBlur: function (event) {
                          var row = event.target.parentElement;
                          var org = row.querySelector('[data-role="org"]');
                          renameSpeaker(speaker.id, event.target.value, org ? org.value : '');
                        },
                        onKeyDown: function (event) {
                          if (event.key === 'Enter') event.target.blur();
                        }
                      }),
                      h('input', {
                        className: 'dshm-input dshm-orgInput', defaultValue: speaker.org || '', 'data-role': 'org',
                        placeholder: '单位',
                        onBlur: function (event) {
                          var row = event.target.parentElement;
                          var name = row.querySelector('[data-role="name"]');
                          if (name) renameSpeaker(speaker.id, name.value, event.target.value);
                        },
                        onKeyDown: function (event) {
                          if (event.key === 'Enter') event.target.blur();
                        }
                      })
                    );
                  })
                )
                : null
            );
          }

          function field(label, control) {
            return h('label', { className: 'dshm-field' }, h('span', null, label), control);
          }

          function renderTranscript() {
            if (!active) {
              if (wizardVisible && !showSettings) {
                return renderWizard();
              }
              return h('div', { className: 'dshm-empty' },
                h('div', { className: 'dshm-emptyIcon' }, h(WaveIcon, null)),
                h('div', { className: 'dshm-emptyTitle' }, '听听这场会议'),
                h('p', { className: 'dshm-muted' }, '点击「开始听会」后，插件会采集系统默认播放设备的声音；请确认会议软件的声音输出到该设备。'),
                h('p', { className: 'dshm-muted' }, '发言结束后，本地 SenseVoice 先转写，再由 DSH 模型按会议领域校正措辞；需要时可开启翻译。'),
                h('p', { className: 'dshm-muted' }, '会采集电脑上所有播放声音，请暂停音乐、视频等其他音频。')
              );
            }
            if (turns.length === 0) {
              return h('div', { className: 'dshm-empty' },
                h('span', { className: active.status === 'listening' ? 'dshm-dot' : 'dshm-spinner', 'data-tone': 'live' }),
                h('div', { className: 'dshm-emptyTitle' }, active.status === 'listening' ? '正在等待第一句话…' : '还没有转写内容'),
                h('p', { className: 'dshm-muted' }, '开始说话后，同一个人的连续发言会合并成一个发言块；识别和校正会自动完成。')
              );
            }
            var lastTurn = visibleTurns[visibleTurns.length - 1];
            var refine = active.refineState || {};
            return h('div', null,
              h('div', { className: 'dshm-lines' }, visibleTurns.map(function (turn) {
                return h(Turn, {
                  key: turn.id,
                  turn: turn,
                  speakers: active && Array.isArray(active.speakers) ? active.speakers : [],
                  roster: participantRoster,
                  menu: speakerMenuTurn === turn.id,
                  onToggleMenu: function (id) { setSpeakerMenuTurn(speakerMenuTurn === id ? '' : id); },
                  onPickSpeaker: active && !active.readOnly ? pickTurnSpeaker : null,
                  onPickPerson: active && !active.readOnly ? pickTurnPerson : null
                });
              })),
              refine.status === 'refining'
                ? h('div', { className: 'dshm-recognizing' },
                  h('span', { className: 'dshm-spinner' }),
                  h('span', null, '正在按整段会话二次校正（会合并被 10 秒切开的句子）…'))
                : null,
              recognizing
                ? h('div', { className: 'dshm-recognizing' },
                  h('span', { className: 'dshm-spinner' }),
                  h('span', null, '正在识别 ' + formatClock(recognizing.startMs) + ' 开始的这一段…'))
                : null,
              correctionErrors > 0
                ? h('div', { style: { padding: '0 14px 14px' } },
                  h('div', { className: 'dshm-warning' }, correctionErrors + ' 段校正失败，当前显示原始识别文本。'),
                  h('button', { type: 'button', className: 'dshm-btn', 'data-kind': 'small', onClick: retryCorrections }, '重试校正'))
                : null,
              lastTurn && lastTurn.correctionStatus === 'pending'
                ? h('div', { className: 'dshm-recognizing' }, h('span', { className: 'dshm-dots' }, h('span'), h('span'), h('span')), h('span', null, '正在校正这一段…'))
                : null,
              !following && !showSettings
                ? h('div', { className: 'dshm-followWrap' },
                  h('button', { type: 'button', className: 'dshm-followBtn', onClick: scrollToBottom }, '↓ 回到底部，继续跟随'))
                : null
            );
          }

          function renderSummary() {
            if (!active) {
              return h('div', { className: 'dshm-empty' },
                h('div', { className: 'dshm-emptyTitle' }, '会议纪要将在这里出现'),
                h('p', { className: 'dshm-muted' }, '纪要不会自动生成：点「生成纪要」时才按当前转写和会议日程写一版；结束会议时会生成最终版。')
              );
            }
            var summary = active.summary || {};
            var buttonLabel = summary.markdown ? '更新纪要' : '生成纪要';
            return h('div', { className: 'dshm-section' },
              h('div', { className: 'dshm-row', style: { marginBottom: '8px' } },
                h('div', { className: 'dshm-cardTitle', style: { margin: 0 } }, '会议纪要'),
                h('span', { className: 'dshm-muted' }, summary.updatedAt ? formatDate(summary.updatedAt) : '尚未生成'),
                h('span', { className: 'dshm-spacer', style: { flex: 1 } }),
                active.readOnly ? null : h('button', {
                  type: 'button', className: 'dshm-btn', 'data-kind': 'primary', 'data-size': 'small',
                  disabled: summary.status === 'summarizing',
                  onClick: regenerateSummary
                }, summary.status === 'summarizing' ? '生成中…' : buttonLabel)
              ),
              summary.status === 'summarizing' ? h('p', { className: 'dshm-muted' }, h('span', { className: 'dshm-spinner' }), ' 正在按会议日程生成…') : null,
              summary.status === 'stale' ? h('div', { className: 'dshm-warning' }, '最新一版纪要更新失败，下面显示的是上一版：' + (summary.error || '未知错误')) : null,
              summary.status === 'error' ? h('div', { className: 'dshm-warning' }, '纪要生成失败：' + (summary.error || '未知错误')) : null,
              summary.markdown
                ? h(Markdown, { text: summary.markdown })
                : h('p', { className: 'dshm-muted' }, active.status === 'listening'
                  ? '还没有纪要。点右上角「生成纪要」，会连同会议日程一起交给模型。'
                  : '还没有纪要内容。')
            );
          }

          function renderScripts() {
            var script = snapshot && snapshot.script ? snapshot.script : null;
            var savedProfile = snapshot && snapshot.profile ? snapshot.profile : {};
            var userName = (savedProfile.userName || '').trim();
            var ownEntries = userName
              ? agendaEntries.filter(function (entry) { return entry && nameMatches(entry.speaker, userName); })
              : [];
            var writing = script && script.status === 'writing';
            var stale = script && script.status === 'done' && script.markdown && agenda
              && agenda.updatedAt && Number(script.agendaUpdatedAt) !== Number(agenda.updatedAt);

            if (agendaEntries.length === 0) {
              return h('div', { className: 'dshm-empty' },
                h('div', { className: 'dshm-emptyTitle' }, '上传会议日程后生成我的讲词与串词'),
                h('p', { className: 'dshm-muted' }, '在设置里填写「我的姓名」并上传会议日程；只有当你的名字出现在日程里时，才会为你生成讲词和串词。'),
                h('button', {
                  type: 'button', className: 'dshm-btn', 'data-kind': 'primary',
                  onClick: function () { setShowSettings(true); }
                }, '去设置日程和姓名')
              );
            }

            var blocked = !userName
              ? '先在设置里填写「我的姓名」，才会生成属于你的讲词与串词。'
              : ownEntries.length === 0
                ? '日程里没有出现“' + userName + '”，所以不生成讲词。请让日程里的讲者写法与你的姓名一致，或修改日程/姓名后重试。'
                : '';

            return h('div', { className: 'dshm-section' },
              (function () {
                var cues = active && Array.isArray(active.cues) ? active.cues : [];
                var cueKindLabel = {
                  opening: '开场致辞', transition: '环节交接', closing: '结束致辞', thanks: '上场感谢', manual: '即时串词'
                };
                var ownWithIndex = agendaEntries
                  .map(function (entry, index) { return { entry: entry, index: index }; })
                  .filter(function (item) { return item.entry && nameMatches(item.entry.speaker, userName); });
                return h('div', { className: 'dshm-card' },
                  h('div', { className: 'dshm-cardTitle' }, '我的串词'),
                  cues.length > 0
                    ? cues.slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0); }).map(function (cue) {
                      return h('div', { key: cue.key, className: 'dshm-cue' },
                        h('div', { className: 'dshm-row' },
                          h('span', {
                            className: 'dshm-pill',
                            'data-tone': cue.status === 'error' ? 'bad' : cue.status === 'writing' ? 'busy' : 'good'
                          }, cueKindLabel[cue.kind] || '串词'),
                          h('span', { className: 'dshm-muted' }, cue.entryText || ''),
                          h('span', { className: 'dshm-spacer', style: { flex: 1 } }),
                          h('span', { className: 'dshm-muted' }, cue.at ? formatDate(cue.at) : '')),
                        cue.status === 'writing'
                          ? h('p', { className: 'dshm-muted' }, h('span', { className: 'dshm-spinner' }), ' 正在结合当前进度生成…')
                          : cue.status === 'error'
                            ? h('div', { className: 'dshm-warning' }, cue.error || '生成失败')
                            : h('p', { className: 'dshm-cueText' }, cue.markdown));
                    })
                    : h('p', { className: 'dshm-muted' }, active
                      ? '还没有串词。到达你的环节前 2 分钟会自动生成；也可以在下面点一个环节立即生成。'
                      : '开始听会后，到达你的环节前 2 分钟会自动生成串词。'),
                  ownWithIndex.length > 0 && active && !active.readOnly
                    ? h('div', { className: 'dshm-chips', style: { marginTop: '6px' } },
                      ownWithIndex.map(function (item) {
                        return h('button', {
                          key: 'own' + item.index, type: 'button', className: 'dshm-chip',
                          onClick: function () { requestCue(item.index); }
                        }, '立即生成：' + (agendaEntryText(item.entry) || '我的环节'));
                      }))
                    : null
                );
              })(),
              h('div', { className: 'dshm-card' },
                h('div', { className: 'dshm-cardTitle' }, '我的讲词与串词',
                  h('span', { className: 'dshm-spacer', style: { flex: 1 } }),
                  script && script.markdown && !writing
                    ? h('span', { className: 'dshm-muted' }, script.updatedAt ? formatDate(script.updatedAt) : '')
                    : null,
                  active && active.readOnly ? null : h('button', {
                    type: 'button', className: 'dshm-btn', 'data-kind': 'small',
                    disabled: writing || blocked.length > 0,
                    onClick: regenerateScripts
                  }, writing ? '生成中…' : '重新生成')
                ),
                blocked.length > 0 ? h('div', { className: 'dshm-warning' }, blocked) : null,
                writing
                  ? h('p', { className: 'dshm-muted' }, h('span', { className: 'dshm-spinner' }), ' 正在按日程和我的姓名撰写…')
                  : null,
                script && script.error && !writing
                  ? h('div', { className: 'dshm-warning' }, '生成失败：' + script.error)
                  : null,
                stale
                  ? h('div', { className: 'dshm-warning' }, '日程已更新，上面的讲词可能已经过期，点「重新生成」刷新。')
                  : null,
                ownEntries.length > 0
                  ? h('p', { className: 'dshm-muted', style: { marginTop: '6px' } },
                    '日程中属于我的环节：' + ownEntries.map(function (entry) { return agendaEntryText(entry); }).join('；'))
                  : null,
                script && script.markdown
                  ? h('div', { style: { marginTop: '8px' } }, h(Markdown, { text: script.markdown }))
                  : h('p', { className: 'dshm-muted', style: { marginTop: '6px' } },
                    ownEntries.length > 0 ? '点「重新生成」生成属于你的讲词与串词。' : '')
              ),
              h('div', { className: 'dshm-card' },
                h('div', { className: 'dshm-cardTitle' }, '生成提示词'),
                h('p', { className: 'dshm-muted' }, '这是写给模型的「写作要求」，可以改成你想要的风格、长度或重点；留空则使用默认提示词。修改后点「用这个提示词重新生成」。'),
                h('textarea', {
                  className: 'dshm-textarea', rows: 8, value: scriptPrompt,
                  placeholder: script && script.defaultPrompt ? script.defaultPrompt : '留空使用默认提示词',
                  onChange: function (event) { setScriptPrompt(event.target.value); }
                }),
                h('div', { className: 'dshm-row', style: { marginTop: '8px' } },
                  h('button', {
                    type: 'button', className: 'dshm-btn', 'data-kind': 'primary',
                    disabled: writing || blocked.length > 0,
                    onClick: regenerateScripts
                  }, '用这个提示词重新生成'),
                  h('button', {
                    type: 'button', className: 'dshm-btn', 'data-kind': 'ghost',
                    onClick: function () {
                      // Keep the server prompt in the ref: the sync effect must
                      // not restore the old custom prompt on the next snapshot.
                      setScriptPrompt('');
                    }
                  }, '恢复默认提示词')
                )
              )
            );
          }

          function renderQa() {
            if (!active) {
              return h('div', { className: 'dshm-empty' },
                h('div', { className: 'dshm-emptyTitle' }, '在会议中随时提问'),
                h('p', { className: 'dshm-muted' }, '比如：「刚才提到的三个风险是什么？」「把预算数字整理一下」「帮我查一下这个政策的最新版本」。'),
                h('p', { className: 'dshm-muted' }, '回答会优先依据会议纪要；需要外部资料时会使用 DSH 的联网搜索。')
              );
            }
            var suggestions = ['总结一下目前的结论', '有哪些待办事项？', '刚才提到哪些关键数字？'];
            return h('div', { className: 'dshm-qa' },
              h('div', { className: 'dshm-answers' },
                answers.length === 0
                  ? h('div', { className: 'dshm-empty', style: { minHeight: '120px' } },
                    h('p', { className: 'dshm-muted' }, '会议进行中，可以随时打断式提问。'),
                    h('div', { className: 'dshm-chips' }, suggestions.map(function (text) {
                      return h('button', { key: text, type: 'button', className: 'dshm-chip', onClick: function () { sendQuestion(text); } }, text);
                    }))
                  )
                  : answers.map(function (answer) {
                    return h(AnswerBubble, { key: answer.id, answer: answer });
                  })
              ),
              h('div', { className: 'dshm-askBar' },
                h('textarea', {
                  className: 'dshm-textarea dshm-askInput',
                  value: question,
                  placeholder: '问一个关于这场会议的问题…（Enter 发送，Shift+Enter 换行）',
                  onChange: function (event) { setQuestion(event.target.value); },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      sendQuestion();
                    }
                  }
                }),
                h('button', {
                  type: 'button', className: 'dshm-btn', 'data-kind': 'primary',
                  disabled: question.trim().length === 0 || busy === 'ask',
                  onClick: function () { sendQuestion(); }
                }, busy === 'ask' ? h('span', { className: 'dshm-spinner' }) : '发送')
              ),
              h('label', { className: 'dshm-check', style: { paddingTop: '5px' } },
                h('input', {
                  type: 'checkbox', checked: form.webSearch,
                  onChange: function (event) { update('webSearch', event.target.checked); }
                }),
                '回答时允许联网查资料'
              )
            );
          }

          function renderHistory() {
            return h('div', { className: 'dshm-history' },
              h('div', { className: 'dshm-historyHead' },
                h('div', { className: 'dshm-title', style: { fontSize: '13px' } }, '历史会议'),
                h('span', { className: 'dshm-spacer', style: { flex: 1 } }),
                h('button', { type: 'button', className: 'dshm-btn', 'data-kind': 'ghost', onClick: function () { setHistoryOpen(false); } }, '返回')
              ),
              h('div', { className: 'dshm-historyList' },
                historyBusy ? h('p', { className: 'dshm-muted' }, h('span', { className: 'dshm-spinner' }), ' 读取中…') : null,
                history && history.length === 0 ? h('p', { className: 'dshm-muted' }, '还没有历史会议。') : null,
                (history || []).map(function (meeting) {
                  return h('button', {
                    key: meeting.id, type: 'button', className: 'dshm-historyItem',
                    onClick: function () { loadHistory(meeting.id); }
                  },
                  h('div', { className: 'dshm-historyTitle' }, meeting.title || '未命名会议'),
                  h('div', { className: 'dshm-historyMeta' }, formatDate(meeting.createdAt) + ' · ' + meeting.lines + ' 行 · ' + (meeting.domain || 'general')),
                  meeting.summaryPreview ? h('div', { className: 'dshm-historyPreview' }, meeting.summaryPreview.replace(/\s+/g, ' ').slice(0, 140)) : null
                  );
                })
              )
            );
          }
        }

        function apply(ctx) {
          insertStyle();
          try {
            ctx.slots.inject('conversation.session.header.utilities', function () {
              return ctx.slots.register({
                name: 'conversation.session.header.utilities',
                id: 'meeting-toggle',
                order: 18
              }, MeetingToggle);
            });
          } catch (error) {
            // the header seat may not exist on an older Host
          }
        }

        return {
          inject: ['slots'],
          apply: apply
        };
      }
    });
  }
})();
