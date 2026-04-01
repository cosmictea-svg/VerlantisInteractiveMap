// Verlantis Interactive Map
const VERSION = (typeof __BUILD_DATE__ !== "undefined" && typeof __COMMIT__ !== "undefined")
  ? `v${__BUILD_DATE__}-${__COMMIT__}`
  : "vdev";
import { useState, useRef, useEffect, useMemo, memo } from "react";
import { createRoot } from "react-dom/client";

// Detect touch-only devices so we can suppress autoFocus={!isTouchDevice} (prevents keyboard pop-up on mobile)
const isTouchDevice = typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);

const SUPA_URL = "https://iqmaumupuftguhurnsdt.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlxbWF1bXVwdWZ0Z3VodXJuc2R0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyNTQ5MjEsImV4cCI6MjA4OTgzMDkyMX0.m7lg88RD_3M3OAqt0g17voz_jbZ0f02w-LocREn5Ffg";

// ── DB helpers ────────────────────────────────────────────────────────────────
function hdrs(token) {
  return { "apikey": SUPA_KEY, "Authorization": `Bearer ${token || SUPA_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" };
}
async function dbSelect(token, table, params = "") {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${params}`, { headers: hdrs(token) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function dbInsert(token, table, body) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}`, { method: "POST", headers: hdrs(token), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function dbUpdate(token, table, id, body) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`, { method: "PATCH", headers: hdrs(token), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function dbDelete(token, table, id) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`, { method: "DELETE", headers: hdrs(token) });
  if (!r.ok) throw new Error(await r.text());
}
async function dbUpsert(token, table, body, onConflict) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST", headers: { ...hdrs(token), "Prefer": "return=representation,resolution=merge-duplicates" }, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function uploadToStorage(token, file, bucket = "poi-icons") {
  const ext = file.name.split(".").pop() || "png";
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const r = await fetch(`${SUPA_URL}/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    headers: { "apikey": SUPA_KEY, "Authorization": `Bearer ${token}`, "Content-Type": file.type || "image/png" },
    body: file
  });
  if (!r.ok) throw new Error(await r.text());
  return `${SUPA_URL}/storage/v1/object/public/${bucket}/${path}`;
}

// Compress + convert any image file to WebP before uploading (huge savings for map images).
// Returns a Blob ready for upload. Falls back to original file if Canvas API unavailable.
async function compressToWebP(file, quality = 0.82) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        // Scale down if larger than 4096px on either axis (keeps file size sane)
        const MAX = 4096;
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > MAX || h > MAX) {
          const ratio = Math.min(MAX / w, MAX / h);
          w = Math.round(w * ratio); h = Math.round(h * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob(blob => resolve(blob || file), "image/webp", quality);
      } catch { resolve(file); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function getUser(token) {
  const r = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: hdrs(token) });
  if (!r.ok) return null;
  return r.json();
}
async function refreshSession(refresh_token) {
  const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST", headers: { "apikey": SUPA_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token })
  });
  if (!r.ok) return null;
  return r.json();
}
function getStoredSession() {
  try { const s = localStorage.getItem("sb_session"); return s ? JSON.parse(s) : null; } catch { return null; }
}
function parseHashSession() {
  const hash = window.location.hash; if (!hash) return null;
  const p = new URLSearchParams(hash.replace("#", ""));
  const access_token = p.get("access_token"), refresh_token = p.get("refresh_token");
  if (!access_token) return null;
  return { access_token, refresh_token };
}
function signInWithGoogle() {
  const redirectTo = encodeURIComponent("https://verlantisinteractivemap.com");
  window.location.href = `${SUPA_URL}/auth/v1/authorize?provider=google&redirect_to=${redirectTo}`;
}
async function signOut(token) {
  await fetch(`${SUPA_URL}/auth/v1/logout`, { method: "POST", headers: hdrs(token) });
  localStorage.removeItem("sb_session");
  localStorage.removeItem("sb_last_campaign"); // clear persisted campaign on sign-out
}

// ── Realtime ──────────────────────────────────────────────────────────────────
// campaign_members is now included so colour changes block in real-time for other players
function createRealtimeChannel(token, campaignId, handlers) {
  const wsUrl = `${SUPA_URL.replace("https://", "wss://")}/realtime/v1/websocket?apikey=${SUPA_KEY}&vsn=1.0.0`;
  let ws, heartbeatTimer, reconnectTimer;
  let closed = false;
  function connect() {
    if (closed) return;
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      // campaigns uses id= filter; all others use campaign_id=
      const tableConfigs = [
        { table: "pois",             filter: `campaign_id=eq.${campaignId}` },
        { table: "markers",          filter: `campaign_id=eq.${campaignId}` },
        { table: "campaign_members", filter: `campaign_id=eq.${campaignId}` },
        { table: "campaigns",        filter: `id=eq.${campaignId}` },
        { table: "overlays",         filter: `campaign_id=eq.${campaignId}` },
        { table: "zones",            filter: `campaign_id=eq.${campaignId}` },
        { table: "npcs",             filter: `campaign_id=eq.${campaignId}` },
        { table: "announcements",    filter: `campaign_id=eq.${campaignId}` },
        { table: "notification_log", filter: `campaign_id=eq.${campaignId}` },
        { table: "maps",             filter: `campaign_id=eq.${campaignId}` },
        { table: "poi_folders",      filter: `campaign_id=eq.${campaignId}` },
        { table: "map_texts",        filter: `campaign_id=eq.${campaignId}` },
      ];
      tableConfigs.forEach(({ table, filter }, i) => {
        ws.send(JSON.stringify({
          topic: `realtime:public:${table}:${filter}`,
          event: "phx_join",
          payload: { config: { postgres_changes: [{ event: "*", schema: "public", table, filter }] }, user_token: token },
          ref: String(i + 1)
        }));
      });
      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: "hb" }));
      }, 20000);
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        const payload = msg.payload?.data;
        if (!payload) return;
        // DEBUG — remove once confirmed working
        const table = payload.table;
        const eventType = payload.eventType ?? payload.type;          // v2: eventType, v1: type
        const record    = payload.new        ?? payload.record;       // v2: new,       v1: record
        const old_rec   = payload.old        ?? payload.old_record;   // v2: old,       v1: old_record
        const mapped = { eventType, new: record, old: old_rec };
        if (table === "pois") handlers.onPOI(mapped);
        if (table === "markers") handlers.onMarker(mapped);
        if (table === "campaign_members") handlers.onMember?.(mapped);
        if (table === "campaigns") handlers.onCampaign?.(mapped);
        if (table === "overlays") handlers.onOverlay?.(mapped);
        if (table === "zones") handlers.onZone?.(mapped);
        if (table === "npcs") handlers.onNPC?.(mapped);
        if (table === "announcements") handlers.onAnnouncement?.(mapped);
        if (table === "notification_log") handlers.onNotifLog?.(mapped);
        if (table === "maps") handlers.onMap?.(mapped);
        if (table === "poi_folders") handlers.onPOIFolder?.(mapped);
        if (table === "map_texts")   handlers.onMapText?.(mapped);
      } catch {}
    };
    ws.onclose = () => { clearInterval(heartbeatTimer); if (!closed) reconnectTimer = setTimeout(connect, 3000); };
    ws.onerror = () => ws.close();
  }
  connect();
  return { unsubscribe() { closed = true; clearInterval(heartbeatTimer); clearTimeout(reconnectTimer); if (ws) ws.close(); } };
}

// ── Constants ─────────────────────────────────────────────────────────────────
const CATEGORIES = [
  { id: "merchant",   label: "Merchants",         color: "#FFD700" },
  { id: "entertain",  label: "Entertainment",     color: "#9B59B6" },
  { id: "guild",      label: "Guilds",            color: "#C0C0C0" },
  { id: "inn",        label: "Inns / Taverns",    color: "#E8A317" },
  { id: "craft",      label: "Craftsmen",         color: "#E67E22" },
  { id: "government", label: "Government",        color: "#3498DB" },
  { id: "public",     label: "Public Services",   color: "#90CAF9" },
  { id: "security",   label: "Security",          color: "#E74C3C" },
  { id: "religion",   label: "Religion",          color: "#00BCD4" },
  { id: "landmark",   label: "Landmark / Nature", color: "#2E7D32" },
  { id: "sewer",      label: "Sewer",             color: "#795548" },
  { id: "arena",      label: "Arena",             color: "#FF5722" },
  { id: "jail",       label: "Jail",              color: "#546E7A" },
  { id: "door",       label: "Door",              color: "#A1887F" },
  { id: "gate",       label: "Checkpoints",        color: "#7B9E87" },
  { id: "other",      label: "Others",            color: "#95A5A6" },
];
const POI_SIZES = [
  { id: "large",  label: "L", scale: 1.0 },
  { id: "medium", label: "M", scale: 0.66 },
  { id: "small",  label: "S", scale: 0.45 },
];
const PLAYER_COLORS = [
  "#E74C3C","#E67E22","#F1C40F","#2ECC71","#1ABC9C",
  "#3498DB","#9B59B6","#E91E63","#FF5722","#00BCD4",
  "#8BC34A","#FF9800","#607D8B","#795548","#FFFFFF",
  "#F06292","#4DB6AC","#7986CB","#A5D6A7","#CE93D8",
  "#FFCC80","#80DEEA","#B0BEC5","#FFAB91","#DCE775",
];

// ── Parchment & Ink Theme ─────────────────────────────────────────────────────
const T = {
  bg:       "#F5EDDA",   // parchment — main background
  surface:  "#EDE0C4",   // aged vellum — card / panel surfaces
  border:   "#B8A88A",   // warm brown border
  ink:      "#1C1208",   // ink black
  muted:    "#6B5B45",   // secondary text (warm brown)
  header:   "#1A1035",   // dark stone header
  headerFg: "#F0E6C8",   // bone white — text on dark header
  gold:     "#C9A84C",   // antique gold (active / accent)
  goldDim:  "#7A5C10",   // darker gold for text on light bg
  purple:   "#2D1B69",   // deep arcane purple (primary action)
  danger:   "#8B1A1A",   // blood red
  fHead:    "'Cinzel', 'Georgia', serif",
  fBody:    "'Lora', 'Georgia', serif",
  fMap:     "'Nunito', 'Exo 2', sans-serif",
};

function getCatColor(id) { return CATEGORIES.find(c => c.id === id)?.color || "#95A5A6"; }
function getZoneBBox(points) {
  if (!points?.length) return { x: 0, y: 0, w: 100, h: 100 };
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX || 1, h: Math.max(...ys) - minY || 1 };
}
function getCatLabel(id) { return CATEGORIES.find(c => c.id === id)?.label || "Others"; }
function getSizeScale(id) { return POI_SIZES.find(s => s.id === id)?.scale ?? 1.0; }

const IS = { width: "100%", padding: "7px 11px", borderRadius: 8, border: `1px solid ${T.border}`, fontSize: 13, background: "#fffbf2", color: T.ink, boxSizing: "border-box", fontFamily: T.fBody };

const VERLANTIS_QUOTES = [
  // --- Named NPCs ---
  // Elenadara Winter
  { quote: "Three hundred years of governance and the thing mortals remember most is the Flash Blizzard. A ritual that killed her family. Gratitude is a strange thing to receive for a grief that never ended.", attribution: "On Elenadara Winter, Aegis of Winter field record" },
  { quote: "The Aegis of Winter was built to be her eyes and ears across Verlantis. After three centuries the eyes have seen enough. The ears stopped being surprised a long time ago.", attribution: "Aegis of Winter internal record, on Elenadara Winter" },
  { quote: "She does not call herself a hero. Heroes finish.", attribution: "Aegis of Winter field record, on Elenadara Winter" },
  // Nkrabea, Matriarch of Death
  { quote: "The Cycle does not mourn. It does not celebrate. It turns. Everything else is mortal interpretation.", attribution: "Nkrabea, Matriarch of Death" },
  { quote: "Nekapolis offends the Cycle in ways that war, plague, and famine never have. Those things feed it. Nekapolis starves it. The distinction is not philosophical. It is existential.", attribution: "Nkrabea, Matriarch of Death" },
  { quote: "She does not hate Nekapolis for what it is. She hates it for what it prevents.", attribution: "Ashen Reaper briefing document, on Nkrabea" },
  { quote: "Every realm calls itself righteous. None of them send their dead back.", attribution: "Nkrabea, Matriarch of Death, recorded address to the Ashen Reapers" },
  // Gorlaya'Kasa
  { quote: "The Prometheans redirected toward the Pact of Agony because Korcent Valiz made it convenient. Gorlaya'Kasa did not care about the politics. He cared about the provocation.", attribution: "Bastion of the Purgatory intelligence briefing, EC3" },
  { quote: "Arrabii took centuries to build. It took him considerably less time to disagree with its existence.", attribution: "Ruby Cerberus merchant guild record, on Gorlaya'Kasa" },
  { quote: "The Scorch Fiery Badlands were not always a death desert. That transformation has a name. It simply does not negotiate.", attribution: "Unnamed Ruby Cerberus cartographer, EC3 survey" },
  // Yaharrom Marox
  { quote: "The ritual should have been impossible. The consensus of every living scholar at the time confirmed this. Yaharrom and Lissandra Marox were not living scholars. They were mortals with access to a divine catastrophe and a very specific plan.", attribution: "Veil Siphoner remnant archive" },
  { quote: "Nekapolis was not stolen. It was claimed from wreckage that every outworldly power had written off. The fact that it worked has been making those powers uncomfortable ever since.", attribution: "Yaharrom Marox, Damned Crown founding record" },
  // Lissandra Marox
  { quote: "Zontraxsa arrived broken. The Judas Heart had seen to that thoroughly. Lissandra rebuilt him with Necrolyte because she was curious whether it could be done and because she needed to know if the result would be loyal.", attribution: "Damned Crown founding record, on Lissandra Marox" },
  { quote: "She does not describe Necrolyte as power. She describes it as a property of existence that everyone else refuses to engage with honestly.", attribution: "Eye of the Nightingale intelligence file, on Lissandra Marox" },
  { quote: "The Underworld harvests. Nekapolis consumes. Lissandra calls the distinction a matter of philosophy and declines to elaborate.", attribution: "Eye of the Nightingale intelligence file, on Lissandra Marox" },
  // Ariel, Arch Seraph of Valor
  { quote: "Sent to end Lucifer's Crusade. Ended it. Three years, countless dead, the optimal solution available was an arrest. The Silver City called it resolved. Ariel has not used that word.", attribution: "Domain of Valor internal record, on Ariel" },
  { quote: "Valor is not the same as being correct. The Silver City has never formally asked its Arch Seraphs to examine that distinction. Ariel has noticed.", attribution: "Domain of Valor internal record, on Ariel" },
  // Iofiel, Arch Seraph of Hope
  { quote: "Descended to the Material Realm to restore faith in the Silver City. The mortals who had lost the most faith had lost it for the most understandable reasons. The report back to the Silver City was carefully worded.", attribution: "Domain of Hope field record, on Iofiel" },
  { quote: "Hope is not optimism. Optimism requires no evidence. Hope requires maintaining something in spite of the evidence. Iofiel has seen the evidence.", attribution: "Iofiel, Arch Seraph of Hope" },
  // Zarkenko Darogo
  { quote: "The Tranquil Circle has been attempting to regulate his court for longer than most mortal civilizations have existed. He finds this the most consistently entertaining thing in any realm.", attribution: "Tranquil Circle internal advisory, on Zarkenko Darogo" },
  { quote: "He does not lie. He arranges truths until they face the wrong direction.", attribution: "Tranquil Circle internal advisory, on Zarkenko Darogo" },
  { quote: "Asked once what he wanted from Verlantis, Zarkenko said consequences. Nobody asked a follow-up question.", attribution: "Tranquil Circle senior envoy, on Zarkenko Darogo" },
  // Sultana Alvahra Rheiss
  { quote: "The Scorch Fiery Badlands have no mercy built into them. The Ruby Cerberus did not develop resilience. They developed competence. The distinction matters to them.", attribution: "Ruby Cerberus merchant guild charter, on Sultana Alvahra Rheiss" },
  { quote: "Arrabii was the grand merchant capital of her people. Gorlaya'Kasa destroyed it in a tantrum redirected there by political manipulation. The Sultana has noted that nobody responsible for that chain of events has been held accountable. She has noted it very quietly.", attribution: "Ruby Cerberus merchant guild record, on Sultana Alvahra Rheiss" },
  { quote: "Fresh water. Gemstones. Trust. In the Scorch Fiery Badlands all three are finite, all three are traded, and all three are guarded the same way.", attribution: "Sultana Alvahra Rheiss, Ruby Cerberus merchant guild charter" },
  // Lanathar
  { quote: "He did not come because the Silver City sent him. The Silver City had not yet decided. By the time it did, Lanathar was already in the Material Realm.", attribution: "Amber Hearth Starbound oral tradition, on Lanathar" },
  { quote: "The stars are not a memorial. That is the part the Starbound keep getting wrong.", attribution: "Attributed to Lanathar, Amber Hearth founding record" },
  // Griffin Dominiks
  { quote: "In charge of dismantling the Prometheans and the Amber Hearth simultaneously. Both factions believe they are protecting mortals. Both factions cause significant collateral damage protecting mortals. Dominiks finds the overlap instructive.", attribution: "Bastion of the Purgatory command record, on Griffin Dominiks" },
  { quote: "Lucifer returned. The Prometheans reactivated within the week. Thirty years of containment work, undone by a ritual inversion nobody predicted. Dominiks filed the report. It was not a short report.", attribution: "Bastion of the Purgatory command record, Griffin Dominiks" },
  // Zariah Yagata
  { quote: "Seventeen volumes of aftermath documentation. Eighteenth in progress. The work does not get lighter. The handwriting gets steadier. She is not sure whether that is professional development or something else.", attribution: "Bastion of the Purgatory scribe record, on Zariah Yagata" },
  { quote: "She prefers to be on site. She hates engaging in combat. These two preferences are in constant conflict and the conflict has never been resolved.", attribution: "Bastion of the Purgatory personnel record, on Zariah Yagata" },
  // Cedric de Noirterre
  { quote: "The Alabaster Hunger infected hundreds before Lucinda stopped it. The Undying Umbral severed the connection to every one of them. Whether that constitutes freedom or abandonment depends on which direction the question faces.", attribution: "Cedric de Noirterre, Verandin Liberty resistance archive" },
  { quote: "His house fell. He sought Lucinda's help. He found someone attempting to end a war older than every noble house that ever existed. His house stopped feeling like the priority fairly quickly.", attribution: "Verandin Liberty resistance archive, on Cedric de Noirterre" },
  { quote: "The vampiric curse left marble veins across his skin and a cold stillness in his eyes. Yisces designed it to hollow things out from the inside. Lucinda interrupted the process. Cedric de Noirterre has not decided yet whether to be grateful.", attribution: "Eye of the Nightingale field record, on Cedric de Noirterre" },
  // Kussoth
  { quote: "Every other Elemental Lord calls the alliances reckless. Kussoth calls their neutrality a comfort they cannot afford to examine honestly. Neither side has changed the other's position in several thousand years.", attribution: "Primordial Plane record, on Kussoth" },
  { quote: "Connected to the Charred Children, to a Celestial order, to fiendish powers within the Underworld simultaneously. Asked about the contradictions, Kussoth has never found them contradictory.", attribution: "Veil Siphoner remnant archive, on Kussoth" },
  // Lucinda Morningstar
  { quote: "She studied what her father burned through. She built what he couldn't imagine. She vanished before anyone could take it from her. I think that was the point.", attribution: "Unnamed Lunare Patron citizen, on Lucinda Morningstar" },
  { quote: "Lucinda Morningstar refused redemption from the Silver City, refused to be claimed by the Underworld, refused to stop working on a problem everyone else had given up on. They called her dangerous. She called it Tuesday.", attribution: "Eye of the Nightingale field record, on Lucinda Morningstar" },
  { quote: "She scattered her life's work across the world to keep it out of the wrong hands. Every wrong pair of hands that found it anyway proved she was right to be afraid.", attribution: "Lunare Patron archivist, on Lucinda Morningstar" },
  { quote: "Most people who vanish in Verlantis are dead. Lucinda Morningstar is the exception that makes that fact considerably worse.", attribution: "Bastion of the Purgatory intelligence report, EC4" },
  // Lucifer Morningstar
  { quote: "They stripped him of immortality as a punishment. He took it as a revelation. The gods have not publicly addressed the difference.", attribution: "Verandin Liberty resistance archivist, on Lucifer Morningstar" },
  // --- Nameless NPCs ---
  { quote: "Nobody warned us. Nobody asked us. One morning the sky cracked open and the Eternal Conflict had opinions about our continent.", attribution: "Unnamed farmer, Aavarhi border region" },
  { quote: "The gods intervene with overwhelming force and absolute certainty. I have seen that certainty. It looks exactly like rubble.", attribution: "Bastion of the Purgatory field medic" },
  { quote: "Deamoth crossed the Dread Sea and we crashed an entire city into his army to stop him. Halo doesn't exist anymore. He does. Make of that what you will.", attribution: "Star Gazer salvager, Tarcia wreckage site" },
  { quote: "My father died in Lucifer's Crusade. Not fighting demons. Caught in the middle of an angel's idea of protection.", attribution: "Bastion recruit, EC2 descendants registry" },
  { quote: "I lost my brother to Necrolyte. There was no body. There was no soul to mourn. There was just the space where he used to be.", attribution: "Unnamed Fragmented, Lunare haven" },
  { quote: "They stole a realm from the wreckage of a divine war and built something worse inside it. The terrifying part isn't that they did it. It's that it worked.", attribution: "Veil Siphoner remnant scholar" },
  { quote: "Forty percent of Aavarhi is a demon's rotting corpse. And somehow that's not the worst thing happening right now.", attribution: "Unnamed cartographer, EC4 survey notes" },
  { quote: "The Prometheans fight for free will. The Bastion fights for mortal survival. They clash constantly because protecting something and liberating it are not always the same thing.", attribution: "Unnamed scholar, Tessibloom Academy" },
  { quote: "Something cut every outworldly connection to the Material Realm simultaneously. It lasted four seconds. Every realm felt it. None of them have stopped thinking about it since.", attribution: "Tranquil Circle senior envoy, internal dispatch" },
  { quote: "Lucifer is free. The Corruption Plains are mutating. There is a power somewhere that briefly made the gods go quiet. I am choosing to interpret this as progress.", attribution: "Ruby Cerberus caravan captain, overheard in a Roussi tavern" },
  { quote: "EC4 has barely started and we have already freed an imprisoned angel, grown a Titan tree in a demon's corpse, and discovered a weapon that scares every realm simultaneously. I've been a Bastion soldier for thirty years. I have never been this tired.", attribution: "Bastion veteran, 78th Battalion" },
  { quote: "The gods made the rules. The mortals paid the fines.", attribution: "Unnamed dockworker, Salisport" },
  { quote: "Celestial or Fiendish, the rubble looks the same from underneath.", attribution: "Unnamed Bastion field surgeon" },
  { quote: "The Eternal Conflict has been going on longer than recorded history. Encouraging, isn't it.", attribution: "Unnamed Tessibloom Academy lecturer" },
  { quote: "The Fallen chose mortality as punishment. The rest of us didn't get a choice.", attribution: "Unnamed Verandin Liberty citizen" },
  { quote: "Immortals call it the Eternal Conflict. We call it Tuesday.", attribution: "Unnamed Ruby Cerberus trader" },
  { quote: "We are not a stage. We are an aftermath. And we are still here.", attribution: "Bastion of the Purgatory oath ceremony, traditional closing" },
  { quote: "Every era ends. Every kingdom falls. Mortalkind endures anyway. No deity has figured out why.", attribution: "Unnamed Eye of the Nightingale senior archivist" },
  { quote: "The rest of this era's history has not yet been written. That is either the most hopeful or most terrifying sentence in this entire record. I genuinely cannot decide.", attribution: "Verlantis Encyclopedia, closing note, EC4 entry" },
];

function Btn({ style, variant, size, onClick, children, disabled }) {
  const base = { padding: size === "sm" ? "5px 12px" : "7px 16px", fontSize: size === "sm" ? 12 : 13, borderRadius: 8, border: `1px solid ${T.border}`, background: T.bg, cursor: disabled ? "default" : "pointer", fontWeight: 500, color: T.ink, fontFamily: T.fBody, lineHeight: 1.35 };
  const v = variant === "primary" ? { background: T.purple, color: T.headerFg, border: "none" }
          : variant === "danger"  ? { background: T.danger, color: "#fff", border: "none" } : {};
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...v, ...style, opacity: disabled ? 0.4 : 1 }}>{children}</button>;
}
function Modal({ title, onClose, children, width = 420 }) {
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(26,16,53,0.65)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:16 }}>
      <div style={{ background:T.bg,borderRadius:12,border:`1.5px solid ${T.border}`,boxShadow:"0 16px 48px rgba(26,16,53,0.38)",width,maxWidth:"96%",maxHeight:"90vh",display:"flex",flexDirection:"column",overflow:"hidden" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 20px",borderBottom:`1.5px solid ${T.border}`,background:T.surface,borderRadius:"10px 10px 0 0",flexShrink:0 }}>
          <span style={{ fontWeight:700,fontSize:15,fontFamily:T.fHead,color:T.ink,letterSpacing:"0.05em" }}>{title}</span>
          {onClose && <button onClick={onClose} style={{ background:"none",border:"none",cursor:"pointer",fontSize:18,color:T.muted,padding:"0 0 0 10px",lineHeight:1 }}>✕</button>}
        </div>
        <div style={{ padding:20,overflowY:"auto",flex:1 }}>{children}</div>
      </div>
    </div>
  );
}
function Field({ label, children }) {
  return <div style={{ marginBottom: 12 }}><label style={{ fontSize: 12, color: T.muted, display: "block", marginBottom: 4, fontFamily: T.fBody }}>{label}</label>{children}</div>;
}
function FilePicker({ onFile, label = "Upload" }) {
  const ref = useRef(null);
  return (
    <>
      <input ref={ref} type="file" accept="image/*" style={{ position: "fixed", opacity: 0, pointerEvents: "none", width: 1, height: 1, top: -9999 }}
        onChange={e => { const f = e.target.files[0]; if (f) onFile(f); e.target.value = ""; }} />
      <Btn size="sm" variant="primary" onClick={e => { e.stopPropagation(); ref.current?.click(); }}>{label}</Btn>
    </>
  );
}
function readFile(file) {
  return new Promise(res => { const r = new FileReader(); r.onload = e => res(e.target.result); r.readAsDataURL(file); });
}

// ── Marker Pin ────────────────────────────────────────────────────────────────
// displayName: first letter is shown inside the pin (falls back to user_name then "?")
function MarkerPin({ marker, scale, isOwner, isGM, onTap, onDragStart, displayName, memberColor }) {
  // memberColor comes from live members state so colour changes sync instantly without a refresh
  const color = memberColor || marker.player_color || "#378ADD";
  const initial = (displayName || marker.user_name || "?")[0].toUpperCase();
  const size = Math.max(20, 24 / scale);
  const fontSize = Math.max(8, 11 / scale);

  return (
    <div
      onMouseDown={e => { if (isOwner) { e.stopPropagation(); onDragStart(e, marker); } }}
      onTouchStart={e => { if (isOwner) { e.stopPropagation(); e.preventDefault(); onDragStart(e, marker); } }}
      onClick={e => { e.stopPropagation(); if (!isOwner) onTap(marker); }}
      style={{ position: "absolute", left: marker.x - size/2, top: marker.y - size, width: size, height: size, cursor: isOwner ? "grab" : "pointer", zIndex: 25 }}
    >
      <div style={{ width: size, height: size, borderRadius: "50% 50% 50% 0", transform: "rotate(-45deg)", background: color, border: `${Math.max(1.5, 2/scale)}px solid white`, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ transform: "rotate(45deg)", color: "white", fontWeight: 800, fontSize, fontFamily: T.fMap, lineHeight: 1, textShadow: "0 0 4px #000, 0 1px 3px #000" }}>{initial}</span>
      </div>
    </div>
  );
}

// ── POI Pin ───────────────────────────────────────────────────────────────────
// POIPin uses fixed map-coordinate sizes (no scale prop) so React.memo works effectively.
// Opacity is handled by the parent poiLayerRef div — no re-render needed per zoom step.
const POIPin = memo(function POIPin({ poi, isGM, onTap, onDragStart, resolvedIconUrl }) {
  const ss = getSizeScale(poi.size);
  const size = 32 * ss;          // fixed map-coordinate size
  const bw = 2;                  // fixed border width
  const cc = getCatColor(poi.category);
  const borderStyle = (isGM && !poi.revealed) ? "dashed" : "solid";
  const iconUrl = poi.icon_url || resolvedIconUrl || "";
  const isPortal = poi.poi_type === "portal";
  const isGate   = poi.category === "gate";

  if (isPortal) {
    const d = size * 0.95;
    return (
      <div
        onMouseDown={e => { if (isGM) { e.stopPropagation(); onDragStart(e, poi); } }}
        onTouchStart={e => { if (isGM) { e.stopPropagation(); onDragStart(e, poi); } }}
        onClick={e => { e.stopPropagation(); onTap(poi); }}
        style={{ position:"absolute", left:poi.x-d/2, top:poi.y-d, width:d, height:d, cursor:isGM?(poi.locked?"pointer":"grab"):"pointer", zIndex:22 }}
      >
        <div style={{ position:"absolute", inset:-d*0.3, borderRadius:"50%", border:`${bw}px solid ${cc}`, animation:"portalPulse 2s ease-in-out infinite", pointerEvents:"none" }} />
        <div style={{ position:"absolute", inset:0, transform:"rotate(45deg)", background:cc+"33", border:`${bw}px ${borderStyle} ${cc}`, boxSizing:"border-box" }}>
          {iconUrl && <img src={iconUrl} alt={poi.name} draggable={false} style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"contain", transform:"rotate(-45deg)", pointerEvents:"none" }} />}
        </div>
        {!iconUrl && (
          <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
            <span style={{ fontSize:size*0.35, lineHeight:1, pointerEvents:"none" }}>⛩</span>
          </div>
        )}
      </div>
    );
  }

  if (isGate) {
    return (
      <div
        onMouseDown={e => { if (isGM) { e.stopPropagation(); onDragStart(e, poi); } }}
        onTouchStart={e => { if (isGM) { e.stopPropagation(); onDragStart(e, poi); } }}
        onClick={e => { e.stopPropagation(); onTap(poi); }}
        style={{ position:"absolute", left:poi.x-size/2, top:poi.y-size, width:size, height:size, cursor:isGM?(poi.locked?"pointer":"grab"):"pointer", zIndex:21, borderRadius:4, border:`${bw}px ${borderStyle} ${cc}`, boxSizing:"border-box", overflow:"hidden", background:cc+"59" }}
      >
        {iconUrl
          ? <img src={iconUrl} alt={poi.name} draggable={false} style={{ width:"100%", height:"100%", objectFit:"contain", display:"block", pointerEvents:"none" }} />
          : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center" }}>
              <span style={{ color:"white", fontWeight:700, fontSize:14*ss, lineHeight:1, pointerEvents:"none" }}>⬛</span>
            </div>
        }
      </div>
    );
  }

  return (
    <div
      onMouseDown={e => { if (isGM) { e.stopPropagation(); onDragStart(e, poi); } }}
      onTouchStart={e => { if (isGM) { e.stopPropagation(); onDragStart(e, poi); } }}
      onClick={e => { e.stopPropagation(); onTap(poi); }}
      style={{ position:"absolute", left:poi.x-size/2, top:poi.y-size, width:size, height:size, cursor:isGM?(poi.locked?"pointer":"grab"):"pointer", zIndex:20, borderRadius:"50%", border:`${bw}px ${borderStyle} ${cc}`, boxSizing:"border-box", overflow:"hidden", background:cc+"59" }}
    >
      {iconUrl
        ? <img src={iconUrl} alt={poi.name} draggable={false} onDragStart={e=>e.preventDefault()} style={{ width:"100%", height:"100%", objectFit:"contain", display:"block", pointerEvents:"none" }} />
        : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center" }}>
            <span style={{ color:"white", fontWeight:700, fontSize:14*ss, lineHeight:1 }}>?</span>
          </div>
      }
    </div>
  );
});

// ── Profile Tab ───────────────────────────────────────────────────────────────
function ProfileTab({ user, members, myColor, takenColors, isGM, onColorChange, onSaveDisplayName, soundVolume, onVolumeChange, markers, activeMapId, markerLimit, onMarkerLimitChange, onKickPlayer, onLeaveCampaign }) {
  const me = members.find(m => m.user_id === user.id);
  const [displayName, setDisplayName] = useState(me?.display_name || "");
  const [saved, setSaved] = useState(false);
  const [kickTarget, setKickTarget] = useState(null);

  async function handleSave() {
    await onSaveDisplayName(displayName);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:16,color:T.ink,marginBottom:20,letterSpacing:"0.04em" }}>Your Profile</div>

      {/* Display name */}
      <div style={{ padding:"14px 16px",background:T.surface,borderRadius:12,border:`1px solid ${T.border}`,marginBottom:16 }}>
        <Field label="Display Name">
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={displayName}
              onChange={e => { setDisplayName(e.target.value); setSaved(false); }}
              style={{ ...IS, flex: 1 }}
              placeholder={user.user_metadata?.full_name || user.email}
              onKeyDown={e => { if (e.key === "Enter") handleSave(); }}
            />
            <Btn variant="primary" onClick={handleSave}>{saved ? "✓ Saved" : "Save"}</Btn>
          </div>
          <div style={{ fontSize: 11, color: T.muted, marginTop: 5 }}>Shown on your map markers and in the players list.</div>
        </Field>
      </div>

      {/* Colour picker — players only */}
      {!isGM && (
        <div style={{ padding:"14px 16px",background:T.surface,borderRadius:12,border:`1px solid ${T.border}`,marginBottom:16 }}>
          <Field label="Your Colour">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
              {PLAYER_COLORS.map(c => {
                const isTaken = takenColors.includes(c);
                const isSelected = myColor === c;
                return (
                  <div key={c} onClick={() => !isTaken && onColorChange(c)}
                    title={isTaken ? "Taken by another player" : c}
                    style={{ width: 34, height: 34, borderRadius: "50%", background: c, border: isSelected ? `3px solid ${T.purple}` : isTaken ? "2px dashed #ccc" : `2px solid ${T.border}`, cursor: isTaken ? "not-allowed" : "pointer", opacity: isTaken ? 0.3 : 1, boxSizing: "border-box", position: "relative" }}>
                    {isTaken && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "rgba(0,0,0,0.4)" }}>✕</div>}
                    {isSelected && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: "white", textShadow: "0 0 4px rgba(0,0,0,0.7)" }}>✓</div>}
                  </div>
                );
              })}
            </div>
            {myColor && <div style={{ fontSize: 11, color: T.muted, marginTop: 8 }}>Selected: <span style={{ fontWeight: 700, color: myColor === "#FFFFFF" ? "#aaa" : myColor }}>{myColor}</span></div>}
          </Field>
        </div>
      )}

      {/* Sound volume */}
      <div style={{ padding:"14px 16px",background:T.surface,borderRadius:12,border:`1px solid ${T.border}`,marginBottom:16 }}>
        <Field label="Sound Effects Volume">
          <div style={{ display:"flex",alignItems:"center",gap:10,marginTop:4 }}>
            <span style={{ fontSize:18 }}>{soundVolume===0?"🔇":soundVolume<0.4?"🔉":"🔊"}</span>
            <input type="range" min={0} max={1} step={0.05} value={soundVolume} onChange={e=>onVolumeChange(Number(e.target.value))} style={{ flex:1 }} />
            <span style={{ fontSize:12,color:T.muted,minWidth:40,textAlign:"right" }}>{Math.round(soundVolume*100)}%</span>
          </div>
          <div style={{ fontSize:11,color:T.muted,marginTop:5 }}>Plays on announcements, revealed POIs, and NPC movements.</div>
        </Field>
      </div>

      {/* Account info */}
      <div style={{ padding:"14px 16px",background:T.surface,borderRadius:12,border:`1px solid ${T.border}`,marginBottom:16 }}>
        <div style={{ fontFamily:T.fHead,fontWeight:600,fontSize:13,color:T.ink,marginBottom:8,letterSpacing:"0.03em" }}>Account</div>
        <div style={{ fontSize:13,color:T.ink,fontWeight:500 }}>{user.user_metadata?.full_name || "—"}</div>
        <div style={{ fontSize:12,color:T.muted,marginTop:2 }}>{user.email}</div>
        <div style={{ display:"flex",alignItems:"center",gap:10,marginTop:8,flexWrap:"wrap" }}>
          <div style={{ fontSize:11,color:T.muted,padding:"3px 10px",background:isGM?`${T.gold}20`:T.bg,borderRadius:20,border:`1px solid ${isGM?`${T.gold}44`:T.border}`,color:isGM?T.goldDim:T.muted,fontWeight:600 }}>{isGM ? "👑 Game Master" : "⚔ Player"}</div>
          {!isGM && onLeaveCampaign && (
            <Btn size="sm" variant="danger" onClick={()=>{ if(window.confirm("Leave this campaign? Your markers will be removed.")) onLeaveCampaign(); }}>
              Leave Campaign
            </Btn>
          )}
        </div>
      </div>

      {/* Campaign roster — visible to everyone */}
      <div style={{ padding:"14px 16px",background:T.surface,borderRadius:12,border:`1px solid ${T.border}` }}>
        <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:12,flexWrap:"wrap" }}>
          <div style={{ fontFamily:T.fHead,fontWeight:600,fontSize:13,color:T.ink,flex:1,letterSpacing:"0.03em" }}>Campaign Roster</div>
          {isGM && (
            <div style={{ display:"flex",alignItems:"center",gap:8 }}>
              <span style={{ fontSize:11,color:T.muted }}>Marker limit:</span>
              <input type="number" min={0} max={50} value={markerLimit}
                onChange={e=>onMarkerLimitChange(Number(e.target.value))}
                style={{ width:56,padding:"3px 8px",borderRadius:6,border:`1px solid ${T.border}`,fontSize:12,background:"#fffbf2",color:T.ink,fontFamily:T.fBody }} />
            </div>
          )}
        </div>
        {members.length===0 && <p style={{ color:T.muted,fontSize:12,fontStyle:"italic" }}>No members yet.</p>}
        {members.map(m=>(
          <div key={m.user_id} style={{ display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:`0.5px solid ${T.border}` }}>
            <div style={{ width:28,height:28,borderRadius:"50%",background:m.player_color||T.border,border:`2px solid ${m.player_color||T.border}`,flexShrink:0 }} />
            <div style={{ flex:1,minWidth:0 }}>
              <div style={{ fontSize:13,fontWeight:600,color:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                {m.display_name || (m.role==="gm" ? "Game Master" : m.user_id===user.id ? "You" : "Unknown")}
                {m.user_id===user.id && <span style={{ marginLeft:6,fontSize:10,color:T.muted,fontStyle:"italic" }}>(you)</span>}
              </div>
              <div style={{ fontSize:11,color:T.muted }}>
                {m.role==="gm"?"Game Master":"Player"}
                {markers && activeMapId && <span> · {markers.filter(mk=>mk.user_id===m.user_id&&mk.map_id===activeMapId).length} markers</span>}
              </div>
            </div>
            {isGM && m.role!=="gm" && m.user_id!==user.id && onKickPlayer && (
              <Btn size="sm" variant="danger" onClick={()=>setKickTarget(m)}>Kick</Btn>
            )}
          </div>
        ))}
      </div>

      {/* Kick confirmation modal */}
      {kickTarget && (
        <div style={{ position:"fixed",inset:0,zIndex:9000,display:"flex",alignItems:"center",justifyContent:"center",padding:16,background:"rgba(10,5,20,0.75)" }} onClick={()=>setKickTarget(null)}>
          <div style={{ background:T.surface,borderRadius:16,padding:"24px 24px 20px",maxWidth:340,width:"100%",boxShadow:"0 8px 40px rgba(0,0,0,0.5)",border:`1px solid ${T.border}` }} onClick={e=>e.stopPropagation()}>
            <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:15,color:T.ink,marginBottom:8 }}>Remove Player?</div>
            <div style={{ fontSize:13,color:T.muted,marginBottom:20,lineHeight:1.5 }}>
              Remove <strong style={{ color:T.ink }}>{kickTarget.display_name || "this player"}</strong> from the campaign? Their markers will be deleted.
            </div>
            <div style={{ display:"flex",gap:10 }}>
              <button onClick={()=>{ onKickPlayer(kickTarget.user_id); setKickTarget(null); }} style={{ flex:1,padding:"9px 0",borderRadius:20,border:"none",background:T.danger,color:"#fff",fontFamily:T.fHead,fontSize:13,fontWeight:700,cursor:"pointer" }}>Remove Player</button>
              <button onClick={()=>setKickTarget(null)} style={{ flex:1,padding:"9px 0",borderRadius:20,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,fontSize:13,cursor:"pointer" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
function TutorialOverlay({ steps, stepIndex, onNext, onPrev, onExit }) {
  const [rect, setRect] = useState(null);
  useEffect(() => {
    const step = steps[stepIndex];
    if (!step) return;
    const el = document.querySelector(`[data-tut="${step.target}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    } else {
      setRect(null);
    }
  }, [stepIndex, steps]);
  const step = steps[stepIndex];
  if (!step) return null;
  const PAD = 8;
  const ringTop  = rect ? rect.top  - PAD : 0;
  const ringLeft = rect ? rect.left - PAD : 0;
  const ringW    = rect ? rect.width  + PAD * 2 : 0;
  const ringH    = rect ? rect.height + PAD * 2 : 0;
  const cardBase = {
    position: "absolute", left: "50%",
    width: "min(360px, 92vw)",
    background: "#1A0D35",
    border: "1.5px solid rgba(201,168,76,0.5)",
    borderRadius: 16,
    padding: "22px 24px",
    boxShadow: "0 12px 48px rgba(0,0,0,0.75)",
    pointerEvents: "all",
    WebkitFontSmoothing: "antialiased",
    MozOsxFontSmoothing: "grayscale",
  };
  const below = rect && (rect.top + rect.height + 200 < window.innerHeight);
  const cardStyle = !rect
    ? { ...cardBase, top: "50%", transform: "translate(-50%,-50%)" }
    : below
      ? { ...cardBase, top: rect.top + rect.height + PAD + 14, transform: "translateX(-50%)" }
      : { ...cardBase, top: rect.top - PAD - 14, transform: "translate(-50%,-100%)" };
  const fHead = "'Cinzel','Georgia',serif";
  const fBody = "system-ui,-apple-system,'Segoe UI',sans-serif";
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9000, pointerEvents: "none" }}>
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
        <defs>
          <mask id="tut-mask">
            <rect width="100%" height="100%" fill="white" />
            {rect && <rect x={ringLeft} y={ringTop} width={ringW} height={ringH} rx={8} fill="black" />}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.7)" mask="url(#tut-mask)" />
      </svg>
      {rect && (
        <div style={{ position: "absolute", top: ringTop, left: ringLeft, width: ringW, height: ringH, borderRadius: 8, border: "2px solid #C9A84C", boxShadow: "0 0 0 3px rgba(201,168,76,0.2), 0 0 24px rgba(201,168,76,0.35)", pointerEvents: "none", animation: "tutPulse 2s ease-in-out infinite" }} />
      )}
      <div style={cardStyle}>
        {/* Step counter */}
        <div style={{ fontSize: 11, color: "#C9A84C", letterSpacing: "0.14em", marginBottom: 10, textTransform: "uppercase", fontWeight: 700, fontFamily: fHead }}>
          Step {stepIndex + 1} of {steps.length}
        </div>
        {/* Title */}
        <div style={{ fontSize: 17, fontWeight: 700, color: "#FFE98A", letterSpacing: "0.04em", marginBottom: 10, lineHeight: 1.3, fontFamily: fHead }}>
          {step.title}
        </div>
        {/* Description */}
        <div style={{ fontSize: 14, color: "#FFFFFF", lineHeight: 1.7, fontFamily: fBody, marginBottom: 20, opacity: 0.92 }}>
          {step.desc}
        </div>
        {/* Buttons */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <button onClick={onExit} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", fontSize: 12, cursor: "pointer", fontFamily: fBody, padding: 0, letterSpacing: "0.02em" }}>
            ✕ Exit
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            {stepIndex > 0 && (
              <button onClick={onPrev} style={{ padding: "8px 18px", borderRadius: 20, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "#FFFFFF", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: fBody }}>
                ← Back
              </button>
            )}
            {stepIndex < steps.length - 1
              ? <button onClick={onNext} style={{ padding: "8px 20px", borderRadius: 20, border: "none", background: "#C9A84C", color: "#1A0D35", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: fBody }}>Next →</button>
              : <button onClick={onExit} style={{ padding: "8px 20px", borderRadius: 20, border: "none", background: "#C9A84C", color: "#1A0D35", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: fBody }}>Done ✓</button>
            }
          </div>
        </div>
      </div>
      <style>{`@keyframes tutPulse{0%,100%{opacity:1;box-shadow:0 0 0 3px rgba(201,168,76,0.2),0 0 24px rgba(201,168,76,0.35)}50%{opacity:0.85;box-shadow:0 0 0 6px rgba(201,168,76,0.1),0 0 32px rgba(201,168,76,0.2)}}`}</style>
    </div>
  );
}

function App() {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [campaigns, setCampaigns] = useState([]);
  const [activeCampaign, setActiveCampaign] = useState(null);
  const [memberRole, setMemberRole] = useState(null);
  const [myColor, setMyColor] = useState(null);
  const [members, setMembers] = useState([]);
  const [maps, setMaps] = useState([]);
  const [activeMapId, setActiveMapId] = useState(null);
  const [mapStack, setMapStack] = useState([]);
  const [pois, setPois] = useState([]);
  const [markers, setMarkers] = useState([]);
  const [categoryIcons, setCategoryIcons] = useState({});
  const [tab, setTab] = useState("map");
  const [libSubTab, setLibSubTab] = useState("maps");
  const [placingMode, setPlacingMode] = useState(null);
  // Note: ovSubTab removed — overlays/zones management merged into Library tab
  const [poiForm, setPoiForm] = useState(null);
  const [markerForm, setMarkerForm] = useState(null);
  const [openPOICard, setOpenPOICard] = useState(null);
  const [openMarkerCard, setOpenMarkerCard] = useState(null);
  const [poiCardClosing, setPoiCardClosing] = useState(null);   // id held during fade-out
  const [markerCardClosing, setMarkerCardClosing] = useState(null);
  const poiCloseTimer = useRef(null);
  const markerCloseTimer = useRef(null);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [mapInteracting, setMapInteracting] = useState(false);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [scrollSens, setScrollSens] = useState(1.0);
  const [libSort, setLibSort] = useState("name");
  const [showCampaignModal, setShowCampaignModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [newCampaignName, setNewCampaignName] = useState("");
  const [newCampaignSubHeader, setNewCampaignSubHeader] = useState("");
  const [newCampaignDescription, setNewCampaignDescription] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [markerLimit, setMarkerLimit] = useState(10);
  const [error, setError] = useState("");
  const [overlays, setOverlays] = useState([]);
  const [zones, setZones] = useState([]);
  const [overlaySettings, setOverlaySettings] = useState({});
  const [placingZonePoints, setPlacingZonePoints] = useState(null);
  const [zoneForm, setZoneForm] = useState(null);
  const [masterZoneOpacity, setMasterZoneOpacity] = useState(100);
  const [showLayerControls, setShowLayerControls] = useState(false);
  const [editingZonePoints, setEditingZonePoints] = useState(null); // { zoneId, points, originalPoints }
  const [fitScale, setFitScale] = useState(1);
  const [copiedCode, setCopiedCode] = useState(false);
  const [visFilter, setVisFilter] = useState({ categories: {}, players: {}, zones: {}, npcs: {}, portals: {} });
  const [showFilter, setShowFilter] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchPing, setSearchPing] = useState(null); // { x, y }
  const [searchMoving, setSearchMoving] = useState(false);
  const searchAnimRef = useRef(null);
  const [renamingOverlay, setRenamingOverlay] = useState(null); // { id, name }
  const [campInfoEdit, setCampInfoEdit] = useState(null); // { name, sub_header, description } or null
  const [poiFolders, setPoiFolders] = useState([]);
  const [mapTexts, setMapTexts] = useState([]);
  const [textForm, setTextForm] = useState(null); // null | { text, content, font_size, color, font_weight, fade_enabled, fade_invert, locked }
  const [folderCollapsed, setFolderCollapsed] = useState({}); // { folderId: true = collapsed }
  const [dragOverFolderId, setDragOverFolderId] = useState(null);
  const folderDragRef = useRef(null); // id of folder being dragged
  const [poiLibView, setPoiLibView] = useState("folders");    // "folders" | "name" | "type"
  const [folderForm, setFolderForm] = useState(null);         // null | { folder: obj|null, name: "" }
  const [movingPOI, setMovingPOI] = useState(null);           // poi id whose move-dropdown is open
  const [moveDropdownPos, setMoveDropdownPos] = useState(null); // { top|bottom, right } for fixed dropdown
  const [campDeleteConfirm, setCampDeleteConfirm] = useState(null); // campaign object to delete, or null
  const [mapDeleteConfirm, setMapDeleteConfirm] = useState(null);   // map id to delete, or null
  const [campaignLoading, setCampaignLoading] = useState(false);
  const [npcs, setNpcs] = useState([]);
  const [npcForm, setNpcForm] = useState(null);
  const [portalConfirm, setPortalConfirm] = useState(null); // { poi, targetMap }
  const [announcements, setAnnouncements] = useState([]);
  const [notifLog, setNotifLog] = useState([]);
  const [notifLimit, setNotifLimit] = useState(() => { try { return parseInt(localStorage.getItem("notif_limit")||"20")||20; } catch { return 20; } });
  const [toasts, setToasts] = useState([]);
  const [showBell, setShowBell] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [announceForm, setAnnounceForm] = useState(null);
  const [soundVolume, setSoundVolume] = useState(() => { try { return Number(localStorage.getItem("sound_volume") ?? 0.5); } catch { return 0.5; } });

  const mapRef = useRef(null);
  const dragRef = useRef({ active: false, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false });
  const placingRef = useRef(null);
  const transformRef = useRef(transform);
  const imgSizeRef = useRef(imgSize);
  const scrollSensRef = useRef(scrollSens);
  const poiDragState = useRef(null);
  const markerDragState = useRef(null);
  const realtimeRef = useRef(null);
  // Hold a ref to session so async callbacks always read the latest token
  const sessionRef = useRef(session);
  const zonesRef = useRef(zones);
  const addPointZoneRef = useRef(null);
  const zonePointDragRef = useRef(null);
  const npcDragState = useRef(null);
  const isPinchingRef = useRef(false); // true while 2-finger pinch is active
  const suppressClickRef = useRef(false); // true after a map drag — suppresses the next click on any node
  const textDragState = useRef(null);
  const pendingRevealRef = useRef({ revealed: [], hidden: [] }); // batch notification accumulator
  const revealTimerRef = useRef(null);
  // transformRef already declared above — mirrors transform state for use inside gesture handlers
  const mapTransformDivRef = useRef(null);                // ref to the map transform container div
  const poiLayerRef = useRef(null);                       // ref to the POI layer div for direct opacity update
  const fitScaleRef = useRef(0);                          // mirrors fitScale for use inside gesture handler
  const textFadeRef = useRef({});                         // { [id]: { fade_enabled, fade_invert } } for direct DOM updates
  const soundVolumeRef = useRef(0.5);
  const npcsRef = useRef([]);
  const pendingFocusRef = useRef(null); // { x, y } applied after map image loads
  const notifLimitRef = useRef(20);
  const [mapFadeState, setMapFadeState] = useState(null); // null | "covering" | "revealing"
  const mapFadeTimerRef = useRef(null);
  const [tutMode, setTutMode] = useState(null); // "campaign" | "player" | "gm" | null
  const [tutStep, setTutStep] = useState(0);

  const CAMPAIGN_STEPS = [
    { target: "tut-campaigns-label", title: "Your Campaigns", desc: "All campaigns you belong to appear here — ones you manage as GM and ones you've joined as a player." },
    { target: "tut-create-btn",      title: "Create a Campaign", desc: "Start a new campaign as GM. You can own up to 5 campaigns at once." },
    { target: "tut-join-btn",        title: "Join a Campaign", desc: "Got a campaign ID from your GM? Paste it here to join their world as a player." },
  ];
  const PLAYER_STEPS = [
    { target: "tut-back-btn",    title: "Back to Campaigns",  desc: "Use the arrow to return to your campaign list at any time." },
    { target: "tut-role-badge",  title: "Your Role",          desc: "You're a Player in this campaign. Your GM decides what locations are revealed to you on the map." },
    { target: "tut-bell",        title: "Notifications",      desc: "New POI discoveries, GM announcements, and world events show up here in real time." },
    { target: "tut-tab-map",     title: "The Map",            desc: "Select this tab to explore the world. Tap or click any revealed POI icon to read its details." },
    { target: "tut-search",      title: "Search",             desc: "Use the search bar to find anything on the map. Type a POI or NPC name then press Enter (or tap Go on mobile) to jump straight to it. You can also type a category like \"Merchants\" or \"Inns\" to filter visible POIs by type." },
    { target: "tut-marker-btn",  title: "Your Markers",       desc: "Drop a personal pin anywhere on the map to bookmark a location. Only you can see your own markers — use them freely." },
  ];
  const GM_STEPS = [
    { target: "tut-back-btn",      title: "Back to Campaigns",     desc: "Use the arrow to return to all your campaigns at any time." },
    { target: "tut-role-badge",    title: "You're the GM",         desc: "You have full control of this campaign — you decide what your players can see, where NPCs appear, and how the world unfolds." },
    { target: "tut-invite-bar",    title: "Invite Your Players",   desc: "Share this campaign ID with your players so they can join. Select Copy to copy it to your clipboard, then send it however you like." },
    { target: "tut-bell",          title: "Notifications",         desc: "Every event in your campaign — POI reveals, player activity, and announcements — is logged here in real time." },
    { target: "tut-tab-map",       title: "The Map",               desc: "Your main workspace. Select this tab to place POIs and NPCs, drag them around, and control what your players can see." },
    { target: "tut-poi-btn",       title: "Add POIs",              desc: "Select + POI, then tap or click anywhere on the map to place a Point of Interest. You control whether each POI is revealed to players." },
    { target: "tut-npc-btn",       title: "Add NPCs",              desc: "Select + NPC to place a character on the map. Set their name, status, and aura radius — and choose what players can see." },
    { target: "tut-search",        title: "Search",                desc: "Use the search bar to locate anything quickly. Type an exact POI or NPC name and press Enter (or tap Go on mobile) to fly the camera there. Type a category like \"Guilds\" or \"Security\" to filter all POIs of that type." },
    { target: "tut-marker-btn",    title: "Markers",               desc: "Drop quick personal pins on the map to mark positions for yourself. Useful for planning before a session." },
    { target: "tut-tab-library",   title: "Library",               desc: "Select this tab to manage all your maps, upload new ones, and organise image overlays and POI folders." },
    { target: "tut-tab-profile",   title: "Profile & Settings",    desc: "Select this tab to manage players, adjust campaign settings, set notification limits, and customise your own profile colour." },
  ];
  function tutNext() { setTutStep(s => s + 1); }
  function tutPrev() { setTutStep(s => s - 1); }
  function tutDone() {
    const key = tutMode === "campaign" ? "tut_campaign_v1" : `tut_${tutMode}_v1`;
    localStorage.setItem(key, "1");
    setTutMode(null);
    setTutStep(0);
  }

  useEffect(() => { placingRef.current = placingMode; }, [placingMode]);
  useEffect(() => { transformRef.current = transform; }, [transform]);
  useEffect(() => { imgSizeRef.current = imgSize; }, [imgSize]);
  // Keep fitScale current when window resizes (container changes size but fitScale state goes stale)
  useEffect(() => {
    if (!imgSize.w || !imgSize.h) return;
    const recompute = () => {
      if (!mapRef.current) return;
      const r = mapRef.current.getBoundingClientRect();
      if (!r.width || !r.height) return;
      setFitScale(Math.min(r.width / imgSize.w, r.height / imgSize.h, 1));
    };
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [imgSize.w, imgSize.h]);
  useEffect(() => { scrollSensRef.current = scrollSens; }, [scrollSens]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { zonesRef.current = zones; }, [zones]);
  useEffect(() => { soundVolumeRef.current = soundVolume; localStorage.setItem("sound_volume", String(soundVolume)); }, [soundVolume]);
  useEffect(() => { notifLimitRef.current = notifLimit; localStorage.setItem("notif_limit", String(notifLimit)); }, [notifLimit]);
  useEffect(() => { npcsRef.current = npcs; }, [npcs]);
  // Auto-trigger campaign tutorial on first visit
  useEffect(() => {
    if (!activeCampaign && user && !localStorage.getItem("tut_campaign_v1")) {
      setTutMode("campaign"); setTutStep(0);
    }
  }, [activeCampaign, user]);
  // Auto-trigger player/gm tutorial on first entry to a campaign
  useEffect(() => {
    if (activeCampaign && memberRole) {
      const key = `tut_${memberRole}_v1`;
      if (!localStorage.getItem(key)) { setTutMode(memberRole); setTutStep(0); }
    }
  }, [activeCampaign?.id, memberRole]);
  // Restore per-user overlay opacity/visibility and master zone opacity from localStorage
  useEffect(() => {
    if (!activeCampaign) return;
    try {
      const s = localStorage.getItem(`ov_settings_${activeCampaign.id}`);
      if (s) setOverlaySettings(JSON.parse(s));
      const mzo = localStorage.getItem(`zone_master_${activeCampaign.id}`);
      if (mzo !== null) setMasterZoneOpacity(Number(mzo));
    } catch {}
  }, [activeCampaign?.id]);

  // ── Auth ──
  useEffect(() => {
    async function init() {
      let sess = parseHashSession();
      if (sess) { localStorage.setItem("sb_session", JSON.stringify(sess)); window.history.replaceState(null, "", window.location.pathname); }
      else sess = getStoredSession();
      if (sess) {
        const refreshed = await refreshSession(sess.refresh_token);
        if (refreshed?.access_token) {
          sess = { access_token: refreshed.access_token, refresh_token: refreshed.refresh_token || sess.refresh_token };
          localStorage.setItem("sb_session", JSON.stringify(sess));
        }
        const u = await getUser(sess.access_token);
        if (u) { setSession(sess); setUser(u); } else { localStorage.removeItem("sb_session"); }
      }
      setLoading(false);
    }
    init();
    const t = setInterval(async () => {
      const s = getStoredSession(); if (!s?.refresh_token) return;
      const refreshed = await refreshSession(s.refresh_token);
      if (refreshed?.access_token) {
        const ns = { access_token: refreshed.access_token, refresh_token: refreshed.refresh_token || s.refresh_token };
        localStorage.setItem("sb_session", JSON.stringify(ns)); setSession(ns);
      }
    }, 50 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { if (user && session) loadCampaigns(); }, [user]);

  // ── Realtime ──
  useEffect(() => {
    if (!activeCampaign || !session) return;
    if (realtimeRef.current) realtimeRef.current.unsubscribe();
    realtimeRef.current = createRealtimeChannel(session.access_token, activeCampaign.id, {
      onPOI: (payload) => {
        if (payload.eventType === "INSERT") setPois(p => p.find(x => x.id === payload.new.id) ? p : [...p, payload.new]);
        if (payload.eventType === "UPDATE") setPois(p => {
          const exists = p.find(x => x.id === payload.new.id);
          return exists ? p.map(x => x.id === payload.new.id ? payload.new : x) : [...p, payload.new];
        });
        if (payload.eventType === "DELETE") setPois(p => p.filter(x => x.id !== (payload.old?.id)));
      },
      onMarker: (payload) => {
        if (payload.eventType === "INSERT") setMarkers(m => m.find(x => x.id === payload.new.id) ? m : [...m, payload.new]);
        if (payload.eventType === "UPDATE") setMarkers(m => m.map(x => x.id === payload.new.id ? { ...payload.new, player_color: payload.new.player_color } : x));
        if (payload.eventType === "DELETE") setMarkers(m => m.filter(x => x.id !== (payload.old?.id || payload.old_record?.id)));
      },
      // Real-time campaign changes: GM updating marker_limit propagates instantly to all players
      onCampaign: (payload) => {
        if (payload.eventType === "UPDATE") {
          setMarkerLimit(payload.new.marker_limit ?? 10);
          setActiveCampaign(prev => prev ? {
            ...prev,
            marker_limit: payload.new.marker_limit,
            name: payload.new.name ?? prev.name,
            sub_header: payload.new.sub_header ?? null,
            description: payload.new.description ?? null,
          } : prev);
        }
      },
      // Real-time colour + display name sync: when any player updates their profile, all clients see it immediately
      onOverlay: (payload) => {
        if (payload.eventType === "INSERT") setOverlays(p => p.find(x => x.id === payload.new.id) ? p : [...p, payload.new]);
        if (payload.eventType === "UPDATE") setOverlays(p => p.map(x => x.id === payload.new.id ? payload.new : x));
        if (payload.eventType === "DELETE") setOverlays(p => p.filter(x => x.id !== payload.old?.id));
      },
      onZone: (payload) => {
        if (payload.eventType === "INSERT") setZones(p => p.find(x => x.id === payload.new.id) ? p : [...p, payload.new]);
        // UPDATE: if zone not in state (was hidden, now revealed) treat as insert
        if (payload.eventType === "UPDATE") setZones(p => {
          const exists = p.find(x => x.id === payload.new.id);
          return exists ? p.map(x => x.id === payload.new.id ? payload.new : x) : [...p, payload.new];
        });
        if (payload.eventType === "DELETE") setZones(p => p.filter(x => x.id !== payload.old?.id));
      },
      onMember: (payload) => {
        if (payload.eventType === "UPDATE") {
          setMembers(m => m.map(x => x.user_id === payload.new.user_id
            ? { ...x, player_color: payload.new.player_color, display_name: payload.new.display_name }
            : x
          ));
          setUser(u => {
            if (u && payload.new.user_id === u.id) setMyColor(payload.new.player_color);
            return u;
          });
        }
        if (payload.eventType === "INSERT") setMembers(m => m.find(x => x.user_id === payload.new.user_id) ? m : [...m, payload.new]);
        if (payload.eventType === "DELETE") {
          const kickedId = payload.old?.user_id;
          setMembers(m => m.filter(x => x.user_id !== kickedId));
          // If current user was kicked, return them to the campaign list
          setUser(u => {
            if (u && kickedId === u.id) {
              setActiveCampaign(null);
              setCampaigns(prev => prev.filter(c => c.id !== payload.old?.campaign_id));
              if (realtimeRef.current) realtimeRef.current.unsubscribe();
              localStorage.removeItem("sb_last_campaign");
            }
            return u;
          });
        }
      },
      onNPC: (payload) => {
        if (payload.eventType === "INSERT") setNpcs(p => p.find(x => x.id === payload.new.id) ? p : [...p, payload.new]);
        if (payload.eventType === "UPDATE") setNpcs(p => {
          const exists = p.find(x => x.id === payload.new.id);
          return exists ? p.map(x => x.id === payload.new.id ? payload.new : x) : [...p, payload.new];
        });
        if (payload.eventType === "DELETE") setNpcs(p => p.filter(x => x.id !== payload.old?.id));
      },
      onAnnouncement: (payload) => {
        if (payload.eventType === "INSERT") {
          setAnnouncements(p => p.find(x => x.id === payload.new.id) ? p : [payload.new, ...p]);
          playSound("announcement");
          addToast(`📜 ${payload.new.title || "New Announcement"}`, "announcement");
          setUnreadCount(c => c + 1);
        }
        if (payload.eventType === "UPDATE") setAnnouncements(p => p.map(x => x.id === payload.new.id ? payload.new : x));
        if (payload.eventType === "DELETE") setAnnouncements(p => p.filter(x => x.id !== payload.old?.id));
      },
      onNotifLog: (payload) => {
        if (payload.eventType === "INSERT") {
          setNotifLog(prev => {
            if (prev.find(x => x.id === payload.new.id)) return prev;
            const next = [payload.new, ...prev];
            // Trim to limit (client side — GM's logNotif handles DB deletion for its own inserts)
            return next.slice(0, notifLimitRef.current);
          });
          if (memberRole !== "gm" && payload.new.type !== "announcement") {
            setUnreadCount(c => c + 1);
            const soundType = payload.new.type === "poi_batch_revealed" ? "poi_revealed"
                            : payload.new.type === "poi_batch_hidden"   ? "poi_hidden"
                            : payload.new.type;
            playSound(soundType);
            const catLabel = payload.new.category ? ` · ${getCatLabel(payload.new.category)}` : "";
            const label = payload.new.type === "poi_revealed"       ? `📍 ${payload.new.title} revealed${catLabel}`
                        : payload.new.type === "poi_hidden"         ? `🙈 ${payload.new.title} hidden`
                        : payload.new.type === "poi_batch_revealed"  ? `📍 ${payload.new.message}`
                        : payload.new.type === "poi_batch_hidden"    ? `🙈 ${payload.new.message}`
                        : payload.new.type === "marker_placed"      ? `📌 ${payload.new.message || payload.new.title}`
                        : payload.new.type === "npc_moved"          ? `👤 ${payload.new.message || payload.new.title}`
                        : payload.new.message || payload.new.title || "Update";
            addToast(label, payload.new.type);
          }
        }
        if (payload.eventType === "DELETE") setNotifLog(p => p.filter(x => x.id !== payload.old?.id));
      },
      onMap: (payload) => {
        if (payload.eventType === "INSERT") setMaps(p => p.find(x => x.id === payload.new.id) ? p : [...p, payload.new]);
        // Merge rather than replace — preserves src/image if realtime payload omits it
        if (payload.eventType === "UPDATE") setMaps(p => p.map(x => x.id === payload.new.id ? { ...x, ...payload.new } : x));
        if (payload.eventType === "DELETE") setMaps(p => p.filter(x => x.id !== payload.old?.id));
      },
      onPOIFolder: (payload) => {
        // Dedup INSERT — saveFolder already adds optimistically, Realtime must not double-add
        if (payload.eventType === "INSERT") setPoiFolders(p => p.find(x => x.id === payload.new.id) ? p : [...p, payload.new]);
        if (payload.eventType === "UPDATE") setPoiFolders(p => p.map(f => f.id === payload.new.id ? payload.new : f));
        if (payload.eventType === "DELETE") setPoiFolders(p => p.filter(f => f.id !== payload.old?.id));
      },
      onMapText: (payload) => {
        if (payload.eventType === "INSERT") setMapTexts(p => p.find(x => x.id === payload.new.id) ? p : [...p, payload.new]);
        if (payload.eventType === "UPDATE") setMapTexts(p => p.map(t => t.id === payload.new.id ? payload.new : t));
        if (payload.eventType === "DELETE") setMapTexts(p => p.filter(t => t.id !== payload.old?.id));
      },
    });
    return () => { if (realtimeRef.current) realtimeRef.current.unsubscribe(); };
  }, [activeCampaign?.id, session?.access_token]);

  async function loadCampaigns() {
    try {
      const memberData = await dbSelect(session.access_token, "campaign_members", `user_id=eq.${user.id}&select=campaign_id,role,player_color,display_name`);
      if (!memberData.length) { setCampaigns([]); return; }
      const ids = memberData.map(m => m.campaign_id).join(",");
      const camps = await dbSelect(session.access_token, "campaigns", `id=in.(${ids})`);
      const loaded = camps.map(c => ({
        ...c,
        myRole: memberData.find(m => m.campaign_id === c.id)?.role,
        myColor: memberData.find(m => m.campaign_id === c.id)?.player_color
      }));
      setCampaigns(loaded);
      localStorage.removeItem("sb_last_campaign");
    } catch(e) { setError(e.message); }
  }

  async function loadCampaignData(camp, role) {
    localStorage.setItem("sb_last_campaign", camp.id);
    setActiveCampaign(camp); setMemberRole(role);
    setMarkerLimit(camp.marker_limit || 10);
    if (camp.notif_limit) setNotifLimit(camp.notif_limit);
    setCampaignLoading(true);
    try {
      // Single RPC replaces 11 separate REST round-trips. Maps are returned WITHOUT
      // their src blob — the active map's src is fetched lazily by loadMapSrc().
      const res = await fetch(`${SUPA_URL}/rest/v1/rpc/load_campaign_data`, {
        method: "POST", headers: hdrs(session.access_token),
        body: JSON.stringify({ p_campaign_id: camp.id })
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to load campaign");
      const d = await res.json();
      const mapsData = d.maps || [];
      const main = mapsData.find(m => m.is_main) || mapsData[0];
      // Pre-fetch the main map's image src before setting any state so the first
      // render already has the image — eliminates the multi-map flash on load.
      let mapsWithSrc = mapsData;
      if (main) {
        try {
          const rows = await dbSelect(session.access_token, "maps", `id=eq.${main.id}&select=id,src`);
          if (rows?.[0]?.src) {
            mapsWithSrc = mapsData.map(m => m.id === main.id ? { ...m, src: rows[0].src } : m);
          }
        } catch { /* non-fatal — image will load via onImgLoad fallback */ }
      }
      // All state updates batched atomically in one React render (React 18 auto-batching)
      // Fetch poi_folders separately (not in the RPC yet)
      let foldersData = [], textsData = [];
      try { foldersData = await dbSelect(session.access_token, "poi_folders", `campaign_id=eq.${camp.id}&order=sort_order.asc`); } catch {}
      try { textsData = await dbSelect(session.access_token, "map_texts", `campaign_id=eq.${camp.id}`); } catch {}
      setMaps(mapsWithSrc); setPois(d.pois || []); setMarkers(d.markers || []);
      setMembers(d.members || []);
      setOverlays(d.overlays || []); setZones(d.zones || []); setNpcs(d.npcs || []);
      setAnnouncements(d.announcements || []); setNotifLog(d.notification_log || []);
      setCategoryIcons(d.category_icons || {}); setPoiFolders(foldersData); setMapTexts(textsData);
      const me = (d.members || []).find(m => m.user_id === user.id);
      setMyColor(me?.player_color || null);
      if (main) setActiveMapId(main.id);
      if (!me?.player_color && role !== "gm") setShowColorPicker(true);
    } catch(e) { setError(e.message); }
    finally { setCampaignLoading(false); }
  }

  // Lazily fetches just the src URL/blob for one map and patches it into state.
  // Called when the active map changes so we never transfer unused image data.
  async function loadMapSrc(mapId) {
    try {
      const rows = await dbSelect(session.access_token, "maps", `id=eq.${mapId}&select=id,src`);
      if (rows?.[0]?.src) {
        setMaps(prev => prev.map(m => m.id === mapId ? { ...m, src: rows[0].src } : m));
      }
    } catch { /* non-fatal — map will show broken image, user can retry */ }
  }

  async function chooseColor(color) {
    const taken = members.find(m => m.player_color === color && m.user_id !== user.id);
    if (taken) { setError("That colour is already taken by another player. Please choose a different one."); return; }
    try {
      await fetch(`${SUPA_URL}/rest/v1/campaign_members?campaign_id=eq.${activeCampaign.id}&user_id=eq.${user.id}`, {
        method: "PATCH", headers: hdrs(session.access_token), body: JSON.stringify({ player_color: color })
      });
      setMyColor(color);
      setMembers(prev => prev.map(m => m.user_id === user.id ? { ...m, player_color: color } : m));
      setShowColorPicker(false);
      setError("");
    } catch(e) { setError(e.message); }
  }

  async function kickPlayer(userId) {
    if (userId === user.id) return;
    try {
      await fetch(`${SUPA_URL}/rest/v1/campaign_members?campaign_id=eq.${activeCampaign.id}&user_id=eq.${userId}`, {
        method: "DELETE", headers: hdrs(session.access_token)
      });
      // DB trigger (trg_clean_on_member_remove) deletes the player's markers automatically.
      setMembers(prev => prev.filter(m => m.user_id !== userId));
      setMarkers(prev => prev.filter(m => m.user_id !== userId));
    } catch(e) { setError(e.message); }
  }

  async function leaveCampaign() {
    if (!activeCampaign) return;
    try {
      const res = await fetch(`${SUPA_URL}/rest/v1/rpc/leave_campaign`, {
        method: "POST", headers: hdrs(session.access_token),
        body: JSON.stringify({ p_campaign_id: activeCampaign.id })
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.message || "Could not leave campaign."); }
      // Return to campaign list
      if (realtimeRef.current) realtimeRef.current.unsubscribe();
      setActiveCampaign(null); setMemberRole(""); setMembers([]); setMaps([]); setPois([]);
      setMarkers([]); setZones([]); setNpcs([]); setOverlays([]);
      setAnnouncements([]); setNotifLog([]); setTab("map");
      await loadCampaigns();
    } catch(e) { setError(e.message || "Could not leave campaign."); }
  }

  async function deleteCampaign(camp) {
    try {
      const res = await fetch(`${SUPA_URL}/rest/v1/rpc/delete_campaign`, {
        method: "POST", headers: hdrs(session.access_token),
        body: JSON.stringify({ p_campaign_id: camp.id })
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.message || "Failed to delete campaign."); }
      setCampDeleteConfirm(null);
      // Remove from campaign list
      setCampaigns(prev => prev.filter(c => c.id !== camp.id));
      // If currently inside the deleted campaign, return to the list
      if (activeCampaign?.id === camp.id) {
        if (realtimeRef.current) realtimeRef.current.unsubscribe();
        setActiveCampaign(null); setMemberRole(""); setMembers([]); setMaps([]); setPois([]);
        setMarkers([]); setZones([]); setNpcs([]); setOverlays([]);
        setAnnouncements([]); setNotifLog([]); setTab("map");
        localStorage.removeItem("sb_last_campaign");
      }
    } catch(e) { setError(e.message); setCampDeleteConfirm(null); }
  }

  async function saveDisplayName(name) {
    try {
      await fetch(`${SUPA_URL}/rest/v1/campaign_members?campaign_id=eq.${activeCampaign.id}&user_id=eq.${user.id}`, {
        method: "PATCH", headers: hdrs(session.access_token), body: JSON.stringify({ display_name: name.trim() })
      });
      setMembers(prev => prev.map(m => m.user_id === user.id ? { ...m, display_name: name.trim() } : m));
    } catch(e) { setError(e.message); }
  }

  // ── Overlay settings (per-user, stored in localStorage) ──────────────────────
  function setOverlaySetting(id, key, value) {
    setOverlaySettings(prev => {
      const cur = prev[id] || { opacity: 80, visible: true };
      const next = { ...prev, [id]: { ...cur, [key]: value } };
      if (activeCampaign) localStorage.setItem(`ov_settings_${activeCampaign.id}`, JSON.stringify(next));
      return next;
    });
  }

  // ── Personal visibility filter (per-user, does not affect server reveal/hide) ─
  function isVisible(type, id) {
    return visFilter[type]?.[id] !== false;
  }
  function setVis(type, id, show) {
    setVisFilter(prev => ({ ...prev, [type]: { ...prev[type], [id]: show } }));
  }
  function setAllVisible(show) {
    const cats = {}; CATEGORIES.forEach(c => { cats[c.id] = show; });
    const players = {}; members.forEach(m => { players[m.user_id] = show; });
    const zns = {}; mapZones.forEach(z => { zns[z.id] = show; });
    const npcMap = {}; mapNPCs.forEach(n => { npcMap[n.id] = show; });
    const portMap = {}; mapPOIs.filter(p=>p.poi_type==="portal").forEach(p => { portMap[p.id] = show; });
    setVisFilter({ categories: cats, players: players, zones: zns, npcs: npcMap, portals: portMap });
    mapOverlays.forEach(ov => setOverlaySetting(ov.id, "visible", show));
  }

  async function saveOverlayName() {
    if (!renamingOverlay) return;
    const name = renamingOverlay.name.trim();
    if (!name) return;
    try {
      await dbUpdate(session.access_token, "overlays", renamingOverlay.id, { name });
      setOverlays(prev => prev.map(o => o.id === renamingOverlay.id ? { ...o, name } : o));
      setRenamingOverlay(null);
    } catch(e) { setError(e.message); }
  }

  async function saveCampaignInfo() {
    if (!campInfoEdit) return;
    const name = campInfoEdit.name.trim();
    if (!name) return;
    const sub_header = campInfoEdit.sub_header.trim() || null;
    const description = campInfoEdit.description.trim() || null;
    try {
      await dbUpdate(session.access_token, "campaigns", activeCampaign.id, { name, sub_header, description });
      const updated = { ...activeCampaign, name, sub_header, description };
      setActiveCampaign(updated);
      setCampaigns(prev => prev.map(c => c.id === activeCampaign.id ? { ...c, name, sub_header, description } : c));
      setCampInfoEdit(null);
    } catch(e) { setError(e.message); }
  }

  async function uploadOverlay(file) {
    let src;
    try { src = await uploadToStorage(session.access_token, file); } catch { src = await readFile(file); }
    try {
      const [ov] = await dbInsert(session.access_token, "overlays", {
        campaign_id: activeCampaign.id, map_id: activeMapId,
        name: file.name.replace(/\.[^.]+$/, ""), src,
        z_order: overlays.filter(o => o.campaign_id === activeCampaign.id && o.map_id === activeMapId).length
      });
      setOverlays(prev => [...prev, ov]);
    } catch(e) { setError(e.message); }
  }

  async function deleteOverlay(id) {
    try { await dbDelete(session.access_token, "overlays", id); setOverlays(prev => prev.filter(o => o.id !== id)); } catch(e) { setError(e.message); }
  }

  async function saveZone(form, imageFile) {
    let image_url = form.clearImage ? null : (form.zone?.image_url || null);
    if (imageFile) { try { image_url = await uploadToStorage(session.access_token, imageFile); } catch { image_url = await readFile(imageFile); } }
    const body = { name: form.name || "Zone", points: form.points, fill_color: form.fill_color || "#3498DB", image_url, opacity: form.opacity ?? 80, revealed: form.revealed || false, image_scale: form.image_scale ?? 100, image_repeat: form.image_repeat ?? false, broadcast_location: form.broadcast_location ?? true, animate_scroll: form.animate_scroll ?? false, scroll_speed: form.scroll_speed ?? 20 };
    try {
      if (form.zone) {
        await dbUpdate(session.access_token, "zones", form.zone.id, body);
        setZones(prev => prev.map(z => z.id === form.zone.id ? { ...z, ...body } : z));
      } else {
        const [nz] = await dbInsert(session.access_token, "zones", { ...body, campaign_id: activeCampaign.id, map_id: activeMapId });
        setZones(prev => [...prev, nz]);
      }
      setZoneForm(null);
    } catch(e) { setError(e.message); }
  }

  async function deleteZone(id) {
    try { await dbDelete(session.access_token, "zones", id); setZones(prev => prev.filter(z => z.id !== id)); setZoneForm(null); } catch(e) { setError(e.message); }
  }

  async function toggleZoneReveal(id, current) {
    try { await dbUpdate(session.access_token, "zones", id, { revealed: !current }); setZones(prev => prev.map(z => z.id === id ? { ...z, revealed: !current } : z)); } catch(e) { setError(e.message); }
  }

  // ── Zone waypoint drag-to-move ─────────────────────────────────────────────
  function startZonePointEdit(zone) {
    setZoneForm(null);
    setEditingZonePoints({ zoneId: zone.id, points: zone.points.map(p=>({...p})), originalPoints: zone.points.map(p=>({...p})) });
    setTab("map");
  }
  async function saveZonePoints() {
    if (!editingZonePoints) return;
    try {
      await dbUpdate(session.access_token, "zones", editingZonePoints.zoneId, { points: editingZonePoints.points });
      setZones(prev => prev.map(z => z.id === editingZonePoints.zoneId ? { ...z, points: editingZonePoints.points } : z));
      const z = zonesRef.current.find(z => z.id === editingZonePoints.zoneId);
      const updated = { ...z, points: editingZonePoints.points };
      setEditingZonePoints(null);
      setTimeout(() => setZoneForm({ zone: updated, name: updated.name, fill_color: updated.fill_color, opacity: updated.opacity, revealed: updated.revealed, points: updated.points }), 50);
    } catch(e) { setError(e.message); }
  }
  function cancelZonePointEdit() {
    const zId = editingZonePoints?.zoneId;
    setEditingZonePoints(null);
    const z = zonesRef.current.find(z => z.id === zId);
    if (z) setTimeout(() => setZoneForm({ zone: z, name: z.name, fill_color: z.fill_color, opacity: z.opacity, revealed: z.revealed, points: z.points.map(p=>({...p})) }), 50);
  }

  async function updateMarkerLimit(limit) {
    try {
      await fetch(`${SUPA_URL}/rest/v1/campaigns?id=eq.${activeCampaign.id}`, {
        method: "PATCH", headers: hdrs(session.access_token), body: JSON.stringify({ marker_limit: limit })
      });
      setMarkerLimit(limit);
    } catch(e) { setError(e.message); }
  }

  async function createCampaign() {
    if (!newCampaignName.trim()) return;
    try {
      // SECURITY DEFINER RPC handles both campaign + GM member inserts atomically,
      // bypassing the RLS catch-22 that blocks the campaign_members INSERT via REST.
      const res = await fetch(`${SUPA_URL}/rest/v1/rpc/create_campaign`, {
        method: "POST", headers: hdrs(session.access_token),
        body: JSON.stringify({
          p_name: newCampaignName.trim(),
          p_sub_header: newCampaignSubHeader.trim() || null,
          p_description: newCampaignDescription.trim() || null,
        })
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to create campaign");
      const camp = await res.json();
      setNewCampaignName(""); setNewCampaignSubHeader(""); setNewCampaignDescription("");
      setShowCampaignModal(false);
      await loadCampaigns(); loadCampaignData(camp, "gm");
    } catch(e) { setError(e.message); }
  }

  async function joinCampaign() {
    if (!joinCode.trim()) return;
    try {
      const camps = await dbSelect(session.access_token, "campaigns", `id=eq.${joinCode.trim()}`);
      if (!camps.length) { setError("Campaign not found. Check the ID and try again."); return; }
      // Use a SECURITY DEFINER RPC so kicked players (whose row was deleted) can rejoin
      // without hitting RLS restrictions on the campaign_members upsert.
      const rpcRes = await fetch(`${SUPA_URL}/rest/v1/rpc/join_campaign`, {
        method: "POST",
        headers: { ...hdrs(session.access_token) },
        body: JSON.stringify({ p_campaign_id: camps[0].id })
      });
      if (!rpcRes.ok) { const e = await rpcRes.json(); throw new Error(e.message || "Could not join campaign."); }
      setJoinCode(""); setShowJoinModal(false);
      await loadCampaigns(); loadCampaignData(camps[0], "player");
    } catch(e) { setError(e.message || "Could not join campaign."); }
  }

  const isGM = memberRole === "gm";
  // Pick a random quote once per page load (stable — useMemo with empty deps)
  const randomQuote = useMemo(() => VERLANTIS_QUOTES[Math.floor(Math.random() * VERLANTIS_QUOTES.length)], []);
  // ── Memoised derived data — only recompute when their dependencies change ──
  const currentMap     = useMemo(() => maps.find(m => m.id === activeMapId),                                          [maps, activeMapId]);
  const mapPOIs        = useMemo(() => pois.filter(p => p.map_id === activeMapId && (isGM || p.revealed)),            [pois, activeMapId, isGM]);
  const mapMarkers     = useMemo(() => markers.filter(m => m.map_id === activeMapId),                                 [markers, activeMapId]);
  const myMarkers      = useMemo(() => markers.filter(m => m.map_id === activeMapId && m.user_id === user?.id),       [markers, activeMapId, user?.id]);
  const takenColors    = useMemo(() => members.filter(m => m.user_id !== user?.id && m.player_color).map(m => m.player_color), [members, user?.id]);
  const mapOverlays    = useMemo(() => overlays.filter(o => o.map_id === activeMapId),                                [overlays, activeMapId]);
  const mapZones       = useMemo(() => zones.filter(z => z.map_id === activeMapId),                                   [zones, activeMapId]);
  const mapNPCs        = useMemo(() => npcs.filter(n => n.map_id === activeMapId && (isGM || n.is_visible_to_players)), [npcs, activeMapId, isGM]);
  const accessibleMaps = useMemo(() => maps.filter(m => isGM || m.is_main || m.player_accessible),                   [maps, isGM]);
  const mainMap        = useMemo(() => maps.find(m => m.is_main) || maps[0],                                          [maps]);
  // POIs fade out as user zooms toward the fit scale; fully visible at 2× fit zoom
  // 0 at or below fit zoom, linearly reaches 1 at 2× fit zoom. Explicit ≤ guard handles float drift.
  const poiOpacity = (fitScale > 0 && imgSize.w > 0)
    ? (transform.scale <= fitScale ? 0 : Math.min(1, (transform.scale - fitScale) / fitScale))
    : 1;

  // Keep refs in sync with state so gesture handlers can read current values without closures
  useEffect(() => { transformRef.current = transform; }, [transform]);
  useEffect(() => { fitScaleRef.current = fitScale; }, [fitScale]);
  useEffect(() => {
    const m = {};
    mapTexts.forEach(t => { m[t.id] = { fade_enabled: t.fade_enabled, fade_invert: t.fade_invert }; });
    textFadeRef.current = m;
  }, [mapTexts]);

  // Viewport culling — map-coordinate bounds of what's currently visible on screen.
  // Entities outside this rect are not rendered at all (saves DOM nodes on large maps).
  const viewportBounds = useMemo(() => {
    if (!mapRef.current) return null;
    const rect = mapRef.current.getBoundingClientRect();
    if (!rect || !rect.width) return null;
    const PAD = 120; // pixels of padding so pins don't pop in at the edge
    return {
      minX: (-transform.x - PAD) / transform.scale,
      maxX: (rect.width  - transform.x + PAD) / transform.scale,
      minY: (-transform.y - PAD) / transform.scale,
      maxY: (rect.height - transform.y + PAD) / transform.scale,
    };
  }, [transform]);

  function inViewport(x, y) {
    if (!viewportBounds) return true; // fallback: show everything
    return x >= viewportBounds.minX && x <= viewportBounds.maxX &&
           y >= viewportBounds.minY && y <= viewportBounds.maxY;
  }

  function fitToContainer(iw, ih) {
    const rect = mapRef.current?.getBoundingClientRect();
    if (!rect || !iw || !ih) return { x: 0, y: 0, scale: 1 };
    const scale = Math.min(rect.width / iw, rect.height / ih, 1);
    return { scale, x: (rect.width - iw * scale) / 2, y: (rect.height - ih * scale) / 2 };
  }
  function clamp(t, cw, ch, iw, ih) {
    if (!iw || !ih) return t;
    const sw = iw * t.scale, sh = ih * t.scale;
    // Allow panning slightly beyond the map edges for a softer feel
    const PAD = Math.min(120, Math.min(cw, ch) * 0.15);
    const minX = Math.min(0, cw - sw) - PAD, maxX = Math.max(0, cw - sw) + PAD;
    const minY = Math.min(0, ch - sh) - PAD, maxY = Math.max(0, ch - sh) + PAD;
    return { ...t, x: Math.min(maxX, Math.max(minX, t.x)), y: Math.min(maxY, Math.max(minY, t.y)) };
  }
  function getContainerRect() { return mapRef.current?.getBoundingClientRect() || { width: window.innerWidth, height: window.innerHeight, left: 0, top: 0 }; }
  function resetView() { const fit = fitToContainer(imgSize.w, imgSize.h); setTransform(fit); setFitScale(fit.scale); }

  function animateTo(targetX, targetY, targetScale) {
    if (searchAnimRef.current) cancelAnimationFrame(searchAnimRef.current);
    const rect = mapRef.current?.getBoundingClientRect() || { width: window.innerWidth, height: window.innerHeight };
    const destX = rect.width / 2 - targetX * targetScale;
    const destY = rect.height / 2 - targetY * targetScale;
    const start = { ...transformRef.current };
    const startTime = performance.now();
    const DURATION = 550;
    setSearchMoving(true);
    function step(now) {
      const t = Math.min(1, (now - startTime) / DURATION);
      const ease = 1 - Math.pow(1 - t, 3);
      setTransform({
        scale: start.scale + (targetScale - start.scale) * ease,
        x: start.x + (destX - start.x) * ease,
        y: start.y + (destY - start.y) * ease,
      });
      if (t < 1) { searchAnimRef.current = requestAnimationFrame(step); }
      else { setSearchMoving(false); }
    }
    searchAnimRef.current = requestAnimationFrame(step);
  }

  function handleSearch(q) {
    const query = (q || searchQuery).trim().toLowerCase();
    if (!query) { setSearchPing(null); return; }
    // Name match: POI first, then NPC
    const poiMatch = mapPOIs.find(p => p.name?.toLowerCase().includes(query));
    if (poiMatch) {
      setSearchPing({ x: poiMatch.x, y: poiMatch.y });
      const targetScale = Math.max(fitScale * 3, 1.5);
      animateTo(poiMatch.x, poiMatch.y, targetScale);
      return;
    }
    const npcMatch = mapNPCs.find(n => (isGM || n.show_name) && n.name?.toLowerCase().includes(query));
    if (npcMatch) {
      setSearchPing({ x: npcMatch.x, y: npcMatch.y });
      const targetScale = Math.max(fitScale * 3, 1.5);
      animateTo(npcMatch.x, npcMatch.y, targetScale);
      return;
    }
    // No name match — tag search handles visibility via rendering, no action needed
    setSearchPing(null);
  }
  function onImgLoad(e) {
    const w = e.target.naturalWidth, h = e.target.naturalHeight;
    setImgSize({ w, h });
    const fit = fitToContainer(w, h);
    setFitScale(fit.scale);
    if (pendingFocusRef.current) {
      const { x, y } = pendingFocusRef.current;
      pendingFocusRef.current = null;
      const targetScale = fit.scale * 2.5;
      const rect = mapRef.current?.getBoundingClientRect() || { width: window.innerWidth, height: window.innerHeight };
      setTransform({ scale: targetScale, x: rect.width/2 - x*targetScale, y: rect.height/2 - y*targetScale });
    } else {
      setTransform(fit);
    }
    // Reveal the map once its image has fully loaded (clears the transition overlay)
    clearTimeout(mapFadeTimerRef.current);
    setMapFadeState(prev => prev === "covering" ? "revealing" : null);
    mapFadeTimerRef.current = setTimeout(() => setMapFadeState(null), 380);
  }
  function toMapCoords(cx, cy) {
    const rect = getContainerRect(); const t = transformRef.current;
    return { x: (cx - rect.left - t.x) / t.scale, y: (cy - rect.top - t.y) / t.scale };
  }

  // ── POI drag ──
  function startPOIDrag(e, poi) {
    e.stopPropagation();
    if (poi.locked) return;
    // Guard: camera is being panned or pinch-zoomed — don't hijack the touch as a POI drag
    if (dragRef.current.active || isPinchingRef.current) return;
    if (imgSizeRef.current.w === 0) return;
    const touch0 = e.touches?.[0];
    const startCx = touch0 ? touch0.clientX : e.clientX;
    const startCy = touch0 ? touch0.clientY : e.clientY;
    const touchId = touch0 ? touch0.identifier : null; // track by id, not array index
    const scaleAtStart = transformRef.current.scale;
    poiDragState.current = { poiId: poi.id, originX: poi.x, originY: poi.y, startCx, startCy, touchId, scaleAtStart, moved: false, mapX: poi.x, mapY: poi.y };
    function onMove(ev) {
      if (!poiDragState.current) return;
      // Always use the same touch finger by identifier, not by index
      const touch = ev.touches
        ? Array.from(ev.touches).find(t => t.identifier === poiDragState.current.touchId) ?? ev.touches[0]
        : null;
      const cx = touch ? touch.clientX : ev.clientX;
      const cy = touch ? touch.clientY : ev.clientY;
      const dx = cx - poiDragState.current.startCx, dy = cy - poiDragState.current.startCy;
      // Euclidean threshold (8px) consistent with marker drag — prevents accidental saves from finger wobble
      if (Math.sqrt(dx * dx + dy * dy) > 8) poiDragState.current.moved = true;
      const nx = poiDragState.current.originX + dx / poiDragState.current.scaleAtStart;
      const ny = poiDragState.current.originY + dy / poiDragState.current.scaleAtStart;
      poiDragState.current.mapX = nx; poiDragState.current.mapY = ny;
      setPois(prev => prev.map(p => p.id === poiDragState.current?.poiId ? { ...p, x: nx, y: ny } : p));
    }
    function onUp() {
      if (!poiDragState.current) return;
      const { poiId, mapX, mapY, moved, originX, originY } = poiDragState.current;
      poiDragState.current = null;
      window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove); window.removeEventListener("touchend", onUp);
      if (!moved) {
        setPois(prev => prev.map(p => p.id === poiId ? { ...p, x: originX, y: originY } : p));
        const p = pois.find(p => p.id === poiId);
        if (p) setPoiForm({ poi: p, name: p.name, description: p.description, revealed: p.revealed, category: p.category || "other", size: p.size || "large" });
      } else {
        // Validate position is within map bounds before saving — catches any remaining edge cases
        const { w, h } = imgSizeRef.current;
        if (w > 0 && mapX >= 0 && mapX <= w && mapY >= 0 && mapY <= h) {
          dbUpdate(sessionRef.current.access_token, "pois", poiId, { x: mapX, y: mapY }).catch(console.error);
        } else {
          // Out-of-bounds: revert silently so the POI snaps back
          setPois(prev => prev.map(p => p.id === poiId ? { ...p, x: originX, y: originY } : p));
        }
      }
    }
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: true }); window.addEventListener("touchend", onUp);
  }

  // ── Marker drag (owner only) ──
  function startMarkerDrag(e, marker) {
    e.stopPropagation();
    if (marker.locked) return;
    if (dragRef.current.active || isPinchingRef.current) return;
    if (imgSizeRef.current.w === 0) return; // don't drag while map is loading
    const touch0 = e.touches?.[0];
    const startCx = touch0 ? touch0.clientX : e.clientX;
    const startCy = touch0 ? touch0.clientY : e.clientY;
    const touchId = touch0 ? touch0.identifier : null;
    const scaleAtStart = transformRef.current.scale;
    markerDragState.current = { markerId: marker.id, originX: marker.x, originY: marker.y, startCx, startCy, touchId, scaleAtStart, moved: false, mapX: marker.x, mapY: marker.y };
    function onMove(ev) {
      if (!markerDragState.current) return;
      const touch = ev.touches
        ? Array.from(ev.touches).find(t => t.identifier === markerDragState.current.touchId) ?? ev.touches[0]
        : null;
      const cx = touch ? touch.clientX : ev.clientX;
      const cy = touch ? touch.clientY : ev.clientY;
      const dx = cx - markerDragState.current.startCx, dy = cy - markerDragState.current.startCy;
      // Euclidean threshold (8px) — diagonal micro-movements on mobile won't cancel taps
      if (Math.sqrt(dx * dx + dy * dy) > 8) markerDragState.current.moved = true;
      const nx = markerDragState.current.originX + dx / markerDragState.current.scaleAtStart;
      const ny = markerDragState.current.originY + dy / markerDragState.current.scaleAtStart;
      markerDragState.current.mapX = nx; markerDragState.current.mapY = ny;
      setMarkers(prev => prev.map(m => m.id === markerDragState.current?.markerId ? { ...m, x: nx, y: ny } : m));
    }
    function onUp() {
      if (!markerDragState.current) return;
      const { markerId, mapX, mapY, moved, originX, originY } = markerDragState.current;
      markerDragState.current = null;
      window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove); window.removeEventListener("touchend", onUp);
      if (!moved) {
        setMarkers(prev => prev.map(m => m.id === markerId ? { ...m, x: originX, y: originY } : m));
        if (openMarkerCard === markerId) { closeMarkerCard(); } else { setOpenMarkerCard(markerId); }
      } else {
        const { w, h } = imgSizeRef.current;
        if (w > 0 && mapX >= 0 && mapX <= w && mapY >= 0 && mapY <= h) {
          dbUpdate(sessionRef.current.access_token, "markers", markerId, { x: mapX, y: mapY }).catch(console.error);
        } else {
          setMarkers(prev => prev.map(m => m.id === markerId ? { ...m, x: originX, y: originY } : m));
        }
      }
    }
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: true }); window.addEventListener("touchend", onUp);
  }

  // ── Map pan ──
  function onPointerDown(e) {
    if (poiDragState.current || markerDragState.current) return;
    if (e.touches && e.touches.length === 2) return;
    if (e.button !== undefined && e.button !== 0) return;
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    dragRef.current = { active: true, startX: cx, startY: cy, lastX: cx, lastY: cy, moved: false };
    function onMove(ev) {
      if (ev.touches && ev.touches.length === 2) return;
      if (!dragRef.current.active) return;
      const mx = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const my = ev.touches ? ev.touches[0].clientY : ev.clientY;
      const tdx = mx - dragRef.current.startX, tdy = my - dragRef.current.startY;
      if (!dragRef.current.moved && Math.sqrt(tdx*tdx+tdy*tdy) < 8) return;
      dragRef.current.moved = true; setIsDragging(true); setMapInteracting(true);
      const dx = Math.max(-80, Math.min(80, mx - dragRef.current.lastX));
      const dy = Math.max(-80, Math.min(80, my - dragRef.current.lastY));
      dragRef.current.lastX = mx; dragRef.current.lastY = my;
      setTransform(t => { const rect = getContainerRect(); return clamp({ ...t, x: t.x+dx, y: t.y+dy }, rect.width, rect.height, imgSizeRef.current.w, imgSizeRef.current.h); });
    }
    function onUp(ev) {
      if (dragRef.current.moved) suppressClickRef.current = true;
      dragRef.current.active = false; setIsDragging(false); setMapInteracting(false);
      window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove); window.removeEventListener("touchend", onUp);
      if (!dragRef.current.moved && (placingRef.current || addPointZoneRef.current)) {
        const cx2 = ev.changedTouches ? ev.changedTouches[0].clientX : (ev.clientX ?? dragRef.current.startX);
        const cy2 = ev.changedTouches ? ev.changedTouches[0].clientY : (ev.clientY ?? dragRef.current.startY);
        const coords = toMapCoords(cx2, cy2);
        const mode = placingRef.current;
        // Add point to an existing zone
        if (addPointZoneRef.current) {
          const zId = addPointZoneRef.current; addPointZoneRef.current = null; setPlacingMode(null);
          const z = zonesRef.current.find(z => z.id === zId);
          if (z) {
            const newPoints = [...z.points, coords];
            dbUpdate(sessionRef.current.access_token, "zones", zId, { points: newPoints }).catch(console.error);
            setZones(prev => prev.map(z2 => z2.id === zId ? { ...z2, points: newPoints } : z2));
            setTimeout(() => setZoneForm({ zone: { ...z, points: newPoints }, name: z.name, fill_color: z.fill_color, opacity: z.opacity, revealed: z.revealed, points: newPoints }), 50);
          }
          return;
        }
        // New zone — append waypoint, keep mode active
        if (mode === "zone") {
          setPlacingZonePoints(prev => [...(prev || []), coords]);
          return;
        }
        setPlacingMode(null);
        if (mode === "poi") setPoiForm({ poi: null, x: coords.x, y: coords.y, name: "", description: "", revealed: false, category: "other", size: "large" });
        if (mode === "marker") {
          if (!myColor && !isGM) { setShowColorPicker(true); setPlacingMode(null); return; }
          setMarkerForm({ x: coords.x, y: coords.y });
        }
      }
    }
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: true }); window.addEventListener("touchend", onUp);
  }

  // ── Zoom / pinch ──
  useEffect(() => {
    if (tab !== "map") return;
    let wheelCleanup = null, pinchCleanup = null, attempts = 0;
    function attachAll() {
      const el = mapRef.current;
      if (!el) { if (attempts++ < 30) { setTimeout(attachAll, 100); return; } return; }
      function onWheel(e) {
        e.preventDefault();
        const factor = 1 + (e.deltaY < 0 ? 1 : -1) * 0.08 * scrollSensRef.current;
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        setTransform(t => { const ns = Math.min(8, Math.max(0.1, t.scale * factor)); const sr = ns / t.scale; return clamp({ scale: ns, x: mx - sr * (mx - t.x), y: my - sr * (my - t.y) }, rect.width, rect.height, imgSizeRef.current.w, imgSizeRef.current.h); });
      }
      el.addEventListener("wheel", onWheel, { passive: false });
      wheelCleanup = () => el.removeEventListener("wheel", onWheel);
      let lastDist = null, isPinching = false;
      function getDist(t) { const dx=t[0].clientX-t[1].clientX,dy=t[0].clientY-t[1].clientY; return Math.sqrt(dx*dx+dy*dy); }
      function getMid(t) { return { x:(t[0].clientX+t[1].clientX)/2,y:(t[0].clientY+t[1].clientY)/2 }; }
      function onTS(e) { if(e.touches.length===2){isPinching=true;isPinchingRef.current=true;lastDist=getDist(e.touches);dragRef.current.active=false;setIsDragging(false);setMapInteracting(true);} }
      function onTM(e) {
        if(e.touches.length!==2||!isPinching)return; e.preventDefault();
        const dist=getDist(e.touches); if(!lastDist){lastDist=dist;return;}
        const factor=Math.min(Math.max(dist/lastDist,0.5),2); lastDist=dist;
        const mid=getMid(e.touches); const rect=el.getBoundingClientRect();
        const t=transformRef.current;
        const ns=Math.min(8,Math.max(0.1,t.scale*factor));
        const sr=ns/t.scale; const mx=mid.x-rect.left,my=mid.y-rect.top;
        const nt=clamp({scale:ns,x:mx-sr*(mx-t.x),y:my-sr*(my-t.y)},rect.width,rect.height,imgSizeRef.current.w,imgSizeRef.current.h);
        transformRef.current=nt;
        // Direct DOM update — no React re-render during gesture
        if(mapTransformDivRef.current)
          mapTransformDivRef.current.style.transform=`translate3d(${Math.round(nt.x)}px,${Math.round(nt.y)}px,0) scale(${nt.scale})`;
        if(poiLayerRef.current){
          const fs=fitScaleRef.current;
          poiLayerRef.current.style.opacity=fs>0?(nt.scale<=fs?0:Math.min(1,(nt.scale-fs)/fs)):1;
        }
        // Update each text overlay's opacity directly
        const fs=fitScaleRef.current;
        document.querySelectorAll("[data-text-overlay]").forEach(el=>{
          const fade=textFadeRef.current[el.dataset.textOverlay];
          if(!fade||!fade.fade_enabled||fs<=0){el.style.opacity="1";return;}
          const prog=Math.min(1,Math.max(0,(nt.scale-fs)/fs));
          el.style.opacity=fade.fade_invert?String(1-prog):String(prog);
        });
      }
      function onTE(e){
        if(e.touches.length<2){
          isPinching=false;isPinchingRef.current=false;lastDist=null;setMapInteracting(false);
          // Sync React state once on gesture end (single re-render instead of one per frame)
          setTransform({...transformRef.current});
        }
      }
      el.addEventListener("touchstart",onTS,{passive:true}); el.addEventListener("touchmove",onTM,{passive:false}); el.addEventListener("touchend",onTE,{passive:true});
      pinchCleanup=()=>{el.removeEventListener("touchstart",onTS);el.removeEventListener("touchmove",onTM);el.removeEventListener("touchend",onTE);};
    }
    const t = setTimeout(attachAll, 80);
    return () => { clearTimeout(t); wheelCleanup && wheelCleanup(); pinchCleanup && pinchCleanup(); };
  }, [tab, activeCampaign]);

  // ── CRUD ──
  async function savePOI(form, iconFile) {
    let icon_url = form.clearIcon ? "" : (form.poi?.icon_url || "");
    if (iconFile) { try { icon_url = await uploadToStorage(session.access_token, iconFile); } catch { icon_url = await readFile(iconFile); } }
    const body = { name: form.name||"Unnamed POI", description: form.description||"", revealed: form.revealed, locked: form.locked||false, category: form.category||"other", size: form.size||"large", icon_url, poi_type: form.poi_type||"standard", linked_map_id: form.linked_map_id||null };
    try {
      if (form.poi) {
        await dbUpdate(session.access_token, "pois", form.poi.id, body);
        setPois(prev => prev.map(p => p.id === form.poi.id ? { ...p, ...body } : p));
        // Notify players if revealed status changed via the edit form
        const wasRevealed = form.poi.revealed;
        if (body.revealed !== wasRevealed) {
          const label = body.name || form.poi.name || "A location";
          const zCtx = getZoneContext(form.poi.x, form.poi.y, zonesRef.current.filter(z=>z.map_id===form.poi.map_id));
          const coords = { x: form.poi.x, y: form.poi.y, mapId: form.poi.map_id };
          if (body.revealed) scheduleRevealNotif(true, { label, message: zCtx ? `${label} revealed (${zCtx})` : `${label} has been revealed`, id: form.poi.id, coords, category: form.poi.category || form.category });
          else scheduleRevealNotif(false, { label, message: `${label} has been hidden`, id: form.poi.id, coords });
        }
      } else {
        const [np] = await dbInsert(session.access_token, "pois", { ...body, campaign_id: activeCampaign.id, map_id: activeMapId, x: form.x, y: form.y });
        setPois(prev => [...prev, np]);
      }
      setPoiForm(null);
    } catch(e) { setError(e.message); }
  }
  async function deletePOI(id) {
    try { await dbDelete(session.access_token, "pois", id); setPois(prev=>prev.filter(p=>p.id!==id)); setPoiForm(null); setOpenPOICard(null); } catch(e) { setError(e.message); }
  }
  function duplicatePOI(poi) {
    dbInsert(session.access_token, "pois", { name: poi.name+" (copy)", description: poi.description, revealed: false, category: poi.category, size: poi.size, icon_url: poi.icon_url, campaign_id: poi.campaign_id, map_id: poi.map_id, x: poi.x+30, y: poi.y+30 })
      .then(([np]) => setPois(prev => prev.find(x=>x.id===np.id)?prev:[...prev,np])).catch(e=>setError(e.message));
    setPoiForm(null);
  }
  async function togglePOIReveal(id, current) {
    try {
      await dbUpdate(session.access_token, "pois", id, { revealed: !current });
      setPois(prev=>prev.map(p=>p.id===id?{...p,revealed:!current}:p));
      const poi = pois.find(p=>p.id===id);
      const label = poi?.name || "A location";
      const zCtx = poi ? getZoneContext(poi.x, poi.y, zonesRef.current.filter(z=>z.map_id===poi.map_id)) : null;
      const coords = poi ? { x:poi.x, y:poi.y, mapId:poi.map_id } : null;
      if (!current) {
        const message = zCtx ? `${label} revealed (${zCtx})` : `${label} has been revealed`;
        scheduleRevealNotif(true, { label, message, id, coords, category: poi?.category });
      } else {
        scheduleRevealNotif(false, { label, message: `${label} has been hidden`, id, coords });
      }
    } catch(e) { setError(e.message); }
  }
  async function togglePOILock(id, current) {
    try {
      await dbUpdate(session.access_token, "pois", id, { locked: !current });
      setPois(prev => prev.map(p => p.id === id ? { ...p, locked: !current } : p));
    } catch(e) { setError(e.message); }
  }
  async function saveMarker(label, description) {
    if (!markerForm || !("x" in markerForm)) return;
    if (myMarkers.length >= markerLimit && !isGM) { setError(`Marker limit reached (${markerLimit}). Ask your GM to increase it.`); return; }
    const me = members.find(m => m.user_id === user.id);
    try {
      const [nm] = await dbInsert(session.access_token, "markers", {
        campaign_id: activeCampaign.id, map_id: activeMapId, user_id: user.id,
        user_name: user.user_metadata?.full_name || user.email,
        player_color: myColor || "#378ADD", label, description: description || "",
        x: markerForm.x, y: markerForm.y
      });
      setMarkers(prev=>[...prev,nm]); setMarkerForm(null);
      // Notify everyone of new marker placement
      const displayName = members.find(m=>m.user_id===user.id)?.display_name || user.user_metadata?.full_name || "A player";
      const zCtx = getZoneContext(markerForm.x, markerForm.y, zonesRef.current.filter(z=>z.map_id===activeMapId));
      const markerMsg = zCtx ? `${displayName} placed a marker ${zCtx}` : `${displayName} placed a marker`;
      logNotif("marker_placed", label||`${displayName}'s Marker`, markerMsg, nm.id, { x:markerForm.x, y:markerForm.y, mapId:activeMapId });
    } catch(e) { setError(e.message); }
  }
  async function editMarker(marker, label, description, locked) {
    try {
      await dbUpdate(session.access_token, "markers", marker.id, { label, description, locked: locked||false });
      setMarkers(prev=>prev.map(m=>m.id===marker.id?{...m,label,description,locked:locked||false}:m));
      setMarkerForm(null);
    } catch(e) { setError(e.message); }
  }
  async function deleteMarker(id) {
    try { await dbDelete(session.access_token, "markers", id); setMarkers(prev=>prev.filter(m=>m.id!==id)); setOpenMarkerCard(null); } catch(e) { setError(e.message); }
  }
  async function saveCategoryIcon(catId, file) {
    try {
      const url = await uploadToStorage(session.access_token, file);
      await dbUpsert(session.access_token, "category_icons", { campaign_id: activeCampaign.id, category_id: catId, icon_url: url }, "campaign_id,category_id");
      setCategoryIcons(prev => ({ ...prev, [catId]: url }));
    } catch(e) { setError(e.message); }
  }
  async function removeCategoryIcon(catId) {
    try {
      await fetch(`${SUPA_URL}/rest/v1/category_icons?campaign_id=eq.${activeCampaign.id}&category_id=eq.${catId}`, { method: "DELETE", headers: hdrs(session.access_token) });
      setCategoryIcons(prev => { const n = {...prev}; delete n[catId]; return n; });
    } catch(e) { setError(e.message); }
  }
  async function uploadMap(file) {
    const isFirst = maps.length === 0;
    try {
      // Compress to WebP and upload to Storage (avoids storing base64 blobs in the DB)
      const compressed = await compressToWebP(file);
      const webpFile = new File([compressed], file.name.replace(/\.[^.]+$/, ".webp"), { type: "image/webp" });
      const src = await uploadToStorage(session.access_token, webpFile, "maps");
      const [nm] = await dbInsert(session.access_token, "maps", { campaign_id: activeCampaign.id, name: file.name.replace(/\.[^.]+$/,""), src, is_main: isFirst });
      // The RPC doesn't return src, so attach it client-side
      setMaps(prev => [...prev, { ...nm, src }]);
      if (isFirst) setActiveMapId(nm.id);
    } catch(e) { setError(e.message); }
  }
  // ── POI Folder management ──
  async function saveFolder(name, folder) {
    try {
      if (folder) {
        await dbUpdate(session.access_token, "poi_folders", folder.id, { name });
        setPoiFolders(prev => prev.map(f => f.id === folder.id ? { ...f, name } : f));
      } else {
        const [nf] = await dbInsert(session.access_token, "poi_folders", { name, campaign_id: activeCampaign.id, sort_order: poiFolders.length });
        setPoiFolders(prev => [...prev, nf]);
      }
      setFolderForm(null);
    } catch(e) { setError(e.message); }
  }
  async function deleteFolder(id) {
    try {
      await dbDelete(session.access_token, "poi_folders", id);
      setPois(prev => prev.map(p => p.folder_id === id ? { ...p, folder_id: null } : p));
      setPoiFolders(prev => prev.filter(f => f.id !== id));
      setFolderForm(null);
    } catch(e) { setError(e.message); }
  }
  async function movePOIToFolder(poiId, folderId) {
    try {
      await dbUpdate(session.access_token, "pois", poiId, { folder_id: folderId || null });
      setPois(prev => prev.map(p => p.id === poiId ? { ...p, folder_id: folderId || null } : p));
      setMovingPOI(null); setMoveDropdownPos(null);
    } catch(e) { setError(e.message); }
  }
  async function reorderFolders(draggedId, targetId) {
    if (draggedId === targetId) return;
    const newOrder = [...poiFolders];
    const fromIdx = newOrder.findIndex(f => f.id === draggedId);
    const toIdx   = newOrder.findIndex(f => f.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, moved);
    setPoiFolders(newOrder);
    await Promise.all(newOrder.map((f, i) =>
      dbUpdate(session.access_token, "poi_folders", f.id, { sort_order: i }).catch(() => {})
    ));
  }

  async function toggleFolderReveal(folder) {
    const children = pois.filter(p => p.folder_id === folder.id);
    if (!children.length) return;
    const newState = !children.every(p => p.revealed);
    const changing = children.filter(p => p.revealed !== newState);
    try {
      await Promise.all(changing.map(p => dbUpdate(session.access_token, "pois", p.id, { revealed: newState })));
      setPois(prev => prev.map(p => p.folder_id === folder.id ? { ...p, revealed: newState } : p));
      if (changing.length === 1) {
        const p = changing[0];
        const label = p.name;
        if (newState) logNotif("poi_revealed", label, `${label} has been revealed`, p.id, { x:p.x, y:p.y, mapId:p.map_id }, p.category);
        else          logNotif("poi_hidden",   label, `${label} has been hidden`,   p.id, { x:p.x, y:p.y, mapId:p.map_id });
      } else if (changing.length > 1) {
        const n = changing.length;
        const summary = `${folder.name}: ${n} location${n>1?"s":""} ${newState?"revealed":"hidden"}`;
        logNotif(newState?"poi_batch_revealed":"poi_batch_hidden", `${n} location${n>1?"s":""} ${newState?"revealed":"hidden"}`, summary, null, null, null);
      }
    } catch(e) { setError(e.message); }
  }
  async function toggleFolderLock(folder) {
    const children = pois.filter(p => p.folder_id === folder.id);
    if (!children.length) return;
    const newState = !children.every(p => p.locked);
    try {
      await Promise.all(children.filter(p => p.locked !== newState).map(p =>
        dbUpdate(session.access_token, "pois", p.id, { locked: newState })
      ));
      setPois(prev => prev.map(p => p.folder_id === folder.id ? { ...p, locked: newState } : p));
    } catch(e) { setError(e.message); }
  }
  async function setMainMap(id) {
    try {
      // Clear all in one call, then set the new main — prevents partial failure leaving two is_main=true
      await fetch(`${SUPA_URL}/rest/v1/maps?campaign_id=eq.${activeCampaign.id}`,
        { method:"PATCH", headers:hdrs(session.access_token), body:JSON.stringify({ is_main: false }) });
      await dbUpdate(session.access_token, "maps", id, { is_main: true });
      setMaps(prev => prev.map(m => ({ ...m, is_main: m.id === id })));
    } catch(e) { setError(e.message); }
  }
  async function deleteMap(id) {
    try { await dbDelete(session.access_token, "maps", id); const remaining = maps.filter(m=>m.id!==id); setMaps(remaining); if (activeMapId===id) switchToMap(remaining[0]?.id||null); setMapDeleteConfirm(null); } catch(e) { setError(e.message); }
  }
  // Central map-switch helper — fades the map out, switches, then reveals when image loads.
  function switchToMap(id, { push = false } = {}) {
    if (!id) return;
    if (push) setMapStack(s => [...s, activeMapId]);
    setSearchPing(null);
    if (searchAnimRef.current) { cancelAnimationFrame(searchAnimRef.current); setSearchMoving(false); }
    clearTimeout(mapFadeTimerRef.current);
    setMapFadeState("covering");
    // Allow the cover animation to start before we swap the map
    mapFadeTimerRef.current = setTimeout(() => {
      setActiveMapId(id);
      setTransform({x:0,y:0,scale:1}); setImgSize({w:0,h:0});
      const already = maps.find(m => m.id === id);
      if (!already?.src) loadMapSrc(id);
      // Safety: reveal even if the image onLoad never fires (e.g. base64 or error)
      mapFadeTimerRef.current = setTimeout(() => {
        setMapFadeState("revealing");
        setTimeout(() => setMapFadeState(null), 350);
      }, 2500);
    }, 220);
  }
  function goBack() { const prev=mapStack[mapStack.length-1]; setMapStack(s=>s.slice(0,-1)); switchToMap(prev||null); }
  function goHome() { setMapStack([]); const main=maps.find(m=>m.is_main)||maps[0]; if(main) switchToMap(main.id); }

  // ── Notification helpers ──
  function pointInPolygon(x, y, points) {
    let inside = false;
    for (let i=0, j=points.length-1; i<points.length; j=i++) {
      const xi=points[i].x, yi=points[i].y, xj=points[j].x, yj=points[j].y;
      if (((yi>y)!==(yj>y)) && (x<(xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside;
    }
    return inside;
  }
  function getZoneContext(x, y, zoneList) {
    const hits = zoneList.filter(z => z.broadcast_location!==false && z.revealed && z.points?.length>=3 && pointInPolygon(x,y,z.points));
    if (!hits.length) return null;
    if (hits.length===1) return `in ${hits[0].name||"an unnamed zone"}`;
    if (hits.length===2) return `between ${hits[0].name||"Zone"} & ${hits[1].name||"Zone"}`;
    return `between multiple zones`;
  }
  function focusOnNotif(notif) {
    if (notif.x==null || notif.y==null) return;
    setShowBell(false);
    setTab("map");
    if (notif.map_id && notif.map_id !== activeMapId) {
      setMapStack([]);
      switchToMap(notif.map_id);
      pendingFocusRef.current = { x: notif.x, y: notif.y };
    } else {
      const targetScale = Math.max(fitScale*2.75, 1);
      const rect = mapRef.current?.getBoundingClientRect()||{width:800,height:500};
      setTransform({ scale:targetScale, x:rect.width/2-notif.x*targetScale, y:rect.height/2-notif.y*targetScale });
    }
  }

  // ── Sound ──
  function playSound(type) {
    if (soundVolumeRef.current <= 0) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      gain.gain.value = soundVolumeRef.current * 0.22;
      if (type === "announcement") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(523, ctx.currentTime);
        osc.frequency.setValueAtTime(659, ctx.currentTime + 0.15);
        osc.frequency.setValueAtTime(784, ctx.currentTime + 0.3);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
        osc.start(); osc.stop(ctx.currentTime + 0.8);
      } else if (type === "poi_revealed") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.start(); osc.stop(ctx.currentTime + 0.4);
      } else {
        osc.type = "triangle"; osc.frequency.value = 330;
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start(); osc.stop(ctx.currentTime + 0.25);
      }
    } catch {}
  }

  // ── Toasts ──
  function addToast(msg, type) {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev.slice(-3), { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  }

  // ── Notification log helper ──
  function logNotif(type, title, message, relatedId, coords, category) {
    if (!activeCampaign || !session) return;
    const row = { campaign_id: activeCampaign.id, type, title, message, related_id: relatedId, map_id: coords?.mapId||activeMapId, x: coords?.x??null, y: coords?.y??null, ...(category ? { category } : {}) };
    dbInsert(session.access_token, "notification_log", row).then(([inserted]) => {
      // Trim oldest entries beyond the limit
      const lim = notifLimitRef.current;
      setNotifLog(prev => {
        const next = prev.find(n=>n.id===inserted.id)?prev:[inserted,...prev];
        if (next.length > lim) {
          const excess = next.slice(lim);
          excess.forEach(n => dbDelete(session.access_token, "notification_log", n.id).catch(()=>{}));
          return next.slice(0, lim);
        }
        return next;
      });
    }).catch(()=>{});
  }

  // ── Batched reveal/hide notifications (debounce 600ms, 3+ items → single summary) ──
  function scheduleRevealNotif(isRevealing, data) {
    if (isRevealing) pendingRevealRef.current.revealed.push(data);
    else             pendingRevealRef.current.hidden.push(data);
    clearTimeout(revealTimerRef.current);
    revealTimerRef.current = setTimeout(() => {
      const { revealed, hidden } = pendingRevealRef.current;
      pendingRevealRef.current = { revealed: [], hidden: [] };
      if (revealed.length >= 3) {
        logNotif("poi_batch_revealed", `${revealed.length} locations revealed`, `GM has revealed ${revealed.length} locations`, null, null, null);
      } else {
        revealed.forEach(p => logNotif("poi_revealed", p.label, p.message, p.id, p.coords, p.category));
      }
      if (hidden.length >= 3) {
        logNotif("poi_batch_hidden", `${hidden.length} locations hidden`, `GM has hidden ${hidden.length} locations`, null, null, null);
      } else {
        hidden.forEach(p => logNotif("poi_hidden", p.label, p.message, p.id, p.coords));
      }
    }, 600);
  }

  // ── NPC CRUD ──
  async function saveNPC(form) {
    const body = { name: form.name||"Unknown NPC", status: form.status||"Alive", border_color: form.border_color||"#C9A84C", aura_radius: form.aura_radius??80, show_name: form.show_name??true, show_status: form.show_status??true, show_aura: form.show_aura??true, is_visible_to_players: form.is_visible_to_players??false, locked: form.locked??false };
    try {
      if (form.npc) {
        await dbUpdate(session.access_token, "npcs", form.npc.id, body);
        setNpcs(prev => prev.map(n => n.id === form.npc.id ? { ...n, ...body } : n));
      } else {
        const [n] = await dbInsert(session.access_token, "npcs", { ...body, campaign_id: activeCampaign.id, map_id: activeMapId, x: form.x??200, y: form.y??200 });
        setNpcs(prev => [...prev, n]);
      }
      setNpcForm(null);
    } catch(e) { setError(e.message); }
  }
  async function deleteNPC(id) {
    try { await dbDelete(session.access_token, "npcs", id); setNpcs(prev => prev.filter(n => n.id !== id)); setNpcForm(null); } catch(e) { setError(e.message); }
  }

  // ── Map Text overlays ──
  async function saveText(form) {
    const body = { content: form.content||"New Text", font_size: Number(form.font_size)||28, color: form.color||"#FFFFFF", font_weight: form.font_weight||"700", fade_enabled: !!form.fade_enabled, fade_invert: !!form.fade_invert, locked: !!form.locked };
    try {
      if (form.text) {
        await dbUpdate(session.access_token, "map_texts", form.text.id, body);
        setMapTexts(prev => prev.map(t => t.id === form.text.id ? { ...t, ...body } : t));
      } else {
        const [t] = await dbInsert(session.access_token, "map_texts", { ...body, campaign_id: activeCampaign.id, map_id: activeMapId, x: form.x??200, y: form.y??200 });
        setMapTexts(prev => [...prev, t]);
      }
      setTextForm(null);
    } catch(e) { setError(e.message); }
  }
  async function deleteText(id) {
    try { await dbDelete(session.access_token, "map_texts", id); setMapTexts(prev => prev.filter(t => t.id !== id)); setTextForm(null); } catch(e) { setError(e.message); }
  }
  function startTextDrag(e, txt) {
    e.stopPropagation();
    // Do NOT early-return when locked — tap-to-edit must still work.
    // Locked texts skip position updates in onMove but still open the form on tap.
    if (dragRef.current.active || isPinchingRef.current) return;
    const touch0 = e.touches?.[0];
    const startCx = touch0 ? touch0.clientX : e.clientX;
    const startCy = touch0 ? touch0.clientY : e.clientY;
    const touchId = touch0 ? touch0.identifier : null;
    const scaleAtStart = transformRef.current.scale;
    textDragState.current = { textId: txt.id, originX: txt.x, originY: txt.y, startCx, startCy, touchId, scaleAtStart, moved: false, mapX: txt.x, mapY: txt.y };
    function onMove(ev) {
      if (!textDragState.current) return;
      const touch = ev.touches ? Array.from(ev.touches).find(t => t.identifier === textDragState.current.touchId) ?? ev.touches[0] : null;
      const cx = touch ? touch.clientX : ev.clientX;
      const cy = touch ? touch.clientY : ev.clientY;
      const dx = cx - textDragState.current.startCx, dy = cy - textDragState.current.startCy;
      if (Math.sqrt(dx*dx+dy*dy) > 6) textDragState.current.moved = true;
      if (txt.locked) return; // locked: track movement for tap detection but don't reposition
      const nx = textDragState.current.originX + dx / textDragState.current.scaleAtStart;
      const ny = textDragState.current.originY + dy / textDragState.current.scaleAtStart;
      textDragState.current.mapX = nx; textDragState.current.mapY = ny;
      setMapTexts(prev => prev.map(t => t.id === textDragState.current?.textId ? { ...t, x: nx, y: ny } : t));
    }
    function onUp() {
      if (!textDragState.current) return;
      const { textId, mapX, mapY, moved, originX, originY } = textDragState.current;
      textDragState.current = null;
      window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove); window.removeEventListener("touchend", onUp);
      if (!moved) {
        setMapTexts(prev => prev.map(t => t.id === textId ? { ...t, x: originX, y: originY } : t));
        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
        const t = mapTexts.find(t => t.id === textId);
        if (t) setTextForm({ text: t, content: t.content, font_size: t.font_size, color: t.color, font_weight: t.font_weight, fade_enabled: t.fade_enabled, fade_invert: t.fade_invert });
      } else {
        dbUpdate(sessionRef.current.access_token, "map_texts", textId, { x: mapX, y: mapY }).catch(console.error);
      }
    }
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: true }); window.addEventListener("touchend", onUp);
  }
  function startNPCDrag(e, npc) {
    e.stopPropagation();
    if (npc.locked) return;
    if (dragRef.current.active || isPinchingRef.current) return;
    const touch0 = e.touches?.[0];
    const startCx = touch0 ? touch0.clientX : e.clientX;
    const startCy = touch0 ? touch0.clientY : e.clientY;
    const touchId = touch0 ? touch0.identifier : null;
    npcDragState.current = { npcId:npc.id, originX:npc.x, originY:npc.y, startCx, startCy, touchId, scaleAtStart:transformRef.current.scale, moved:false, mapX:npc.x, mapY:npc.y };
    function onMove(ev) {
      if (!npcDragState.current) return;
      const touch = ev.touches ? Array.from(ev.touches).find(t=>t.identifier===npcDragState.current.touchId)??ev.touches[0] : null;
      const cx = touch ? touch.clientX : ev.clientX, cy = touch ? touch.clientY : ev.clientY;
      const dx=cx-npcDragState.current.startCx, dy=cy-npcDragState.current.startCy;
      if (Math.sqrt(dx*dx+dy*dy)>8) npcDragState.current.moved=true;
      const nx=npcDragState.current.originX+dx/npcDragState.current.scaleAtStart, ny=npcDragState.current.originY+dy/npcDragState.current.scaleAtStart;
      npcDragState.current.mapX=nx; npcDragState.current.mapY=ny;
      setNpcs(prev=>prev.map(n=>n.id===npcDragState.current?.npcId?{...n,x:nx,y:ny}:n));
    }
    function onUp() {
      if (!npcDragState.current) return;
      const { npcId, mapX, mapY, moved, originX, originY } = npcDragState.current;
      npcDragState.current = null;
      window.removeEventListener("mousemove",onMove); window.removeEventListener("mouseup",onUp);
      window.removeEventListener("touchmove",onMove); window.removeEventListener("touchend",onUp);
      if (!moved) {
        setNpcs(prev=>prev.map(n=>n.id===npcId?{...n,x:originX,y:originY}:n));
        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
        const n=npcsRef.current.find(n=>n.id===npcId); if(n) setNpcForm({npc:n,...n});
      } else {
        dbUpdate(sessionRef.current.access_token,"npcs",npcId,{x:mapX,y:mapY}).then(()=>{
          const n=npcsRef.current.find(n=>n.id===npcId);
          if(n) {
            const zCtx = getZoneContext(mapX, mapY, zonesRef.current.filter(z=>z.map_id===n.map_id));
            const npcTitle = n.show_name?`${n.name} spotted`:"NPC sighted";
            const npcMsg = zCtx ? `${n.show_name?n.name:"An NPC"} has been sighted ${zCtx}` : `${n.show_name?n.name:"An NPC"} has been sighted in a new location`;
            logNotif("npc_moved", npcTitle, npcMsg, npcId, { x:mapX, y:mapY, mapId:n.map_id });
          }
        }).catch(console.error);
      }
    }
    window.addEventListener("mousemove",onMove); window.addEventListener("mouseup",onUp);
    window.addEventListener("touchmove",onMove,{passive:true}); window.addEventListener("touchend",onUp);
  }

  // ── Announcements ──
  async function saveAnnouncement(form) {
    const body = { title:form.title||"", sub_header:form.sub_header?.trim()||null, message:form.message?.trim()||null };
    try {
      if (form.announcement) {
        await dbUpdate(session.access_token,"announcements",form.announcement.id,{...body,updated_at:new Date().toISOString()});
        setAnnouncements(prev=>prev.map(a=>a.id===form.announcement.id?{...a,...body}:a));
      } else {
        const [a] = await dbInsert(session.access_token,"announcements",{...body,campaign_id:activeCampaign.id,created_by:user.id});
        setAnnouncements(prev=>[a,...prev]);
        logNotif("announcement",body.title,body.message,a.id);
      }
      setAnnounceForm(null);
    } catch(e) { setError(e.message); }
  }
  async function deleteAnnouncement(id) {
    try { await dbDelete(session.access_token,"announcements",id); setAnnouncements(prev=>prev.filter(a=>a.id!==id)); } catch(e) { setError(e.message); }
  }

  // ── Map access toggle ──
  async function toggleMapAccess(mapId, current) {
    try { await dbUpdate(session.access_token,"maps",mapId,{player_accessible:!current}); setMaps(prev=>prev.map(m=>m.id===mapId?{...m,player_accessible:!current}:m)); } catch(e) { setError(e.message); }
  }

  // ── Keyboard shortcuts ──
  // Store all values the handler reads in a ref so the listener only binds once.
  const keyStateRef = useRef({});
  keyStateRef.current = { tab, poiForm, markerForm, zoneForm, npcForm, announceForm, showFilter, showBell, placingMode, portalConfirm };
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA"||e.target.tagName==="SELECT") return;
      const s = keyStateRef.current;
      if (e.key==="Escape") {
        if (s.portalConfirm) { setPortalConfirm(null); return; }
        if (s.poiForm) { setPoiForm(null); return; }
        if (s.markerForm) { setMarkerForm(null); return; }
        if (s.zoneForm) { setZoneForm(null); return; }
        if (s.npcForm) { setNpcForm(null); return; }
        if (s.announceForm) { setAnnounceForm(null); return; }
        if (s.showFilter) { setShowFilter(false); return; }
        if (s.showBell) { setShowBell(false); return; }
        if (s.placingMode) { setPlacingMode(null); setPlacingZonePoints(null); return; }
      }
      if ((e.key==="f"||e.key==="F") && s.tab==="map") { e.preventDefault(); resetView(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // intentional empty deps — reads live values via keyStateRef

  // ── Animated card close helpers ──
  // Keeps the card mounted during a 250ms fade-out before removing it from DOM.
  function closePOICard() {
    if (!openPOICard) return;
    setPoiCardClosing(openPOICard); setOpenPOICard(null);
    clearTimeout(poiCloseTimer.current);
    poiCloseTimer.current = setTimeout(() => setPoiCardClosing(null), 260);
  }
  function closeMarkerCard() {
    if (!openMarkerCard) return;
    setMarkerCardClosing(openMarkerCard); setOpenMarkerCard(null);
    clearTimeout(markerCloseTimer.current);
    markerCloseTimer.current = setTimeout(() => setMarkerCardClosing(null), 260);
  }
  // Clear the closing ghost if a new card opens before the timer fires
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (openPOICard) { clearTimeout(poiCloseTimer.current); setPoiCardClosing(null); } }, [openPOICard]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (openMarkerCard) { clearTimeout(markerCloseTimer.current); setMarkerCardClosing(null); } }, [openMarkerCard]);

  // Card positions — uses the closing id as fallback so the card stays positioned during fade-out
  const displayedPOIId = openPOICard || poiCardClosing;
  const displayedMarkerCardId = openMarkerCard || markerCardClosing;
  const openPOI = mapPOIs.find(p=>p.id===displayedPOIId);
  const openMarker = mapMarkers.find(m=>m.id===displayedMarkerCardId);
  const openMarkerMember = openMarker ? members.find(m => m.user_id === openMarker.user_id) : null;

  function getCardPos(x, y) {
    const rect = getContainerRect();
    const sx = x * transform.scale + transform.x, sy = y * transform.scale + transform.y;
    const cardW = 240, cardH = 200, pad = 8;
    let left = sx + 16, top = sy - cardH / 2;
    if (left + cardW > rect.width - pad) left = sx - cardW - 16;
    left = Math.max(pad, Math.min(rect.width - cardW - pad, left));
    top = Math.max(pad, Math.min(rect.height - cardH - pad, top));
    return { left, top, cardW };
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const poiCardPos = useMemo(() => openPOI ? getCardPos(openPOI.x, openPOI.y) : null, [openPOI?.id, transform.x, transform.y, transform.scale]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const markerCardPos = useMemo(() => openMarker ? getCardPos(openMarker.x, openMarker.y) : null, [openMarker?.id, transform.x, transform.y, transform.scale]);
  const sortedLibPOIs = useMemo(() => [...pois].sort((a,b)=>libSort==="name"?(a.name||"").localeCompare(b.name||""):(a.category||"").localeCompare(b.category||"")), [pois, libSort]);
  // Profile tab is available to everyone; library is GM-only (overlays/zones merged into library)
  const tabs = ["map", "info", ...(isGM ? ["library"] : []), "profile"];
  const TAB_LABELS = { map: "🗺 Map", info: "📜 Info", library: "📚 Library", profile: "👤 Profile" };
  const buildVersion = (typeof __BUILD_DATE__ !== "undefined" && typeof __COMMIT__ !== "undefined") ? `v${__BUILD_DATE__}-${__COMMIT__}` : "vdev";

  if (loading) return (
    <div style={{ position:"fixed",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"radial-gradient(ellipse at 30% 20%, #1A0A2E 0%, #080510 55%, #0A0508 100%)",gap:20 }}>
      <img src="/logo.png" alt="" style={{ width:100,height:"auto",opacity:0.7,animation:"shimmer 2s ease-in-out infinite" }} onError={e=>e.target.style.display="none"} />
      <div style={{ fontFamily:T.fHead,color:"#C9A84C",fontSize:13,letterSpacing:"0.25em",textTransform:"uppercase",opacity:0.8 }}>Loading…</div>
    </div>
  );

  if (!user) return (
    <div style={{ position:"fixed",inset:0,overflowY:"auto",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"100%",padding:32,fontFamily:T.fBody,
      WebkitFontSmoothing:"antialiased",MozOsxFontSmoothing:"grayscale",
      background:"linear-gradient(135deg, #0C0618 0%, #070310 40%, #110308 100%)",
      backgroundSize:"300% 300%", animation:"bgShift 20s ease-in-out infinite" }}>

      {/* ── Holy blob — patrols top-left, rushes to 3 impact points ── */}
      <div style={{ position:"fixed",top:"-8%",left:"-8%",width:"min(58vw,58vh)",height:"min(58vw,58vh)",maxWidth:660,maxHeight:660,borderRadius:"50%",
        background:"radial-gradient(circle, rgba(255,230,110,0.24) 0%, rgba(201,168,76,0.13) 35%, transparent 70%)",
        pointerEvents:"none", animation:"holyClash 24s linear infinite", willChange:"transform, opacity" }} />

      {/* ── Demonic blob — patrols bottom-right, rushes to 3 impact points ── */}
      <div style={{ position:"fixed",bottom:"-8%",right:"-8%",width:"min(58vw,58vh)",height:"min(58vw,58vh)",maxWidth:660,maxHeight:660,borderRadius:"50%",
        background:"radial-gradient(circle, rgba(210,35,20,0.28) 0%, rgba(140,20,15,0.15) 35%, transparent 70%)",
        pointerEvents:"none", animation:"demonicClash 24s linear infinite", willChange:"transform, opacity" }} />

      {/* ── Impact 1: upper-right (t=27%) ── */}
      <div style={{ position:"fixed",top:"12%",left:"72%",width:"min(50vw,50vh)",height:"min(50vw,50vh)",maxWidth:520,maxHeight:520,borderRadius:"50%",
        background:"radial-gradient(circle, rgba(255,220,100,0.92) 0%, rgba(220,80,20,0.55) 30%, rgba(160,20,10,0.2) 60%, transparent 75%)",
        pointerEvents:"none", animation:"clashFlash1 24s linear infinite", willChange:"transform, opacity" }} />
      <div style={{ position:"fixed",top:"12%",left:"72%",width:"min(72vw,72vh)",height:"min(72vw,72vh)",maxWidth:740,maxHeight:740,borderRadius:"50%",
        border:"2px solid rgba(255,195,60,0.7)", background:"transparent",
        pointerEvents:"none", animation:"shockRing1 24s linear infinite", willChange:"transform, opacity" }} />

      {/* ── Impact 2: centre (t=60%) ── */}
      <div style={{ position:"fixed",top:"48%",left:"44%",width:"min(50vw,50vh)",height:"min(50vw,50vh)",maxWidth:520,maxHeight:520,borderRadius:"50%",
        background:"radial-gradient(circle, rgba(255,220,100,0.92) 0%, rgba(220,80,20,0.55) 30%, rgba(160,20,10,0.2) 60%, transparent 75%)",
        pointerEvents:"none", animation:"clashFlash2 24s linear infinite", willChange:"transform, opacity" }} />
      <div style={{ position:"fixed",top:"48%",left:"44%",width:"min(72vw,72vh)",height:"min(72vw,72vh)",maxWidth:740,maxHeight:740,borderRadius:"50%",
        border:"2px solid rgba(255,195,60,0.7)", background:"transparent",
        pointerEvents:"none", animation:"shockRing2 24s linear infinite", willChange:"transform, opacity" }} />

      {/* ── Impact 3: lower-left (t=93%) ── */}
      <div style={{ position:"fixed",top:"75%",left:"18%",width:"min(50vw,50vh)",height:"min(50vw,50vh)",maxWidth:520,maxHeight:520,borderRadius:"50%",
        background:"radial-gradient(circle, rgba(255,220,100,0.92) 0%, rgba(220,80,20,0.55) 30%, rgba(160,20,10,0.2) 60%, transparent 75%)",
        pointerEvents:"none", animation:"clashFlash3 24s linear infinite", willChange:"transform, opacity" }} />
      <div style={{ position:"fixed",top:"75%",left:"18%",width:"min(72vw,72vh)",height:"min(72vw,72vh)",maxWidth:740,maxHeight:740,borderRadius:"50%",
        border:"2px solid rgba(255,195,60,0.7)", background:"transparent",
        pointerEvents:"none", animation:"shockRing3 24s linear infinite", willChange:"transform, opacity" }} />

      {/* ── Main content ── */}
      <div style={{ display:"flex",flexDirection:"column",alignItems:"center",maxWidth:500,width:"100%",position:"relative",zIndex:1 }}>

        {/* Logo */}
        <img src="/logo.png" alt="Verlantis"
          style={{ width:"min(320px, 82vw)",height:"auto",animation:"logoFadeIn 1.8s ease-out forwards",opacity:0,
            filter:"drop-shadow(0 0 30px rgba(201,168,76,0.2)) drop-shadow(0 0 60px rgba(160,30,20,0.15))" }}
          onError={e=>{ e.target.style.display="none"; }} />

        {/* VERLANTIS title */}
        <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:"clamp(28px,7vw,46px)",color:"#C9A84C",letterSpacing:"0.28em",textTransform:"uppercase",textAlign:"center",
          animation:"textFadeUp 1s ease-out 0.9s forwards",opacity:0,lineHeight:1,marginTop:4,
          textShadow:"0 0 60px rgba(201,168,76,0.4), 0 0 20px rgba(201,168,76,0.2), 0 2px 8px rgba(0,0,0,0.9)" }}>
          Verlantis
        </div>

        {/* Divider with clash colours */}
        <div style={{ display:"flex",alignItems:"center",gap:10,margin:"10px 0 8px",width:"100%",maxWidth:320,animation:"textFadeUp 1s ease-out 1.05s forwards",opacity:0 }}>
          <div style={{ flex:1,height:1,background:"linear-gradient(to right, transparent, rgba(255,200,60,0.5))" }} />
          <span style={{ fontSize:10,letterSpacing:"0.15em",color:"rgba(201,168,76,0.7)",fontFamily:T.fHead }}>✦</span>
          <div style={{ flex:1,height:1,background:"linear-gradient(to left, transparent, rgba(255,200,60,0.5))" }} />
        </div>

        {/* Interactive Map subtitle */}
        <div style={{ fontFamily:T.fHead,fontWeight:400,fontSize:"clamp(9px,2.2vw,12px)",color:"rgba(201,168,76,0.7)",letterSpacing:"0.4em",textTransform:"uppercase",
          animation:"textFadeUp 1s ease-out 1.1s forwards",opacity:0 }}>
          Interactive Map
        </div>

        {/* Holy / Demonic clash divider */}
        <div style={{ display:"flex",alignItems:"center",gap:0,margin:"24px 0 20px",width:"100%",maxWidth:340,animation:"textFadeUp 1s ease-out 1.3s forwards",opacity:0 }}>
          <div style={{ flex:1,height:1,background:"linear-gradient(to right, transparent, rgba(255,220,80,0.6), rgba(255,220,80,0.3))" }} />
          <div style={{ width:8,height:8,borderRadius:"50%",background:"radial-gradient(circle, #FFD700, #C9A84C)",boxShadow:"0 0 8px rgba(255,215,0,0.8)",margin:"0 6px",animation:"shimmer 2s ease-in-out infinite" }} />
          <div style={{ width:6,height:6,borderRadius:"50%",background:"radial-gradient(circle, #A83220, #6B1010)",boxShadow:"0 0 6px rgba(180,40,20,0.7)",margin:"0 6px",animation:"shimmer 2s ease-in-out infinite 1s" }} />
          <div style={{ flex:1,height:1,background:"linear-gradient(to left, transparent, rgba(180,40,20,0.6), rgba(180,40,20,0.3))" }} />
        </div>

        {/* Random Verlantis quote */}
        <div style={{ animation:"textFadeUp 1s ease-out 1.4s forwards",opacity:0,marginBottom:28,maxWidth:340,textAlign:"center" }}>
          <div style={{ color:"#C0B0D8",fontSize:12,fontStyle:"italic",lineHeight:1.85,fontFamily:T.fBody }}>
            "{randomQuote.quote}"
          </div>
          <div style={{ color:"rgba(201,168,76,0.55)",fontSize:10,letterSpacing:"0.08em",marginTop:8,fontFamily:T.fHead }}>
            — {randomQuote.attribution}
          </div>
        </div>

        {/* Sign in button */}
        <button onClick={signInWithGoogle}
          onMouseEnter={e=>{ e.currentTarget.style.borderColor="rgba(201,168,76,0.7)"; e.currentTarget.style.boxShadow="0 6px 36px rgba(201,168,76,0.15), 0 6px 36px rgba(160,30,20,0.1), inset 0 1px 0 rgba(201,168,76,0.2)"; }}
          onMouseLeave={e=>{ e.currentTarget.style.borderColor="rgba(201,168,76,0.25)"; e.currentTarget.style.boxShadow="0 4px 24px rgba(0,0,0,0.5)"; }}
          style={{ display:"flex",alignItems:"center",gap:10,padding:"13px 36px",fontSize:14,borderRadius:30,
            border:"1.5px solid rgba(201,168,76,0.25)",
            background:"linear-gradient(135deg, rgba(30,15,70,0.7) 0%, rgba(100,20,20,0.5) 100%)",
            cursor:"pointer",fontWeight:600,color:"#E8DCC8",fontFamily:T.fBody,
            boxShadow:"0 4px 24px rgba(0,0,0,0.5)",
            animation:"textFadeUp 1s ease-out 1.6s forwards",opacity:0,
            transition:"border-color 0.25s, box-shadow 0.25s",letterSpacing:"0.04em" }}>
          <img src="https://www.google.com/favicon.ico" width={16} height={16} alt="" style={{ opacity:0.85 }} />
          Sign in with Google
        </button>

        {/* Version */}
        <div style={{ color:"#5A4878",fontSize:10,letterSpacing:"0.12em",marginTop:28,animation:"textFadeUp 1s ease-out 1.8s forwards",opacity:0,fontFamily:T.fHead }}>
          {VERSION}
        </div>
      </div>
    </div>
  );

  if (!activeCampaign) return (
    <div style={{ position:"fixed",inset:0,overflowY:"auto",background:"linear-gradient(135deg, #0C0618 0%, #070310 50%, #110308 100%)",fontFamily:T.fBody,WebkitFontSmoothing:"antialiased",MozOsxFontSmoothing:"grayscale" }}>

      {/* ── Background blobs — ~60% of login intensity ── */}
      <div style={{ position:"fixed",top:"-8%",left:"-8%",width:"min(58vw,58vh)",height:"min(58vw,58vh)",maxWidth:640,borderRadius:"50%",
        background:"radial-gradient(circle, rgba(255,230,110,0.15) 0%, rgba(201,168,76,0.08) 38%, transparent 70%)",
        pointerEvents:"none", animation:"holyClash 24s linear infinite", willChange:"transform, opacity" }} />
      <div style={{ position:"fixed",bottom:"-8%",right:"-8%",width:"min(58vw,58vh)",height:"min(58vw,58vh)",maxWidth:640,borderRadius:"50%",
        background:"radial-gradient(circle, rgba(210,35,20,0.18) 0%, rgba(140,20,15,0.09) 38%, transparent 70%)",
        pointerEvents:"none", animation:"demonicClash 24s linear infinite", willChange:"transform, opacity" }} />

      {/* ── Impact flashes — ~65% of login opacity ── */}
      <div style={{ position:"fixed",top:"12%",left:"72%",width:"min(50vw,50vh)",height:"min(50vw,50vh)",maxWidth:520,borderRadius:"50%",
        background:"radial-gradient(circle, rgba(255,220,100,0.6) 0%, rgba(220,80,20,0.36) 30%, rgba(160,20,10,0.13) 60%, transparent 75%)",
        pointerEvents:"none", animation:"clashFlash1 24s linear infinite", willChange:"transform, opacity" }} />
      <div style={{ position:"fixed",top:"12%",left:"72%",width:"min(72vw,72vh)",height:"min(72vw,72vh)",maxWidth:740,borderRadius:"50%",
        border:"2px solid rgba(255,195,60,0.5)",background:"transparent",
        pointerEvents:"none", animation:"shockRing1 24s linear infinite", willChange:"transform, opacity" }} />
      <div style={{ position:"fixed",top:"48%",left:"44%",width:"min(50vw,50vh)",height:"min(50vw,50vh)",maxWidth:520,borderRadius:"50%",
        background:"radial-gradient(circle, rgba(255,220,100,0.6) 0%, rgba(220,80,20,0.36) 30%, rgba(160,20,10,0.13) 60%, transparent 75%)",
        pointerEvents:"none", animation:"clashFlash2 24s linear infinite", willChange:"transform, opacity" }} />
      <div style={{ position:"fixed",top:"48%",left:"44%",width:"min(72vw,72vh)",height:"min(72vw,72vh)",maxWidth:740,borderRadius:"50%",
        border:"2px solid rgba(255,195,60,0.5)",background:"transparent",
        pointerEvents:"none", animation:"shockRing2 24s linear infinite", willChange:"transform, opacity" }} />
      <div style={{ position:"fixed",top:"75%",left:"18%",width:"min(50vw,50vh)",height:"min(50vw,50vh)",maxWidth:520,borderRadius:"50%",
        background:"radial-gradient(circle, rgba(255,220,100,0.6) 0%, rgba(220,80,20,0.36) 30%, rgba(160,20,10,0.13) 60%, transparent 75%)",
        pointerEvents:"none", animation:"clashFlash3 24s linear infinite", willChange:"transform, opacity" }} />
      <div style={{ position:"fixed",top:"75%",left:"18%",width:"min(72vw,72vh)",height:"min(72vw,72vh)",maxWidth:740,borderRadius:"50%",
        border:"2px solid rgba(255,195,60,0.5)",background:"transparent",
        pointerEvents:"none", animation:"shockRing3 24s linear infinite", willChange:"transform, opacity" }} />

      {/* Scrollable content column */}
      <div style={{ maxWidth:520,margin:"0 auto",padding:"24px 20px",paddingBottom:"max(32px, env(safe-area-inset-bottom))",minHeight:"100dvh",display:"flex",flexDirection:"column",position:"relative",zIndex:1 }}>

        {/* ── Header ── */}
        <div style={{ display:"flex",alignItems:"center",gap:12,marginBottom:24,paddingBottom:16,borderBottom:"1px solid rgba(201,168,76,0.2)" }}>
          <img src="/logo.png" alt="Verlantis"
            style={{ width:36,height:"auto",opacity:0.9,filter:"drop-shadow(0 0 10px rgba(201,168,76,0.4))",flexShrink:0 }}
            onError={e=>e.target.style.display="none"} />
          <div style={{ flex:1,minWidth:0 }}>
            <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:17,color:"#C9A84C",letterSpacing:"0.14em",textShadow:"0 0 18px rgba(201,168,76,0.35)",lineHeight:1.15 }}>Verlantis</div>
            <div style={{ fontSize:10,color:"rgba(201,168,76,0.65)",letterSpacing:"0.16em",textTransform:"uppercase",fontFamily:T.fHead }}>Interactive Map</div>
          </div>
          <button onClick={()=>{setTutMode("campaign");setTutStep(0);}}
            style={{ padding:"5px 10px",borderRadius:20,border:"1px solid rgba(201,168,76,0.25)",background:"transparent",
              color:"rgba(201,168,76,0.6)",fontSize:11,cursor:"pointer",fontFamily:T.fHead,letterSpacing:"0.05em",flexShrink:0 }}>
            ? Tutorial
          </button>
          <button onClick={async()=>{await signOut(session.access_token);setUser(null);setSession(null);}}
            style={{ padding:"5px 14px",borderRadius:20,border:"1px solid rgba(201,168,76,0.35)",background:"transparent",
              color:"rgba(201,168,76,0.75)",fontSize:11,cursor:"pointer",fontFamily:T.fHead,letterSpacing:"0.07em",flexShrink:0,transition:"border-color 0.2s,color 0.2s" }}
            onMouseEnter={e=>{ e.currentTarget.style.borderColor="rgba(201,168,76,0.7)"; e.currentTarget.style.color="#C9A84C"; }}
            onMouseLeave={e=>{ e.currentTarget.style.borderColor="rgba(201,168,76,0.35)"; e.currentTarget.style.color="rgba(201,168,76,0.75)"; }}>
            Sign out
          </button>
        </div>

        {/* ── Error banner ── */}
        {error && (
          <div style={{ background:"rgba(180,30,20,0.15)",color:"#E06060",padding:"9px 14px",borderRadius:10,marginBottom:16,fontSize:13,border:"1px solid rgba(200,50,40,0.32)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8 }}>
            <span>{error}</span>
            <button onClick={()=>setError("")} style={{ border:"none",background:"none",cursor:"pointer",color:"#E06060",fontSize:15,lineHeight:1,padding:0,flexShrink:0 }}>✕</button>
          </div>
        )}

        {/* ── Loading ── */}
        {campaignLoading && (
          <div style={{ display:"flex",alignItems:"center",justifyContent:"center",padding:"48px 0",gap:12,color:"rgba(201,168,76,0.55)",fontSize:13 }}>
            <span style={{ animation:"spin 1s linear infinite",display:"inline-block",fontSize:20 }}>⟳</span> Loading campaigns…
          </div>
        )}

        {/* ── Empty state ── */}
        {!campaignLoading && campaigns.length === 0 && (
          <div style={{ textAlign:"center",padding:"48px 20px",color:"rgba(200,185,240,0.65)",fontSize:13,fontStyle:"italic",lineHeight:1.8 }}>
            No campaigns yet.<br/>Create one or join with a campaign ID from your GM.
          </div>
        )}

        {/* ── Section label ── */}
        {!campaignLoading && campaigns.length > 0 && (
          <div data-tut="tut-campaigns-label" style={{ fontSize:10,letterSpacing:"0.2em",textTransform:"uppercase",color:"rgba(201,168,76,0.65)",fontFamily:T.fHead,marginBottom:10 }}>
            Your Campaigns
          </div>
        )}

        {/* ── Campaign cards ── */}
        {campaigns.map(c => {
          const isGMRole = c.myRole === "gm";
          return (
            <div key={c.id} onClick={()=>loadCampaignData(c,c.myRole)}
              style={{ padding:"14px 16px",background:"rgba(255,255,255,0.045)",borderRadius:12,marginBottom:9,cursor:"pointer",
                border:`1.5px solid ${isGMRole?"rgba(201,168,76,0.28)":"rgba(130,100,210,0.28)"}`,
                boxShadow:"0 2px 14px rgba(0,0,0,0.35)",transition:"border-color 0.18s,background 0.18s",position:"relative" }}
              onMouseEnter={e=>{ e.currentTarget.style.borderColor=isGMRole?"rgba(201,168,76,0.65)":"rgba(155,120,235,0.6)"; e.currentTarget.style.background="rgba(255,255,255,0.075)"; }}
              onMouseLeave={e=>{ e.currentTarget.style.borderColor=isGMRole?"rgba(201,168,76,0.28)":"rgba(130,100,210,0.28)"; e.currentTarget.style.background="rgba(255,255,255,0.045)"; }}>
              <div style={{ display:"flex",alignItems:"center",gap:12 }}>
                {/* Role badge */}
                <div style={{ width:38,height:38,borderRadius:"50%",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,
                  background:isGMRole?"rgba(201,168,76,0.15)":"rgba(120,80,200,0.14)",
                  border:`1.5px solid ${isGMRole?"rgba(201,168,76,0.5)":"rgba(150,110,230,0.45)"}` }}>
                  {isGMRole ? "👑" : "⚔"}
                </div>
                {/* Info */}
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:14,color:"#EDE4CC",letterSpacing:"0.04em",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{c.name}</div>
                  {c.sub_header && <div style={{ fontSize:11,color:"rgba(215,185,100,0.85)",fontStyle:"italic",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{c.sub_header}</div>}
                  <div style={{ fontSize:10,color:isGMRole?"rgba(201,168,76,0.7)":"rgba(180,158,230,0.7)",marginTop:3,letterSpacing:"0.08em",textTransform:"uppercase",fontFamily:T.fHead }}>{isGMRole?"Game Master":"Player"}</div>
                </div>
                {/* Delete (GM only) */}
                {isGMRole && (
                  <button onClick={e=>{ e.stopPropagation(); setCampDeleteConfirm(c); }}
                    onTouchEnd={e=>{ e.stopPropagation(); e.preventDefault(); setCampDeleteConfirm(c); }}
                    title="Delete campaign"
                    style={{ background:"none",border:"1px solid rgba(200,50,40,0.4)",borderRadius:8,color:"rgba(220,100,90,0.8)",cursor:"pointer",padding:"5px 8px",fontSize:13,lineHeight:1,flexShrink:0,transition:"border-color 0.15s,color 0.15s" }}
                    onMouseEnter={e=>{ e.currentTarget.style.borderColor="rgba(200,50,40,0.75)"; e.currentTarget.style.color="#E86060"; }}
                    onMouseLeave={e=>{ e.currentTarget.style.borderColor="rgba(200,50,40,0.4)"; e.currentTarget.style.color="rgba(220,100,90,0.8)"; }}>
                    🗑
                  </button>
                )}
                <span style={{ fontSize:16,color:"rgba(201,168,76,0.55)",flexShrink:0 }}>›</span>
              </div>
            </div>
          );
        })}

        {/* ── Create / Join buttons ── */}
        {(()=>{ const ownedCount = campaigns.filter(c=>c.myRole==="gm").length; const atLimit = ownedCount >= 5; return (
          <div style={{ marginTop:campaigns.length>0?14:0,display:"flex",flexDirection:"column",gap:10 }}>
            <div style={{ display:"flex",gap:10 }}>
              <button
                data-tut="tut-create-btn"
                onClick={()=>{ if(atLimit){setError("You've reached the 5 campaign limit. Delete an existing campaign to create a new one.");return;} setShowCampaignModal(true); }}
                style={{ flex:1,padding:"11px 0",borderRadius:12,border:`1px solid ${atLimit?"rgba(201,168,76,0.2)":"rgba(201,168,76,0.45)"}`,
                  background:atLimit?"rgba(255,255,255,0.02)":"rgba(201,168,76,0.12)",
                  color:atLimit?"rgba(201,168,76,0.35)":"#C9A84C",fontSize:13,fontFamily:T.fHead,fontWeight:600,
                  letterSpacing:"0.07em",cursor:atLimit?"not-allowed":"pointer",transition:"background 0.2s,border-color 0.2s" }}
                onMouseEnter={e=>{ if(!atLimit){ e.currentTarget.style.background="rgba(201,168,76,0.22)"; e.currentTarget.style.borderColor="rgba(201,168,76,0.7)"; } }}
                onMouseLeave={e=>{ if(!atLimit){ e.currentTarget.style.background="rgba(201,168,76,0.12)"; e.currentTarget.style.borderColor="rgba(201,168,76,0.45)"; } }}>
                ＋ Create Campaign
              </button>
              <button
                data-tut="tut-join-btn"
                onClick={()=>setShowJoinModal(true)}
                style={{ flex:1,padding:"11px 0",borderRadius:12,border:"1px solid rgba(140,105,220,0.42)",
                  background:"rgba(120,80,200,0.1)",color:"rgba(200,182,245,0.9)",fontSize:13,
                  fontFamily:T.fHead,fontWeight:600,letterSpacing:"0.07em",cursor:"pointer",transition:"background 0.2s,border-color 0.2s" }}
                onMouseEnter={e=>{ e.currentTarget.style.background="rgba(120,80,200,0.2)"; e.currentTarget.style.borderColor="rgba(160,125,240,0.65)"; }}
                onMouseLeave={e=>{ e.currentTarget.style.background="rgba(120,80,200,0.1)"; e.currentTarget.style.borderColor="rgba(140,105,220,0.42)"; }}>
                Join Campaign
              </button>
            </div>
            {ownedCount > 0 && <div style={{ fontSize:11,color:atLimit?"#E06060":"rgba(201,168,76,0.55)",textAlign:"center",fontStyle:"italic" }}>You own {ownedCount}/5 campaigns{atLimit?" — limit reached":""}</div>}
          </div>
        ); })()}

        {/* Version */}
        <div style={{ fontSize:9,color:"rgba(140,120,180,0.45)",letterSpacing:"0.1em",textAlign:"center",marginTop:"auto",paddingTop:28,fontFamily:T.fHead }}>{VERSION}</div>

      </div>

      {tutMode === "campaign" && <TutorialOverlay steps={CAMPAIGN_STEPS} stepIndex={tutStep} onNext={tutNext} onPrev={tutPrev} onExit={tutDone} />}

      {/* ── Create Campaign modal ── */}
      {showCampaignModal && (
        <Modal title="Create Campaign" onClose={()=>{ setShowCampaignModal(false); setNewCampaignName(""); setNewCampaignSubHeader(""); setNewCampaignDescription(""); }} width={400}>
          <Field label="Campaign Name">
            <input value={newCampaignName} onChange={e=>setNewCampaignName(e.target.value)} style={IS} placeholder="e.g. The Verlantis Saga" autoFocus={!isTouchDevice} onKeyDown={e=>{if(e.key==="Enter")createCampaign();}} />
          </Field>
          <Field label="Sub Header (optional)">
            <input value={newCampaignSubHeader} onChange={e=>setNewCampaignSubHeader(e.target.value)} style={IS} placeholder="e.g. A tale of shadows and ancient power..." />
          </Field>
          <Field label="Description (optional)">
            <textarea value={newCampaignDescription} onChange={e=>setNewCampaignDescription(e.target.value)} rows={4}
              placeholder="Describe your campaign setting, the world, or any notes for your players..."
              style={{ ...IS, resize:"vertical", lineHeight:1.6 }} />
          </Field>
          <Btn variant="primary" onClick={createCampaign} style={{ width:"100%" }}>Create Campaign</Btn>
        </Modal>
      )}

      {/* ── Join Campaign modal ── */}
      {showJoinModal && (
        <Modal title="Join Campaign" onClose={()=>setShowJoinModal(false)} width={340}>
          <Field label="Campaign ID (ask your GM)"><input value={joinCode} onChange={e=>setJoinCode(e.target.value)} style={IS} placeholder="Paste campaign UUID here" autoFocus={!isTouchDevice} /></Field>
          <Btn variant="primary" onClick={joinCampaign} style={{ width:"100%" }}>Join</Btn>
        </Modal>
      )}

      {/* ── Delete confirmation ── */}
      {campDeleteConfirm && (
        <div style={{ position:"fixed",inset:0,zIndex:9000,display:"flex",alignItems:"center",justifyContent:"center",padding:16,background:"rgba(4,2,12,0.88)" }} onClick={()=>setCampDeleteConfirm(null)}>
          <div onClick={e=>e.stopPropagation()} style={{ background:"#0E0618",border:"2px solid rgba(200,50,40,0.5)",borderRadius:14,padding:"26px 24px 22px",maxWidth:400,width:"100%",boxShadow:"0 12px 48px rgba(0,0,0,0.75)" }}>
            <div style={{ display:"flex",alignItems:"center",gap:12,marginBottom:16 }}>
              <div style={{ fontSize:26,lineHeight:1 }}>⚠️</div>
              <div>
                <div style={{ fontFamily:T.fHead,fontSize:15,fontWeight:700,color:"#E06060",letterSpacing:"0.03em" }}>Delete Campaign Forever</div>
                <div style={{ fontSize:11,color:"rgba(180,140,140,0.55)",marginTop:2 }}>This action cannot be undone — ever.</div>
              </div>
            </div>
            <div style={{ background:"rgba(180,30,20,0.1)",border:"1px solid rgba(200,50,40,0.28)",borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:14,fontFamily:T.fHead,color:"#E06060",fontWeight:600 }}>
              "{campDeleteConfirm.name}"
            </div>
            <div style={{ fontSize:12,color:"rgba(180,160,220,0.45)",lineHeight:1.75,marginBottom:18 }}>
              <strong style={{ color:"rgba(220,80,70,0.75)",display:"block",marginBottom:4 }}>Everything inside will be permanently destroyed:</strong>
              All maps · All POIs & NPCs · All zones & overlays · All player markers · All announcements · All member data
            </div>
            <div style={{ display:"flex",gap:10 }}>
              <button onClick={()=>deleteCampaign(campDeleteConfirm)} style={{ flex:1,padding:"10px 0",borderRadius:20,border:"none",background:"rgba(170,30,20,0.85)",color:"#fff",fontFamily:T.fHead,fontSize:13,fontWeight:700,cursor:"pointer",letterSpacing:"0.04em" }}>🗑 Delete Forever</button>
              <button onClick={()=>setCampDeleteConfirm(null)} style={{ flex:1,padding:"10px 0",borderRadius:20,border:"1px solid rgba(120,100,160,0.28)",background:"transparent",color:"rgba(180,160,220,0.5)",fontFamily:T.fBody,fontSize:13,cursor:"pointer" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div style={{ fontFamily:T.fBody,fontSize:14,color:T.ink,display:"flex",flexDirection:"column",height:"100dvh",background:T.bg }}>
      {/* Header */}
      <div style={{ display:"flex",alignItems:"center",gap:10,padding:"0 14px",minHeight:52,borderBottom:`2px solid ${T.gold}44`,background:T.header,flexShrink:0 }}>
        {/* Back to campaign list */}
        <button data-tut="tut-back-btn" onClick={()=>{setActiveCampaign(null);localStorage.removeItem("sb_last_campaign");if(realtimeRef.current)realtimeRef.current.unsubscribe();}}
          title="All Campaigns"
          style={{ background:"none",border:"none",cursor:"pointer",fontSize:20,padding:"12px 6px 12px 0",color:T.headerFg,lineHeight:1,flexShrink:0 }}>←</button>
        {/* Campaign name + subtitle */}
        <div style={{ flex:1,minWidth:0 }}>
          <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:15,color:T.headerFg,letterSpacing:"0.06em",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",lineHeight:1.2 }}>{activeCampaign.name}</div>
          <div style={{ fontSize:9,color:`${T.headerFg}55`,letterSpacing:"0.04em",marginTop:1 }}>{VERSION}{activeCampaign.sub_header && ` · ${activeCampaign.sub_header}`}</div>
        </div>
        {/* Portal navigation buttons */}
        {mapStack.length>0 && <>
          <button onClick={goBack} style={{ padding:"5px 12px",borderRadius:20,border:`1px solid ${T.headerFg}44`,background:"transparent",color:T.headerFg,fontSize:11,cursor:"pointer",fontFamily:T.fBody,flexShrink:0 }}>↩ Back</button>
          {mapStack.length>1 && <button onClick={goHome} style={{ padding:"5px 12px",borderRadius:20,border:`1px solid ${T.gold}55`,background:"transparent",color:T.gold,fontSize:11,cursor:"pointer",fontFamily:T.fBody,flexShrink:0 }}>⌂ Main</button>}
        </>}
        {/* Role badge */}
        <span data-tut="tut-role-badge" style={{ fontSize:10,padding:"3px 10px",borderRadius:20,background:isGM?`${T.gold}30`:`${T.headerFg}18`,color:isGM?T.gold:`${T.headerFg}cc`,fontWeight:700,border:`1px solid ${isGM?`${T.gold}55`:`${T.headerFg}30`}`,fontFamily:T.fHead,letterSpacing:"0.06em",flexShrink:0 }}>{isGM?"GM":"Player"}</span>
        {/* Tutorial */}
        <button onClick={()=>{setTutMode(isGM?"gm":"player");setTutStep(0);}} title="Start guided tutorial" style={{ background:"none",border:`1px solid ${T.headerFg}33`,borderRadius:20,padding:"3px 9px",color:`${T.headerFg}99`,fontSize:10,cursor:"pointer",fontFamily:T.fBody,flexShrink:0 }}>? Tutorial</button>
        {/* Bell */}
        <button data-tut="tut-bell" onClick={()=>{setShowBell(b=>!b);setUnreadCount(0);}}
          style={{ position:"relative",background:"none",border:"none",cursor:"pointer",color:T.headerFg,fontSize:18,padding:"4px 2px",flexShrink:0,lineHeight:1 }} title="Notifications">
          🔔
          {unreadCount>0 && <span style={{ position:"absolute",top:-1,right:-2,background:T.danger,color:"#fff",fontSize:9,fontWeight:700,borderRadius:"50%",minWidth:14,height:14,display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1,padding:"0 2px" }}>{unreadCount>9?"9+":unreadCount}</span>}
        </button>
        {/* Profile dot — everyone gets one */}
        <div onClick={()=>setTab("profile")} title="Your profile"
          style={{ width:30,height:30,borderRadius:"50%",background:myColor||`${T.headerFg}33`,border:`2px solid ${myColor?T.gold:`${T.headerFg}44`}`,cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:myColor?"transparent":T.headerFg,fontWeight:700 }}>
          {!myColor&&"?"}
        </div>
      </div>

      {error && <div style={{ background:"#f5d5d5",color:T.danger,padding:"5px 14px",fontSize:12,borderBottom:`1px solid ${T.danger}44` }}>{error}<button onClick={()=>setError("")} style={{ marginLeft:8,border:"none",background:"none",cursor:"pointer",color:T.danger }}>✕</button></div>}
      {isGM && (
        <div data-tut="tut-invite-bar" style={{ display:"flex",alignItems:"center",gap:8,padding:"4px 14px",background:`${T.gold}12`,fontSize:11,color:T.goldDim,borderBottom:`1px solid ${T.border}` }}>
          <span style={{ color:T.muted }}>Invite code:</span>
          <code style={{ fontFamily:"monospace",fontSize:11,background:T.surface,color:T.ink,padding:"1px 8px",borderRadius:6,border:`1px solid ${T.border}`,letterSpacing:"0.02em" }}>{activeCampaign.id}</code>
          <button onClick={()=>{
            const copy = () => { navigator.clipboard.writeText(activeCampaign.id).catch(()=>{}); };
            try { copy(); } catch {
              const el = document.createElement("textarea"); el.value = activeCampaign.id;
              el.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(el);
              el.select(); document.execCommand("copy"); document.body.removeChild(el);
            }
            setCopiedCode(true); setTimeout(()=>setCopiedCode(false), 2000);
          }} style={{ padding:"2px 10px",borderRadius:20,border:`1px solid ${T.border}`,background:copiedCode?`${T.gold}22`:T.bg,color:copiedCode?T.goldDim:T.muted,fontSize:11,cursor:"pointer",flexShrink:0,fontWeight:copiedCode?700:400,fontFamily:T.fBody }}>
            {copiedCode ? "✓ Copied" : "Copy"}
          </button>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:"flex",borderBottom:`1px solid ${T.border}`,padding:"0 10px",background:T.surface,overflowX:"auto" }}>
        {tabs.map(t=>(
          <button key={t} data-tut={`tut-tab-${t}`} onClick={()=>setTab(t)}
            style={{ padding:"10px 14px",border:"none",borderBottom:tab===t?`2.5px solid ${T.gold}`:"2.5px solid transparent",background:"transparent",cursor:"pointer",fontSize:13,fontWeight:tab===t?700:400,color:tab===t?T.goldDim:T.muted,fontFamily:T.fBody,letterSpacing:"0.01em",whiteSpace:"nowrap" }}>
            {TAB_LABELS[t]||t}
          </button>
        ))}
      </div>

      {/* MAP TAB */}
      {tab==="map" && (
        <div style={{ flex:1,display:"flex",flexDirection:"column",minHeight:0,position:"relative" }}>
          {/* ── Map toolbar ── */}
          <div style={{ display:"flex",flexDirection:"column",borderBottom:`1px solid ${T.border}`,background:T.surface,flexShrink:0 }}>
            {/* Row 1: action buttons + map selector + filter */}
            <div style={{ display:"flex",gap:6,padding:"8px 14px",alignItems:"center",flexWrap:"wrap" }}>
              {/* Placement actions */}
              <div style={{ display:"flex",gap:4,flexShrink:0 }}>
                {isGM && <>
                  <span data-tut="tut-poi-btn"><Btn size="sm" onClick={()=>setPlacingMode(p=>p==="poi"?null:"poi")} style={{ background:placingMode==="poi"?`${T.gold}22`:undefined,borderColor:placingMode==="poi"?T.gold:undefined }}>＋ POI</Btn></span>
                  <span data-tut="tut-npc-btn"><Btn size="sm" onClick={()=>setNpcForm({npc:null,name:"",status:"Alive",border_color:"#C9A84C",aura_radius:80,show_name:true,show_status:true,show_aura:true,is_visible_to_players:false,x:200,y:200})}>＋ NPC</Btn></span>
                  <Btn size="sm" onClick={()=>setTextForm({text:null,content:"New Text",font_size:28,color:"#FFFFFF",font_weight:"700",fade_enabled:false,fade_invert:false,x:Math.round(imgSize.w/2),y:Math.round(imgSize.h/2)})}>＋ Text</Btn>
                </>}
                <span data-tut="tut-marker-btn"><Btn size="sm" onClick={()=>{
                  if (!myColor && !isGM) { setShowColorPicker(true); return; }
                  setPlacingMode(p=>p==="marker"?null:"marker");
                }} style={{ background:placingMode==="marker"?`${T.gold}22`:undefined,borderColor:placingMode==="marker"?T.gold:undefined }}>
                  ＋ Marker{!isGM ? ` (${myMarkers.length}/${markerLimit}${myMarkers.length>=markerLimit?" full":""})` : ""}
                </Btn></span>
              </div>
              {/* Visual separator */}
              <div style={{ width:1,height:20,background:T.border,flexShrink:0 }} />
              {/* View controls */}
              <Btn size="sm" onClick={resetView} style={{ flexShrink:0 }}>Fit ⟳ (F)</Btn>
              {accessibleMaps.length > 1 && (
                <select value={activeMapId||""} onChange={e=>{
                  const target = maps.find(m=>m.id===e.target.value);
                  if (!isGM && target && !target.is_main && !target.player_accessible) {
                    addToast("🔒 The GM has locked access to this area.", "denied"); return;
                  }
                  setMapStack([]); switchToMap(e.target.value);
                }} style={{ fontSize:12,padding:"4px 8px",borderRadius:8,border:`1px solid ${T.border}`,background:T.bg,color:T.ink,fontFamily:T.fBody,maxWidth:140,flexShrink:0 }}>
                  {accessibleMaps.map(m=><option key={m.id} value={m.id}>{m.name}{m.is_main?" ★":""}</option>)}
                </select>
              )}
              {/* Spacer */}
              <div style={{ flex:1 }} />
              {/* Layers panel toggle — only when there are layers/zones */}
              {(mapOverlays.length > 0 || mapZones.filter(z => isGM || z.revealed).length > 0) && (
                <button onClick={()=>setShowLayerControls(f=>!f)}
                  style={{ padding:"5px 12px",borderRadius:8,border:`1px solid ${showLayerControls?T.gold:T.border}`,background:showLayerControls?`${T.gold}22`:T.bg,color:showLayerControls?T.goldDim:T.muted,fontSize:12,cursor:"pointer",flexShrink:0,fontFamily:T.fBody }}>
                  Layer Opacity
                </button>
              )}
              {/* Filter toggle */}
              <button onClick={()=>setShowFilter(f=>!f)}
                style={{ padding:"5px 12px",borderRadius:8,border:`1px solid ${showFilter?T.gold:T.border}`,background:showFilter?T.purple:T.bg,color:showFilter?T.headerFg:T.muted,fontSize:12,cursor:"pointer",flexShrink:0,fontFamily:T.fBody }}>
                ☰ Filter
              </button>
            </div>
            {/* Row 2: zoom speed + active mode status */}
            <div style={{ display:"flex",alignItems:"center",gap:8,padding:"4px 14px 7px",flexWrap:"wrap" }}>
              <span style={{ fontSize:11,color:T.muted,whiteSpace:"nowrap",flexShrink:0 }}>Zoom Speed</span>
              <input type="range" min={0.1} max={2} step={0.1} value={scrollSens} onChange={e=>setScrollSens(Number(e.target.value))} style={{ width:90,flexShrink:0 }} />
              <span style={{ fontSize:11,color:T.muted,minWidth:22,flexShrink:0 }}>{scrollSens.toFixed(1)}×</span>
              {/* Placing mode indicators */}
              {placingMode && placingMode !== "zone" && placingMode !== "addpoint" && !editingZonePoints && (
                <span style={{ fontSize:11,color:T.purple,padding:"2px 10px",background:`${T.purple}12`,borderRadius:20,border:`1px solid ${T.purple}33` }}>Tap map to place {placingMode}</span>
              )}
              {placingMode === "zone" && (
                <span style={{ display:"flex",alignItems:"center",gap:6,flexWrap:"wrap" }}>
                  <span style={{ fontSize:11,color:T.purple,padding:"2px 10px",background:`${T.purple}12`,borderRadius:20 }}>Zone: {placingZonePoints?.length || 0} pts</span>
                  {(placingZonePoints?.length || 0) >= 3 && (
                    <Btn size="sm" variant="primary" onClick={()=>{ setPlacingMode(null); setZoneForm({ zone:null, name:"", fill_color:"#3498DB", opacity:80, revealed:false, points:placingZonePoints }); setPlacingZonePoints(null); }}>Close Zone ✓</Btn>
                  )}
                  <Btn size="sm" onClick={()=>{ setPlacingMode(null); setPlacingZonePoints(null); }}>Cancel</Btn>
                </span>
              )}
              {placingMode === "addpoint" && (
                <span style={{ display:"flex",alignItems:"center",gap:6 }}>
                  <span style={{ fontSize:11,color:"#E67E22",padding:"2px 10px",background:"#FEF3E2",borderRadius:20 }}>Tap map to add point</span>
                  <Btn size="sm" onClick={()=>{ setPlacingMode(null); addPointZoneRef.current = null; }}>Cancel</Btn>
                </span>
              )}
              {editingZonePoints && (
                <span style={{ display:"flex",alignItems:"center",gap:6 }}>
                  <span style={{ fontSize:11,color:"#9B59B6",padding:"2px 10px",background:"#F5EEF8",borderRadius:20 }}>Drag waypoints to reposition</span>
                  <Btn size="sm" variant="primary" onClick={saveZonePoints}>Save</Btn>
                  <Btn size="sm" onClick={cancelZonePointEdit}>Cancel</Btn>
                </span>
              )}
            </div>
            {/* Row 3: Search bar */}
            {(()=>{
              const q = searchQuery.trim().toLowerCase();
              const tagMatch = q ? CATEGORIES.find(c => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) : null;
              const nameMatch = q && !tagMatch ? (mapPOIs.find(p=>p.name?.toLowerCase().includes(q)) || mapNPCs.find(n=>(isGM||n.show_name)&&n.name?.toLowerCase().includes(q))) : null;
              const hint = !q ? "" : tagMatch ? `Showing: ${tagMatch.label}` : nameMatch ? `Found: ${nameMatch.name}` : "No match";
              const hintColor = !q ? T.muted : (tagMatch||nameMatch) ? T.goldDim : "#E06060";
              return (
                <div data-tut="tut-search" style={{ display:"flex",alignItems:"center",gap:6,padding:"0 14px 8px",opacity:searchMoving?0.6:1,transition:"opacity 0.3s" }}>
                  <div style={{ display:"flex",alignItems:"center",flex:1,background:T.bg,border:`1px solid ${q?(tagMatch?T.gold:"rgba(120,80,200,0.6)"):T.border}`,borderRadius:20,height:32,minWidth:0 }}>
                    <span style={{ padding:"0 8px",fontSize:13,color:T.muted,flexShrink:0 }}>🔍</span>
                    <input
                      value={searchQuery}
                      onChange={e=>{ const v=e.target.value; setSearchQuery(v); if(!v.trim()){setSearchPing(null);} }}
                      onKeyDown={e=>{ if(e.key==="Enter") handleSearch(e.target.value); }}
                      placeholder="Search POI, NPC, or tag…"
                      style={{ border:"none",outline:"none",background:"transparent",fontSize:13,color:T.ink,fontFamily:T.fBody,flex:1,minWidth:0,padding:"0 4px",lineHeight:1 }}
                    />
                    {searchQuery && (
                      <button onClick={()=>{ setSearchQuery(""); setSearchPing(null); }} style={{ background:"none",border:"none",cursor:"pointer",color:T.muted,fontSize:16,padding:"0 8px",lineHeight:1,flexShrink:0 }}>✕</button>
                    )}
                  </div>
                  {q && <span style={{ fontSize:11,color:hintColor,whiteSpace:"nowrap",flexShrink:0 }}>{hint}</span>}
                </div>
              );
            })()}
          </div>
          {/* ── Personal visibility filter dropdown ── */}
          {showFilter && (()=>{
            const mapPortals = mapPOIs.filter(p=>p.poi_type==="portal");
            const mapStandardPOIs = mapPOIs.filter(p=>p.poi_type!=="portal");
            const allVisible =
              CATEGORIES.every(c => isVisible("categories", c.id)) &&
              members.every(m => isVisible("players", m.user_id)) &&
              mapZones.every(z => isVisible("zones", z.id)) &&
              mapOverlays.every(ov => (overlaySettings[ov.id]?.visible ?? true)) &&
              mapNPCs.every(n => isVisible("npcs", n.id)) &&
              mapPortals.every(p => isVisible("portals", p.id));
            function setAllVis(show) {
              const cats = {}; CATEGORIES.forEach(c => { cats[c.id] = show; });
              const plays = {}; members.forEach(m => { plays[m.user_id] = show; });
              const zns = {}; mapZones.forEach(z => { zns[z.id] = show; });
              const npcMap = {}; mapNPCs.forEach(n => { npcMap[n.id] = show; });
              const portMap = {}; mapPortals.forEach(p => { portMap[p.id] = show; });
              setVisFilter({ categories:cats, players:plays, zones:zns, npcs:npcMap, portals:portMap });
              mapOverlays.forEach(ov => setOverlaySetting(ov.id,"visible",show));
            }
            const rowStyle = { display:"flex",alignItems:"center",gap:8,padding:"4px 14px",cursor:"pointer" };
            const headStyle = { fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",padding:"6px 14px 2px",letterSpacing:"0.05em" };
            return (
              <div style={{ position:"absolute",top:80,right:14,zIndex:300,background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,boxShadow:"0 4px 18px rgba(26,16,53,0.18)",minWidth:230,maxHeight:360,overflowY:"auto",paddingBottom:6,fontFamily:T.fBody }}>
                {/* Toggle All */}
                <label style={{ ...rowStyle, borderBottom:`0.5px solid ${T.border}`,paddingBottom:8,marginBottom:2,fontWeight:600,fontSize:12 }}>
                  <input type="checkbox" checked={allVisible} onChange={()=>setAllVis(!allVisible)} />
                  <span>Toggle All</span>
                </label>
                {/* POI Categories */}
                {CATEGORIES.length > 0 && <div style={headStyle}>POI Categories</div>}
                {CATEGORIES.map(cat => (
                  <label key={cat.id} style={{ ...rowStyle, fontSize:12 }}>
                    <input type="checkbox" checked={isVisible("categories", cat.id)} onChange={e=>setVis("categories", cat.id, e.target.checked)} />
                    <span style={{ width:10,height:10,borderRadius:"50%",background:cat.color,display:"inline-block",flexShrink:0,border:"1px solid #0003" }} />
                    <span>{cat.label}</span>
                  </label>
                ))}
                {/* Portals */}
                {mapPortals.length > 0 && <div style={headStyle}>Portals</div>}
                {mapPortals.map(p => (
                  <label key={p.id} style={{ ...rowStyle, fontSize:12 }}>
                    <input type="checkbox" checked={isVisible("portals", p.id)} onChange={e=>setVis("portals", p.id, e.target.checked)} />
                    <span style={{ fontSize:13 }}>⛩</span>
                    <span>{p.name||"Unnamed portal"}</span>
                  </label>
                ))}
                {/* NPC Nodes */}
                {mapNPCs.length > 0 && <div style={headStyle}>NPC Nodes</div>}
                {mapNPCs.map(n => (
                  <label key={n.id} style={{ ...rowStyle, fontSize:12 }}>
                    <input type="checkbox" checked={isVisible("npcs", n.id)} onChange={e=>setVis("npcs", n.id, e.target.checked)} />
                    <span style={{ width:10,height:10,borderRadius:"50%",background:n.border_color,display:"inline-block",flexShrink:0,border:"1px solid #0003" }} />
                    <span>{n.show_name ? n.name : "???"}</span>
                  </label>
                ))}
                {/* Player Markers */}
                {members.length > 0 && <div style={headStyle}>Player Markers</div>}
                {members.map(mb => (
                  <label key={mb.user_id} style={{ ...rowStyle, fontSize:12 }}>
                    <input type="checkbox" checked={isVisible("players", mb.user_id)} onChange={e=>setVis("players", mb.user_id, e.target.checked)} />
                    <span style={{ width:10,height:10,borderRadius:"50%",background:mb.player_color||"#378ADD",display:"inline-block",flexShrink:0 }} />
                    <span>{mb.display_name||"(no name)"}</span>
                  </label>
                ))}
                {/* Zones */}
                {mapZones.length > 0 && <div style={headStyle}>Zones</div>}
                {mapZones.map(z => (
                  <label key={z.id} style={{ ...rowStyle, fontSize:12 }}>
                    <input type="checkbox" checked={isVisible("zones", z.id)} onChange={e=>setVis("zones", z.id, e.target.checked)} />
                    <span style={{ width:10,height:10,borderRadius:3,background:z.fill_color,display:"inline-block",flexShrink:0 }} />
                    <span>{z.name||"Unnamed zone"}</span>
                  </label>
                ))}
                {/* Overlay Layers */}
                {mapOverlays.length > 0 && <div style={headStyle}>Overlay Layers</div>}
                {mapOverlays.map(ov => {
                  const s = overlaySettings[ov.id] || { visible: true };
                  return (
                    <label key={ov.id} style={{ ...rowStyle, fontSize:12 }}>
                      <input type="checkbox" checked={s.visible !== false} onChange={e=>setOverlaySetting(ov.id,"visible",e.target.checked)} />
                      <span>{ov.name||"Unnamed layer"}</span>
                    </label>
                  );
                })}
              </div>
            );
          })()}


          {/* ── Layers & Zones floating panel — appears over the map ── */}
          {showLayerControls && (
            <div style={{ position:"absolute",top:0,left:0,right:0,bottom:0,zIndex:250,pointerEvents:"none" }}>
              <div style={{ position:"absolute",top:8,left:8,background:T.bg,border:`1.5px solid ${T.gold}`,borderRadius:12,boxShadow:"0 8px 28px rgba(26,16,53,0.25)",minWidth:260,maxWidth:320,pointerEvents:"all" }}
                onMouseDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()}>
                <div style={{ display:"flex",alignItems:"center",padding:"10px 14px",borderBottom:`1px solid ${T.border}`,background:T.header,borderRadius:"10px 10px 0 0" }}>
                  <span style={{ fontFamily:T.fHead,fontSize:13,fontWeight:700,color:T.headerFg,flex:1,letterSpacing:"0.04em" }}>🗂 Layers &amp; Zones</span>
                  <button onClick={()=>setShowLayerControls(false)} style={{ background:"none",border:"none",color:T.headerFg,cursor:"pointer",fontSize:16,padding:0,lineHeight:1 }}>✕</button>
                </div>
                <div style={{ padding:"10px 14px",display:"flex",flexDirection:"column",gap:10,maxHeight:"50vh",overflowY:"auto" }}>
                  {/* Master zone opacity */}
                  {mapZones.filter(z => isGM || z.revealed).length > 0 && (
                    <div>
                      <div style={{ fontSize:11,color:T.muted,fontWeight:600,marginBottom:6,textTransform:"uppercase",letterSpacing:"0.06em" }}>Zones</div>
                      <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                        <span style={{ fontSize:12,color:T.ink,minWidth:70,whiteSpace:"nowrap" }}>All Zones</span>
                        <input type="range" min={0} max={100} value={masterZoneOpacity}
                          onChange={e=>{ const v=Number(e.target.value); setMasterZoneOpacity(v); if(activeCampaign) localStorage.setItem(`zone_master_${activeCampaign.id}`,String(v)); }}
                          style={{ flex:1 }} />
                        <span style={{ fontSize:11,color:T.muted,minWidth:36,textAlign:"right" }}>{masterZoneOpacity}%</span>
                      </div>
                    </div>
                  )}
                  {/* Per-layer opacity + visibility */}
                  {mapOverlays.length > 0 && (
                    <div>
                      <div style={{ fontSize:11,color:T.muted,fontWeight:600,marginBottom:6,textTransform:"uppercase",letterSpacing:"0.06em",borderTop:mapZones.filter(z=>isGM||z.revealed).length>0?`0.5px solid ${T.border}`:"none",paddingTop:mapZones.filter(z=>isGM||z.revealed).length>0?10:0 }}>Image Layers</div>
                      {mapOverlays.map(ov=>{
                        const s = overlaySettings[ov.id] || { opacity:80, visible:true };
                        return (
                          <div key={ov.id} style={{ display:"flex",alignItems:"center",gap:8 }}>
                            <span style={{ fontSize:12,color:T.ink,minWidth:70,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontWeight:500 }}>{ov.name}</span>
                            <input type="range" min={1} max={100} value={s.opacity}
                              onChange={e=>setOverlaySetting(ov.id,"opacity",Number(e.target.value))}
                              style={{ flex:1 }} />
                            <span style={{ fontSize:11,color:T.muted,minWidth:36,textAlign:"right" }}>{s.opacity}%</span>
                            <button onClick={()=>setOverlaySetting(ov.id,"visible",!s.visible)}
                              style={{ fontSize:11,padding:"3px 10px",borderRadius:20,border:"none",background:s.visible?"#EAF3DE":"#F0F0F0",color:s.visible?"#3B6D11":"#888",cursor:"pointer",flexShrink:0,fontWeight:600 }}>
                              {s.visible?"On":"Off"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div style={{ flex:1,minHeight:0,position:"relative" }}>
            <div ref={mapRef} style={{ position:"absolute",inset:0,overflow:"hidden",background:"#1a1a2e",cursor:placingMode?"crosshair":isDragging?"grabbing":"grab",touchAction:"none",userSelect:"none" }}
              onMouseDown={onPointerDown} onTouchStart={onPointerDown}
              onClick={()=>{ setMovingPOI(null); setMoveDropdownPos(null); if(!dragRef.current.moved){ closePOICard(); closeMarkerCard(); } }}>
              {!currentMap ? (
                <div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",color:"#aaa",gap:8 }}>
                  <span style={{ fontSize:40 }}>🗺</span>
                  <span style={{ fontSize:13 }}>{isGM?"Go to Library to upload a map.":"Waiting for GM to load a map."}</span>
                </div>
              ) : (
                <div ref={mapTransformDivRef} style={{ position:"absolute",transform: mapInteracting ? `translate3d(${Math.round(transform.x)}px,${Math.round(transform.y)}px,0) scale(${transform.scale})` : `translate(${Math.round(transform.x)}px,${Math.round(transform.y)}px) scale(${transform.scale})`,transformOrigin:"0 0",willChange:mapInteracting?"transform":"auto" }}>
                  <img src={currentMap.src} alt="map" style={{ display:"block",maxWidth:"none" }} draggable={false} onLoad={onImgLoad}
                    onError={e=>{ e.target.style.display="none"; }} />
                  {/* Overlay image layers — per-user opacity/visibility */}
                  {mapOverlays.map(ov => {
                    const s = overlaySettings[ov.id] || { opacity: 80, visible: true };
                    if (!s.visible) return null;
                    return <img key={ov.id} src={ov.src} alt={ov.name} draggable={false}
                      style={{ position:"absolute",left:0,top:0,width:imgSize.w,height:imgSize.h,opacity:s.opacity/100,pointerEvents:"none",display:"block",objectFit:"fill" }} />;
                  })}
                  {/* Zone polygon layer — SVG scales with map transform */}
                  {(mapZones.length > 0 || (placingZonePoints && placingZonePoints.length > 0)) && imgSize.w > 0 && (
                    <svg style={{ position:"absolute",left:0,top:0,width:imgSize.w,height:imgSize.h,overflow:"visible",pointerEvents:"none" }}>
                      <defs>
                        {mapZones.map(z => {
                          if (!z.image_url) return null;
                          if (z.image_repeat) {
                            const bbox = getZoneBBox(z.points);
                            const base = Math.min(bbox.w, bbox.h) * 0.35;
                            const tile = Math.max(8, base * (z.image_scale || 100) / 100);
                            const speed = Math.max(1, z.scroll_speed || 20);
                            const dur = `${(tile / speed).toFixed(2)}s`;
                            return (
                              <pattern key={z.id} id={`zpat-${z.id}`} patternUnits="userSpaceOnUse"
                                x={bbox.x} y={bbox.y} width={tile} height={tile}>
                                <image href={z.image_url} width={tile} height={tile} preserveAspectRatio="xMidYMid slice" />
                                {z.animate_scroll && (
                                  <animateTransform attributeName="patternTransform" type="translate"
                                    from="0,0" to={`${tile},${tile}`} dur={dur} repeatCount="indefinite" additive="sum" />
                                )}
                              </pattern>
                            );
                          }
                          return (
                            <clipPath key={z.id} id={`zclip-${z.id}`}>
                              <polygon points={z.points.map(p=>`${p.x},${p.y}`).join(" ")} />
                            </clipPath>
                          );
                        })}
                      </defs>
                      {mapZones.filter(z=>isVisible("zones", z.id)).map(z => {
                        if (!isGM && !z.revealed) return null;
                        if (editingZonePoints && z.id === editingZonePoints.zoneId) return null; // rendered separately below
                        const pts = z.points.map(p=>`${p.x},${p.y}`).join(" ");
                        const sw = Math.max(1, 2/transform.scale);
                        return (
                          <g key={z.id} opacity={(z.opacity/100) * (masterZoneOpacity/100)}
                            onClick={e=>{ e.stopPropagation(); if(suppressClickRef.current){suppressClickRef.current=false;return;} if(isGM && placingMode !== "zone" && placingMode !== "addpoint") setZoneForm({zone:z,name:z.name,fill_color:z.fill_color,opacity:z.opacity,revealed:z.revealed,points:[...z.points]}); }}
                            style={{ pointerEvents: isGM && placingMode !== "zone" && placingMode !== "addpoint" ? "all" : "none", cursor: isGM ? "pointer" : "default" }}>
                            <polygon points={pts} fill={z.fill_color} />
                            {z.image_url && (z.image_repeat
                              ? <polygon points={pts} fill={`url(#zpat-${z.id})`} />
                              : (() => {
                                  const bbox = getZoneBBox(z.points);
                                  const s = (z.image_scale || 100) / 100;
                                  const iw = Math.max(1, bbox.w * s), ih = Math.max(1, bbox.h * s);
                                  return <image href={z.image_url}
                                    x={bbox.x + (bbox.w - iw)/2} y={bbox.y + (bbox.h - ih)/2}
                                    width={iw} height={ih}
                                    clipPath={`url(#zclip-${z.id})`}
                                    preserveAspectRatio="xMidYMid slice" />;
                                })()
                            )}
                            {/* Border: dashed when hidden from players */}
                            <polygon points={pts} fill="none" stroke={z.revealed ? z.fill_color : "#ffffff"} strokeWidth={sw}
                              strokeDasharray={z.revealed ? undefined : `${6/transform.scale},${3/transform.scale}`} style={{ pointerEvents:"none" }} />
                          </g>
                        );
                      })}
                      {/* Waypoint drag-to-move editor */}
                      {editingZonePoints && (() => {
                        const { points } = editingZonePoints;
                        const sw = Math.max(1, 2/transform.scale);
                        const r = Math.max(5, 9/transform.scale);
                        const pts = points.map(p=>`${p.x},${p.y}`).join(" ");
                        function startPointDrag(e, i) {
                          e.stopPropagation();
                          const cx = e.touches ? e.touches[0].clientX : e.clientX;
                          const cy = e.touches ? e.touches[0].clientY : e.clientY;
                          zonePointDragRef.current = { index: i, startCx: cx, startCy: cy, startX: points[i].x, startY: points[i].y };
                          function onMove(ev) {
                            if (!zonePointDragRef.current) return;
                            const mx = ev.touches ? ev.touches[0].clientX : ev.clientX;
                            const my = ev.touches ? ev.touches[0].clientY : ev.clientY;
                            const nx = zonePointDragRef.current.startX + (mx - zonePointDragRef.current.startCx) / transformRef.current.scale;
                            const ny = zonePointDragRef.current.startY + (my - zonePointDragRef.current.startCy) / transformRef.current.scale;
                            setEditingZonePoints(prev => {
                              const np = [...prev.points]; np[zonePointDragRef.current.index] = { x: nx, y: ny };
                              return { ...prev, points: np };
                            });
                          }
                          function onUp() {
                            zonePointDragRef.current = null;
                            window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
                            window.removeEventListener("touchmove", onMove); window.removeEventListener("touchend", onUp);
                          }
                          window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
                          window.addEventListener("touchmove", onMove, { passive: true }); window.addEventListener("touchend", onUp);
                        }
                        return <g>
                          <polygon points={pts} fill="#9B59B6" opacity={0.15} />
                          <polyline points={pts + ` ${points[0].x},${points[0].y}`} fill="none" stroke="#9B59B6" strokeWidth={sw} />
                          {points.map((p, i) => (
                            <g key={i}>
                              <circle cx={p.x} cy={p.y} r={r} fill="#9B59B6" stroke="#ffffff" strokeWidth={sw}
                                style={{ cursor:"move", pointerEvents:"all" }}
                                onMouseDown={e => startPointDrag(e, i)}
                                onTouchStart={e => startPointDrag(e, i)} />
                              <text x={p.x} y={p.y - r - 3/transform.scale} textAnchor="middle"
                                fill="#ffffff" fontSize={Math.max(8, 10/transform.scale)}
                                style={{ pointerEvents:"none", userSelect:"none" }}>{i+1}</text>
                            </g>
                          ))}
                        </g>;
                      })()}
                      {/* Live waypoint preview while placing a new zone */}
                      {placingZonePoints && placingZonePoints.length > 0 && (() => {
                        const sw = Math.max(1, 2/transform.scale);
                        const r = Math.max(3, 5/transform.scale);
                        const pts = placingZonePoints.map(p=>`${p.x},${p.y}`).join(" ");
                        return <g>
                          {placingZonePoints.length >= 3 && <polygon points={pts} fill="#3498DB" opacity={0.25} />}
                          <polyline points={pts} fill="none" stroke="#ffffff" strokeWidth={sw} strokeDasharray={`${4/transform.scale},${2/transform.scale}`} />
                          {placingZonePoints.map((p,i) => (
                            <circle key={i} cx={p.x} cy={p.y} r={r} fill="#3C3489" stroke="#ffffff" strokeWidth={Math.max(1,1.5/transform.scale)} />
                          ))}
                        </g>;
                      })()}
                    </svg>
                  )}
                  <div ref={poiLayerRef} style={{ opacity:poiOpacity, transition:"opacity 0.15s ease" }}>
                  {mapPOIs.filter(p=>{
                    if (!inViewport(p.x, p.y)) return false;
                    const baseVisible = p.poi_type==="portal" ? isVisible("portals", p.id) : isVisible("categories", p.category);
                    if (!baseVisible) return false;
                    const sq = searchQuery.trim().toLowerCase();
                    if (!sq) return true;
                    // If query matches a tag/category label — only show POIs of that category
                    const tagHit = CATEGORIES.find(c => c.label.toLowerCase().includes(sq) || c.id.toLowerCase().includes(sq));
                    if (tagHit) return p.category === tagHit.id;
                    // Otherwise name search — show all (camera handles navigation)
                    return true;
                  }).map(p=>(
                    <POIPin key={p.id} poi={p} isGM={isGM}
                      resolvedIconUrl={categoryIcons[p.category]||""}
                      onTap={poi=>{
                        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                        if (isGM) {
                          // GM tap on any POI → open edit form (lock only prevents dragging, not editing)
                          setPoiForm({ poi, name:poi.name, description:poi.description, revealed:poi.revealed, category:poi.category||"other", size:poi.size||"large", poi_type:poi.poi_type||"standard", linked_map_id:poi.linked_map_id||null });
                        } else if (poi.poi_type==="portal" && poi.linked_map_id) {
                          // Player tap on portal → toggle POI details card
                          if (openPOICard===poi.id) { closePOICard(); } else { closePOICard(); setTimeout(()=>setOpenPOICard(poi.id),0); }
                        } else {
                          // Player tap on standard POI → toggle details card
                          if (openPOICard===poi.id) { closePOICard(); } else { closePOICard(); setTimeout(()=>setOpenPOICard(poi.id),0); }
                        }
                      }}
                      onDragStart={startPOIDrag} />
                  ))}
                  </div>
                  {/* NPC nodes */}
                  {mapNPCs.filter(n=>inViewport(n.x, n.y) && isVisible("npcs", n.id)).map(npc => {
                    const r = npc.aura_radius > 0 ? npc.aura_radius : 0;
                    const nodeR = 18;
                    const ns = Math.max(14, nodeR/transform.scale);
                    const bw = Math.max(1, 2/transform.scale);
                    const fs = Math.max(7, 10/transform.scale);
                    const showName = isGM || npc.show_name;
                    const showStatus = isGM || npc.show_status;
                    const showAura = npc.show_aura && r > 0;
                    const pad = Math.max(r, ns/2);
                    const rippleR = ns * 0.88;
                    const rippleDelay = `${(parseInt(npc.id.slice(-4), 16) % 250) / 100}s`;
                    return (
                      <div key={npc.id} style={{ position:"absolute", left:npc.x-pad, top:npc.y-pad, width:pad*2, height:pad*2, pointerEvents:"none" }}>
                        {showAura && <div style={{ position:"absolute", left:pad-r, top:pad-r, width:r*2, height:r*2, borderRadius:"50%", border:`${bw}px dashed ${npc.border_color}`, background:`${npc.border_color}1A`, pointerEvents:"none" }} />}
                        {/* Sonar-ping ripple — makes NPCs noticeable on crowded maps */}
                        <div style={{ position:"absolute", left:pad-rippleR, top:pad-rippleR, width:rippleR*2, height:rippleR*2, borderRadius:"50%", border:`${Math.max(1,2/transform.scale)}px solid ${npc.border_color}`, animation:"npcRipple 2.6s ease-out infinite", animationDelay:rippleDelay, pointerEvents:"none" }} />
                        <div
                          onMouseDown={isGM ? e=>startNPCDrag(e,npc) : undefined}
                          onTouchStart={isGM ? e=>startNPCDrag(e,npc) : undefined}
                          style={{ position:"absolute", left:pad-ns/2, top:pad-ns/2, width:ns, height:ns, borderRadius:"50%", background:`${npc.border_color}33`, border:`${bw}px solid ${npc.border_color}`, cursor:isGM?"grab":"default", pointerEvents:"all", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 0 ${6/transform.scale}px ${npc.border_color}88` }}>
                          <span style={{ fontSize:fs*0.9, pointerEvents:"none", userSelect:"none" }}>👤</span>
                        </div>
                        <div style={{ position:"absolute", left:pad, top:pad+ns/2+4/transform.scale, transform:"translateX(-50%)", fontSize:fs, fontWeight:700, fontFamily:T.fMap, letterSpacing:"0.03em", color:npc.border_color, textShadow:"0 0 4px #000, 0 0 8px #000, 0 1px 3px #000, -1px 0 3px #000, 1px 0 3px #000", whiteSpace:"nowrap", pointerEvents:"none", userSelect:"none", lineHeight:1.3 }}>
                          {showName ? npc.name : "???"}
                          {showStatus && <span style={{ opacity:0.8, fontWeight:400 }}> · {npc.show_status ? npc.status : "???"}</span>}
                        </div>
                      </div>
                    );
                  })}
                  {mapMarkers.filter(m=>inViewport(m.x, m.y) && isVisible("players", m.user_id)).map(m => {
                    const isOwner = m.user_id === user.id;
                    const memberInfo = members.find(mb => mb.user_id === m.user_id);
                    return (
                      <MarkerPin key={m.id} marker={m} scale={transform.scale} isOwner={isOwner} isGM={isGM}
                        displayName={memberInfo?.display_name}
                        memberColor={memberInfo?.player_color}
                        onTap={marker => { setOpenMarkerCard(openMarkerCard === marker.id ? null : marker.id); }}
                        onDragStart={isOwner ? startMarkerDrag : () => {}} />
                    );
                  })}
                  {/* ── Text overlays — highest layer ── */}
                  {mapTexts.filter(t => t.map_id === activeMapId).map(t => {
                    let opacity = 1;
                    if (t.fade_enabled && fitScale > 0) {
                      const progress = Math.min(1, Math.max(0, (transform.scale - fitScale) / fitScale));
                      opacity = t.fade_invert ? 1 - progress : progress;
                    }
                    // Below 50% opacity: click-through for everyone (UI: disable collision when faded)
                    const canInteract = opacity >= 0.5;
                    return (
                      <div key={t.id}
                        data-text-overlay={t.id}
                        onMouseDown={isGM && canInteract ? e => { e.stopPropagation(); startTextDrag(e, t); } : undefined}
                        onTouchStart={isGM && canInteract ? e => { e.stopPropagation(); startTextDrag(e, t); } : undefined}
                        style={{ position:"absolute", left:t.x, top:t.y, fontSize:t.font_size, fontWeight:t.font_weight||"700", fontFamily:T.fMap, color:t.color||"#FFFFFF", opacity, whiteSpace:"pre-wrap", lineHeight:1.4, letterSpacing:"0.02em", textShadow:"0 0 4px #000, 0 0 10px #000, 0 1px 3px #000", pointerEvents:canInteract&&isGM?"all":"none", cursor:isGM?(t.locked?"pointer":"grab"):"default", userSelect:"none", zIndex:60, maxWidth:600 }}>
                        {t.content}
                      </div>
                    );
                  })}
                  {/* ── Search ping ring ── */}
                  {searchPing && (
                    <div style={{ position:"absolute", left:searchPing.x, top:searchPing.y, pointerEvents:"none", zIndex:200 }}>
                      <div style={{ position:"absolute", transform:"translate(-50%,-50%)", width:48/transform.scale, height:48/transform.scale, borderRadius:"50%", border:`${3/transform.scale}px solid #C9A84C`, boxShadow:`0 0 ${12/transform.scale}px rgba(201,168,76,0.6)`, animation:"searchPing 1.4s ease-out infinite", pointerEvents:"none" }} />
                      <div style={{ position:"absolute", transform:"translate(-50%,-50%)", width:28/transform.scale, height:28/transform.scale, borderRadius:"50%", border:`${2/transform.scale}px solid rgba(201,168,76,0.7)`, animation:"searchPing 1.4s ease-out infinite", animationDelay:"0.3s", pointerEvents:"none" }} />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* On-map portal back button — shown when navigated via portal */}
            {mapStack.length > 0 && (
              <div style={{ position:"absolute", bottom:16, left:"50%", transform:"translateX(-50%)", zIndex:200, display:"flex", gap:8, pointerEvents:"all" }}>
                <button onClick={goBack}
                  style={{ padding:"8px 18px", borderRadius:24, border:`2px solid ${T.gold}`, background:T.header, color:T.headerFg, fontFamily:T.fHead, fontSize:13, fontWeight:600, cursor:"pointer", boxShadow:"0 4px 16px rgba(0,0,0,0.5)", display:"flex", alignItems:"center", gap:6, whiteSpace:"nowrap" }}>
                  ↩ Go Back
                </button>
                {mapStack.length > 1 && (
                  <button onClick={goHome}
                    style={{ padding:"8px 18px", borderRadius:24, border:`2px solid ${T.gold}66`, background:T.purple, color:T.headerFg, fontFamily:T.fHead, fontSize:13, fontWeight:600, cursor:"pointer", boxShadow:"0 4px 16px rgba(0,0,0,0.5)", display:"flex", alignItems:"center", gap:6, whiteSpace:"nowrap" }}>
                    ⌂ Main Map
                  </button>
                )}
              </div>
            )}

            {/* Map-switch fade overlay */}
            {mapFadeState && (
              <div style={{ position:"absolute",inset:0,zIndex:400,background:T.bg,
                animation:`${mapFadeState==="covering"?"mapOverlayIn 0.25s":"mapOverlayOut 0.35s"} ease forwards`,
                pointerEvents:mapFadeState==="covering"?"all":"none",
                display:"flex",alignItems:"center",justifyContent:"center" }}>
                {mapFadeState==="covering" && (
                  <span style={{ fontFamily:T.fHead,fontSize:14,color:T.muted,letterSpacing:"0.1em",opacity:0.7 }}>✦  Loading Map  ✦</span>
                )}
              </div>
            )}

            {/* POI popup — stays mounted during fade-out (poiCardClosing) */}
            {openPOI && poiCardPos && (()=>{
              const cc = getCatColor(openPOI.category);
              const isClosing = !!poiCardClosing && !openPOICard;
              return (
              <div key={openPOI.id} onMouseDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()}
                style={{ position:"absolute",left:poiCardPos.left,top:poiCardPos.top,width:poiCardPos.cardW,background:T.bg,borderRadius:12,border:`1.5px solid ${cc}`,zIndex:100,overflow:"hidden",boxSizing:"border-box",boxShadow:"0 6px 24px rgba(26,16,53,0.22)",animation:`${isClosing?"popupFadeOut 0.25s":"popupFadeIn 0.3s"} ease forwards`,pointerEvents:isClosing?"none":"all" }}>
                {/* Coloured header strip */}
                <div style={{ display:"flex",alignItems:"center",gap:10,padding:"10px 12px 8px",borderBottom:`1px solid ${cc}33`,background:cc+"18" }}>
                  <div style={{ width:34,height:34,borderRadius:"50%",border:`2px solid ${cc}`,overflow:"hidden",flexShrink:0,background:cc+"28",display:"flex",alignItems:"center",justifyContent:"center" }}>
                    {(openPOI.icon_url||categoryIcons[openPOI.category])?<img src={openPOI.icon_url||categoryIcons[openPOI.category]} alt="" draggable={false} style={{ width:"100%",height:"100%",objectFit:"contain" }} />:<span style={{ fontSize:14,fontWeight:700,color:cc }}>?</span>}
                  </div>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontWeight:700,fontSize:13,color:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:T.fHead }}>{openPOI.name}</div>
                    <div style={{ fontSize:10,color:cc,fontWeight:600,marginTop:1 }}>{getCatLabel(openPOI.category)}</div>
                  </div>
                </div>
                <div onMouseDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()}
                  style={{ padding:"9px 12px",fontSize:12,color:T.muted,lineHeight:1.6,maxHeight:110,overflowY:"auto",touchAction:"pan-y" }}>
                  {openPOI.description||<span style={{ fontStyle:"italic" }}>No description.</span>}
                </div>
                {openPOI.poi_type==="portal" && openPOI.linked_map_id && (()=>{
                  const tMap = maps.find(m=>m.id===openPOI.linked_map_id);
                  const locked = tMap && !tMap.is_main && !tMap.player_accessible;
                  return (
                    <div style={{ padding:"8px 12px",borderTop:`0.5px solid ${T.border}` }}>
                      {locked
                        ? <div style={{ fontSize:11,color:T.muted,fontStyle:"italic",textAlign:"center",padding:"2px 0" }}>🔒 The GM has locked access to this area.</div>
                        : <button
                            onClick={()=>{ const m=maps.find(x=>x.id===openPOI.linked_map_id); if(!m){addToast("⚠ Destination map not found","error");return;} switchToMap(m.id,{push:true}); closePOICard(); }}
                            style={{ width:"100%",padding:"7px 12px",borderRadius:20,border:"none",background:T.purple,color:T.headerFg,fontFamily:T.fHead,fontSize:12,fontWeight:600,cursor:"pointer" }}>
                            ✦ Travel to {tMap?.name||"…"}
                          </button>
                      }
                    </div>
                  );
                })()}
                <div style={{ padding:"6px 12px 10px",textAlign:"right",borderTop:`0.5px solid ${T.border}` }}>
                  <Btn size="sm" onClick={closePOICard}>Close</Btn>
                </div>
              </div>
              );
            })()}

            {/* Marker popup — stays mounted during fade-out (markerCardClosing) */}
            {openMarker && markerCardPos && (() => {
              const openMarkerColor = openMarkerMember?.player_color || openMarker.player_color || "#378ADD";
              const isClosing = !!markerCardClosing && !openMarkerCard;
              return (
              <div key={openMarker.id} onMouseDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()}
                style={{ position:"absolute",left:markerCardPos.left,top:markerCardPos.top,width:markerCardPos.cardW,background:T.bg,borderRadius:12,border:`1.5px solid ${openMarkerColor}`,zIndex:100,overflow:"hidden",boxSizing:"border-box",boxShadow:"0 6px 24px rgba(26,16,53,0.22)",animation:`${isClosing?"popupFadeOut 0.25s":"popupFadeIn 0.3s"} ease forwards`,pointerEvents:isClosing?"none":"all" }}>
                <div style={{ display:"flex",alignItems:"center",gap:10,padding:"10px 12px 8px",borderBottom:`1px solid ${openMarkerColor}33`,background:openMarkerColor+"18" }}>
                  <div style={{ width:28,height:28,borderRadius:"50% 50% 50% 0",transform:"rotate(-45deg)",background:openMarkerColor,border:`2px solid ${T.bg}`,flexShrink:0 }} />
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontWeight:700,fontSize:13,color:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:T.fHead }}>{openMarker.label||"Marker"}</div>
                    <div style={{ fontSize:10,color:T.muted,marginTop:1 }}>{openMarkerMember?.display_name || openMarker.user_name?.split(" ")[0] || "Player"}</div>
                  </div>
                </div>
                {openMarker.description && (
                  <div onMouseDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()}
                    style={{ padding:"9px 12px",fontSize:12,color:T.muted,lineHeight:1.6,maxHeight:80,overflowY:"auto",touchAction:"pan-y" }}>
                    {openMarker.description}
                  </div>
                )}
                <div style={{ padding:"6px 12px 10px",display:"flex",gap:6,justifyContent:"flex-end",borderTop:`0.5px solid ${T.border}` }}>
                  {openMarker.user_id === user.id && <>
                    <Btn size="sm" onClick={()=>{ setMarkerForm({ marker: openMarker }); closeMarkerCard(); }}>Edit</Btn>
                    <Btn size="sm" variant="danger" onClick={()=>deleteMarker(openMarker.id)}>Delete</Btn>
                  </>}
                  {isGM && openMarker.user_id !== user.id && <Btn size="sm" variant="danger" onClick={()=>deleteMarker(openMarker.id)}>Delete</Btn>}
                  <Btn size="sm" onClick={closeMarkerCard}>Close</Btn>
                </div>
              </div>
              );
            })()}
          </div>

          {/* Tutorial hint bar removed — hints moved to ? Tutorial button */}
        </div>
      )}

      {/* INFO TAB */}
      {tab==="info" && (
        <div style={{ flex:1,overflowY:"auto",padding:"20px 16px",animation:"tabFadeIn 0.2s ease" }}>
          {campInfoEdit === null ? (
            <div style={{ maxWidth:560 }}>
              {/* Campaign title block */}
              <div style={{ padding:"16px 20px",background:T.surface,borderRadius:12,border:`1.5px solid ${T.border}`,marginBottom:20 }}>
                <h2 style={{ margin:"0 0 4px",fontSize:20,fontWeight:700,fontFamily:T.fHead,color:T.ink,letterSpacing:"0.03em" }}>{activeCampaign?.name}</h2>
                {activeCampaign?.sub_header && <div style={{ fontSize:13,color:T.goldDim,fontStyle:"italic",marginBottom:10,fontFamily:T.fBody }}>{activeCampaign.sub_header}</div>}
                {activeCampaign?.description
                  ? <p style={{ fontSize:13,color:T.ink,lineHeight:1.8,marginTop:8,whiteSpace:"pre-wrap",margin:0 }}>{activeCampaign.description}</p>
                  : <p style={{ color:T.muted,fontSize:13,fontStyle:"italic",margin:0 }}>{isGM ? "No description yet — click Edit to add one." : "No campaign description has been added yet."}</p>
                }
                {isGM && <Btn size="sm" onClick={()=>setCampInfoEdit({ name:activeCampaign?.name||"", sub_header:activeCampaign?.sub_header||"", description:activeCampaign?.description||"" })} style={{ marginTop:14 }}>✎ Edit Campaign Info</Btn>}
              </div>
              {isGM && (
                <div style={{ marginTop:20,padding:"14px 16px",background:"#1e0e0e",borderRadius:10,border:`1.5px solid ${T.danger}66` }}>
                  <div style={{ fontSize:11,fontWeight:700,color:"#ff7070",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:6 }}>⚠ Danger Zone</div>
                  <div style={{ fontSize:12,color:"#e8c4c4",marginBottom:10,lineHeight:1.5 }}>Deleting this campaign is <strong style={{ color:"#ff7070" }}>permanent and irreversible</strong>. All maps, POIs, NPCs, markers, zones, and player data will be destroyed forever.</div>
                  <Btn variant="danger" size="sm" onClick={()=>setCampDeleteConfirm(activeCampaign)}>🗑 Delete This Campaign</Btn>
                </div>
              )}
            </div>
          ) : (
            <div style={{ maxWidth:560 }}>
              <h3 style={{ margin:"0 0 16px",fontSize:15,fontWeight:700,fontFamily:T.fHead,color:T.ink,letterSpacing:"0.04em" }}>Edit Campaign Info</h3>
              <Field label="Campaign Name"><input value={campInfoEdit.name} onChange={e=>setCampInfoEdit(p=>({...p,name:e.target.value}))} style={IS} /></Field>
              <Field label="Sub Header"><input value={campInfoEdit.sub_header} onChange={e=>setCampInfoEdit(p=>({...p,sub_header:e.target.value}))} placeholder="e.g. A dark fantasy adventure..." style={IS} /></Field>
              <Field label="Description"><textarea value={campInfoEdit.description} onChange={e=>setCampInfoEdit(p=>({...p,description:e.target.value}))} rows={6} placeholder="Describe the campaign setting..." style={{ ...IS,resize:"vertical",lineHeight:1.7 }} /></Field>
              <div style={{ display:"flex",gap:8 }}>
                <Btn variant="primary" onClick={saveCampaignInfo}>Save Changes</Btn>
                <Btn onClick={()=>setCampInfoEdit(null)}>Cancel</Btn>
              </div>
            </div>
          )}

          {/* Announcements */}
          <div style={{ maxWidth:560,marginTop:20,borderTop:`1px solid ${T.border}`,paddingTop:20 }}>
            <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:14 }}>
              <span style={{ fontFamily:T.fHead,fontWeight:700,fontSize:15,color:T.ink }}>📜 Announcements</span>
              {isGM && <Btn size="sm" variant="primary" onClick={()=>setAnnounceForm({announcement:null,title:"",sub_header:"",message:""})}>＋ New</Btn>}
            </div>
            {announcements.length===0 && <p style={{ color:T.muted,fontSize:13,fontStyle:"italic" }}>No announcements yet.</p>}
            {announcements.map(a=>(
              <div key={a.id} style={{ padding:"12px 16px",background:T.surface,borderRadius:10,marginBottom:10,border:`1px solid ${T.border}`,boxShadow:"0 1px 4px rgba(26,16,53,0.06)" }}>
                <div style={{ display:"flex",alignItems:"flex-start",gap:10 }}>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:13,color:T.ink }}>{a.title||"(No title)"}</div>
                    {a.sub_header && <div style={{ fontSize:11,color:T.goldDim,fontStyle:"italic",marginTop:2 }}>{a.sub_header}</div>}
                    {a.message && <div style={{ fontSize:12,color:T.ink,lineHeight:1.7,marginTop:8,whiteSpace:"pre-wrap" }}>{a.message}</div>}
                    <div style={{ fontSize:10,color:T.muted,marginTop:8 }}>{new Date(a.created_at).toLocaleDateString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</div>
                  </div>
                  {isGM && <div style={{ display:"flex",gap:4,flexShrink:0 }}>
                    <Btn size="sm" onClick={()=>setAnnounceForm({announcement:a,title:a.title,sub_header:a.sub_header||"",message:a.message||""})}>✎</Btn>
                    <Btn size="sm" variant="danger" onClick={()=>deleteAnnouncement(a.id)}>✕</Btn>
                  </div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* LIBRARY TAB — GM only; alphabetical sub-tabs */}
      {tab==="library" && isGM && (
        <div style={{ display:"flex",flexDirection:"column",flex:1,minHeight:0,animation:"tabFadeIn 0.2s ease" }}>
          {/* Sub-tab bar — alphabetical: Categories, Layers, Maps, NPCs, Players, POIs, Zones */}
          <div style={{ display:"flex",borderBottom:`1px solid ${T.border}`,padding:"0 10px",background:T.surface,overflowX:"auto" }}>
            {[
              { id:"categories", label:"Categories" },
              { id:"layers",     label:"Layers" },
              { id:"maps",       label:"Maps" },
              { id:"npcs",       label:"NPCs" },
                { id:"pois",       label:"POIs" },
              { id:"zones",      label:"Zones" },
              { id:"texts",      label:"Texts" },
            ].map(({ id, label })=>(
              <button key={id} onClick={()=>setLibSubTab(id)}
                style={{ padding:"8px 13px",border:"none",borderBottom:libSubTab===id?`2.5px solid ${T.gold}`:"2.5px solid transparent",background:"transparent",cursor:"pointer",fontSize:12,fontWeight:libSubTab===id?700:400,color:libSubTab===id?T.goldDim:T.muted,fontFamily:T.fBody,whiteSpace:"nowrap" }}>
                {label}
              </button>
            ))}
          </div>

          <div style={{ flex:1,overflowY:"auto",padding:"16px 14px" }}>

            {/* ── CATEGORIES ── */}
            {libSubTab==="categories" && <>
              <div style={{ marginBottom:14 }}>
                <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:14,color:T.ink,marginBottom:4 }}>Category Icons</div>
                <p style={{ fontSize:12,color:T.muted,margin:0 }}>Assign a default icon per category. POIs without a custom icon use this automatically.</p>
              </div>
              {CATEGORIES.map(cat=>{
                const iconUrl = categoryIcons[cat.id];
                return (
                  <div key={cat.id} style={{ display:"flex",alignItems:"center",gap:12,padding:"10px 12px",background:T.surface,borderRadius:10,marginBottom:8,border:`1px solid ${T.border}` }}>
                    <div style={{ width:38,height:38,borderRadius:"50%",border:`2.5px solid ${cat.color}`,overflow:"hidden",flexShrink:0,background:cat.color+"28",display:"flex",alignItems:"center",justifyContent:"center" }}>
                      {iconUrl?<img src={iconUrl} alt="" draggable={false} style={{ width:"100%",height:"100%",objectFit:"contain" }} />:<span style={{ fontSize:13,fontWeight:700,color:cat.color }}>?</span>}
                    </div>
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ fontSize:13,fontWeight:600,color:T.ink }}>{cat.label}</div>
                      <div style={{ width:28,height:6,borderRadius:3,background:cat.color,marginTop:3 }} />
                    </div>
                    <div style={{ display:"flex",gap:6 }}>
                      <FilePicker label={iconUrl?"Replace":"Upload"} onFile={f=>saveCategoryIcon(cat.id,f)} />
                      {iconUrl && <Btn size="sm" variant="danger" onClick={()=>removeCategoryIcon(cat.id)}>Clear</Btn>}
                    </div>
                  </div>
                );
              })}
            </>}

            {/* ── LAYERS ── */}
            {libSubTab==="layers" && <>
              <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:8 }}>
                <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:14,color:T.ink,flex:1 }}>Image Layers</div>
                <FilePicker label="＋ Upload Layer" onFile={uploadOverlay} />
              </div>
              <p style={{ fontSize:12,color:T.muted,marginBottom:14 }}>Transparent PNG/JPEG images displayed above the map. Control opacity &amp; visibility from the "Layers &amp; Zones" strip on the Map tab.</p>
              {mapOverlays.length===0 && <p style={{ color:T.muted,fontSize:13,fontStyle:"italic" }}>No layers yet.</p>}
              {mapOverlays.map(ov=>(
                <div key={ov.id} style={{ display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:T.surface,borderRadius:10,marginBottom:8,border:`1px solid ${T.border}` }}>
                  <img src={ov.src} alt={ov.name} style={{ width:44,height:44,objectFit:"cover",borderRadius:8,flexShrink:0,border:`1px solid ${T.border}` }} />
                  {renamingOverlay?.id === ov.id ? <>
                    <input autoFocus={!isTouchDevice} value={renamingOverlay.name}
                      onChange={e=>setRenamingOverlay(r=>({...r,name:e.target.value}))}
                      onKeyDown={e=>{ if(e.key==="Enter") saveOverlayName(); if(e.key==="Escape") setRenamingOverlay(null); }}
                      style={{ flex:1,...IS,padding:"4px 10px" }} />
                    <Btn size="sm" variant="primary" onClick={saveOverlayName}>Save</Btn>
                    <Btn size="sm" onClick={()=>setRenamingOverlay(null)}>Cancel</Btn>
                  </> : <>
                    <div style={{ flex:1,fontSize:13,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:T.ink }}>{ov.name}</div>
                    <Btn size="sm" onClick={()=>setRenamingOverlay({id:ov.id,name:ov.name})}>Rename</Btn>
                    <Btn size="sm" variant="danger" onClick={()=>deleteOverlay(ov.id)}>Delete</Btn>
                  </>}
                </div>
              ))}
            </>}

            {/* ── MAPS ── */}
            {libSubTab==="maps" && <>
              <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:14 }}>
                <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:14,color:T.ink,flex:1 }}>Maps</div>
                <FilePicker label="＋ Upload Map" onFile={uploadMap} />
              </div>
              {maps.length===0 && <p style={{ color:T.muted,fontSize:13,fontStyle:"italic" }}>No maps yet. Upload an image to get started.</p>}
              <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:12 }}>
                {maps.map(m=>(
                  <div key={m.id} style={{ border:m.is_main?`2px solid ${T.gold}`:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden",background:T.surface,boxShadow:m.is_main?"0 2px 12px rgba(201,168,76,0.18)":"none" }}>
                    <div style={{ position:"relative" }}>
                      <img src={m.src} alt={m.name} style={{ width:"100%",height:80,objectFit:"cover",display:"block" }} />
                      {m.is_main && <div style={{ position:"absolute",top:6,left:6,background:T.gold,color:T.ink,fontSize:9,fontWeight:700,fontFamily:T.fHead,padding:"2px 7px",borderRadius:10,letterSpacing:"0.04em" }}>★ MAIN</div>}
                    </div>
                    <div style={{ padding:"8px 10px" }}>
                      <div style={{ fontSize:12,fontWeight:600,color:T.ink,marginBottom:7,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{m.name}</div>
                      <div style={{ display:"flex",gap:4,flexWrap:"wrap" }}>
                        {!m.is_main && <Btn size="sm" variant="primary" onClick={()=>setMainMap(m.id)}>Set Main</Btn>}
                        {!m.is_main && (
                          <button onClick={()=>toggleMapAccess(m.id,m.player_accessible)}
                            style={{ padding:"4px 8px",fontSize:11,borderRadius:8,border:"none",background:m.player_accessible?"#EAF3DE":"#F5F0E8",color:m.player_accessible?"#3B6D11":T.muted,cursor:"pointer",fontWeight:600 }}>
                            {m.player_accessible?"🔓 Open":"🔒 Locked"}
                          </button>
                        )}
                        <Btn size="sm" variant="danger" onClick={()=>setMapDeleteConfirm(m.id)}>Delete</Btn>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>}

            {/* ── NPCS ── */}
            {libSubTab==="npcs" && <>
              <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:8 }}>
                <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:14,color:T.ink,flex:1 }}>VIP NPCs</div>
                <Btn size="sm" variant="primary" onClick={()=>{setNpcForm({npc:null,name:"",status:"Alive",border_color:"#C9A84C",aura_radius:80,show_name:true,show_status:true,show_aura:true,is_visible_to_players:false,x:200,y:200});setTab("map");}}>＋ Add NPC</Btn>
              </div>
              <p style={{ fontSize:12,color:T.muted,marginBottom:14 }}>NPC nodes appear on the map as draggable icons. Fields can be individually hidden from players (shown as "???").</p>
              {npcs.length===0 && <p style={{ color:T.muted,fontSize:13,fontStyle:"italic" }}>No NPCs in this campaign yet.</p>}
              {npcs.map(npc=>{
                const npcMapName = maps.find(m=>m.id===npc.map_id)?.name || "Unknown map";
                const onCurrentMap = npc.map_id === activeMapId;
                return (
                <div key={npc.id} style={{ display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:T.surface,borderRadius:10,marginBottom:8,border:`1px solid ${T.border}` }}>
                  <div style={{ width:28,height:28,borderRadius:"50%",background:`${npc.border_color}28`,border:`2.5px solid ${npc.border_color}`,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13 }}>👤</div>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontSize:13,fontWeight:600,color:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{npc.name}</div>
                    <div style={{ fontSize:11,color:T.muted }}>{npc.status} · {onCurrentMap ? "this map" : npcMapName}</div>
                  </div>
                  <button onClick={()=>{ const n=npcs.find(x=>x.id===npc.id); if(n){setNpcForm({npc:n,...n});setTab("map");} }}
                    style={{ padding:"4px 10px",borderRadius:20,border:"none",background:npc.is_visible_to_players?"#EAF3DE":"#FEF3E2",color:npc.is_visible_to_players?"#3B6D11":"#854F0B",fontSize:11,fontWeight:600,cursor:"pointer",flexShrink:0 }}>
                    {npc.is_visible_to_players?"Revealed":"Hidden"}
                  </button>
                  <Btn size="sm" onClick={()=>{const n=npcs.find(x=>x.id===npc.id);if(n) setNpcForm({npc:n,...n});}}>Edit</Btn>
                </div>
                );
              })}
            </>}


            {/* ── POIS ── */}
            {libSubTab==="pois" && (()=>{
              // ── Helper: render one POI row ──
              const renderPOIRow = (p, showMove) => {
                const cc = getCatColor(p.category);
                const iconUrl = p.icon_url || categoryIcons[p.category] || "";
                const isCheckpoint = p.poi_type === "checkpoint";
                return (
                  <div key={p.id} style={{ display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:T.bg,borderTop:`0.5px solid ${T.border}` }}>
                    {/* Icon */}
                    <div style={{ width:30,height:30,borderRadius:isCheckpoint?4:"50%",border:`2px ${p.revealed?"solid":"dashed"} ${cc}`,overflow:"hidden",flexShrink:0,background:cc+"28",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}
                      onClick={()=>{ setMovingPOI(null); setPoiForm({poi:p,name:p.name,description:p.description,revealed:p.revealed,category:p.category||"other",size:p.size||"large"}); }}>
                      {iconUrl?<img src={iconUrl} alt="" draggable={false} style={{ width:"100%",height:"100%",objectFit:"contain" }} />:<span style={{ fontSize:12,fontWeight:700,color:cc }}>?</span>}
                    </div>
                    {/* Name + meta */}
                    <div style={{ flex:1,minWidth:0,cursor:"pointer" }} onClick={()=>{ setMovingPOI(null); setPoiForm({poi:p,name:p.name,description:p.description,revealed:p.revealed,category:p.category||"other",size:p.size||"large"}); }}>
                      <div style={{ fontSize:13,fontWeight:600,color:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{p.name}</div>
                      <div style={{ fontSize:10,color:cc,fontWeight:500 }}>{getCatLabel(p.category)} · {maps.find(m=>m.id===p.map_id)?.name||"?"}</div>
                    </div>
                    {/* Show/hide toggle */}
                    <button onClick={()=>togglePOIReveal(p.id,p.revealed)}
                      style={{ padding:"3px 9px",borderRadius:20,border:"none",background:p.revealed?"#EAF3DE":"#FEF3E2",color:p.revealed?"#3B6D11":"#854F0B",fontSize:11,fontWeight:600,cursor:"pointer",flexShrink:0 }}>
                      {p.revealed?"Shown":"Hidden"}
                    </button>
                    {/* Lock/unlock position toggle */}
                    <button onClick={()=>togglePOILock(p.id,p.locked)}
                      title={p.locked?"Unlock position":"Lock position"}
                      style={{ padding:"3px 8px",borderRadius:20,border:"none",background:p.locked?"#FEE2E2":"transparent",color:p.locked?"#991B1B":"#aaa",fontSize:13,cursor:"pointer",flexShrink:0,lineHeight:1 }}>
                      {p.locked?"🔒":"🔓"}
                    </button>
                    {/* Move button (GM, folder view only) — dropdown rendered at App level to avoid overflow:hidden clipping */}
                    {isGM && showMove && (
                      <button title="Move to folder"
                        onClick={e=>{
                          e.stopPropagation();
                          if(movingPOI===p.id){ setMovingPOI(null); setMoveDropdownPos(null); return; }
                          const rect=e.currentTarget.getBoundingClientRect();
                          // Use visualViewport on mobile (excludes browser chrome/address bar)
                          const vph = window.visualViewport?.height ?? window.innerHeight;
                          const vpw = window.visualViewport?.width ?? window.innerWidth;
                          const spaceBelow = vph - rect.bottom;
                          const rightEdge = Math.max(4, vpw - rect.right);
                          setMoveDropdownPos(spaceBelow < 220
                            ? { bottom: vph - rect.top + 4, right: rightEdge }
                            : { top: rect.bottom + 4, right: rightEdge });
                          setMovingPOI(p.id);
                        }}
                        style={{ padding:"4px 8px",borderRadius:6,border:`1px solid ${T.border}`,background:movingPOI===p.id?T.purple:T.surface,color:movingPOI===p.id?T.headerFg:T.muted,fontSize:12,cursor:"pointer",lineHeight:1,flexShrink:0 }}>⇄</button>
                    )}
                  </div>
                );
              };

              return (
                <>
                  {/* Header */}
                  <div style={{ display:"flex",alignItems:"center",gap:6,marginBottom:14,flexWrap:"wrap" }}>
                    <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:14,color:T.ink,flex:1 }}>Points of Interest</div>
                    <div style={{ display:"flex",gap:4,flexShrink:0 }}>
                      {[["folders","Folders"],["name","By Name"],["type","By Type"]].map(([v,lbl])=>(
                        <button key={v} onClick={()=>{setPoiLibView(v);setMovingPOI(null);}}
                          style={{ fontSize:11,padding:"4px 10px",borderRadius:20,border:`1px solid ${T.border}`,background:poiLibView===v?T.purple:T.bg,color:poiLibView===v?T.headerFg:T.muted,cursor:"pointer",fontFamily:T.fBody }}>
                          {lbl}
                        </button>
                      ))}
                    </div>
                    {isGM && <Btn size="sm" variant="primary" onClick={()=>setFolderForm({folder:null,name:""})}>＋ Folder</Btn>}
                  </div>

                  {pois.length===0 && <p style={{ color:T.muted,fontSize:13,fontStyle:"italic" }}>No POIs yet. Place them on the map using "＋ POI".</p>}

                  {/* ── FOLDER VIEW ── */}
                  {poiLibView==="folders" && <>
                    {poiFolders.map(folder=>{
                      const children = pois.filter(p=>p.folder_id===folder.id);
                      const isCollapsed = folderCollapsed[folder.id] ?? false;
                      const allShown = children.length>0 && children.every(p=>p.revealed);
                      const someShown = children.some(p=>p.revealed);
                      const allLocked = children.length>0 && children.every(p=>p.locked);
                      const someLocked = children.some(p=>p.locked);
                      return (
                        <div key={folder.id}
                          onDragOver={e=>{e.preventDefault();setDragOverFolderId(folder.id);}}
                          onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget))setDragOverFolderId(null);}}
                          onDrop={e=>{e.preventDefault();setDragOverFolderId(null);if(folderDragRef.current&&folderDragRef.current!==folder.id){reorderFolders(folderDragRef.current,folder.id);}folderDragRef.current=null;}}
                          onDragEnd={()=>{setDragOverFolderId(null);folderDragRef.current=null;}}
                          style={{ marginBottom:8,border:`1.5px solid ${dragOverFolderId===folder.id?T.purple:T.border}`,borderRadius:10,overflow:"hidden",transition:"border-color 0.15s" }}>
                          {/* Folder header */}
                          <div style={{ display:"flex",alignItems:"center",gap:8,padding:"9px 12px",background:T.surface,cursor:"pointer",userSelect:"none" }}
                            onClick={()=>setFolderCollapsed(prev=>({...prev,[folder.id]:!prev[folder.id]}))}>
                            {isGM && <span draggable={true}
                              onDragStart={e=>{e.stopPropagation();folderDragRef.current=folder.id;e.dataTransfer.setData("text/plain",folder.id);e.dataTransfer.effectAllowed="move";}}
                              onClick={e=>e.stopPropagation()}
                              title="Drag to reorder"
                              style={{ cursor:"grab",color:T.muted,fontSize:15,flexShrink:0,lineHeight:1,padding:"0 2px" }}>⠿</span>}
                            <span style={{ fontSize:11,color:T.muted,display:"inline-block",transition:"transform 0.18s",transform:isCollapsed?"rotate(-90deg)":"rotate(0deg)",lineHeight:1 }}>▾</span>
                            <div style={{ flex:1,fontFamily:T.fHead,fontWeight:600,fontSize:13,color:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{folder.name}</div>
                            <span style={{ fontSize:11,color:T.muted,flexShrink:0 }}>{children.length}</span>
                            {/* Master reveal toggle */}
                            {isGM && children.length>0 && (
                              <button onClick={e=>{e.stopPropagation();toggleFolderReveal(folder);}}
                                style={{ padding:"3px 8px",borderRadius:20,border:"none",background:allShown?"#EAF3DE":someShown?"#FFF8E7":"#FEF3E2",color:allShown?"#3B6D11":someShown?"#7A5500":"#854F0B",fontSize:10,fontWeight:700,cursor:"pointer",flexShrink:0 }}>
                                {allShown?"All Shown":someShown?"Mixed":"All Hidden"}
                              </button>
                            )}
                            {/* Master lock toggle */}
                            {isGM && children.length>0 && (
                              <button onClick={e=>{e.stopPropagation();toggleFolderLock(folder);}}
                                title={allLocked?"Unlock all":"Lock all"}
                                style={{ padding:"3px 7px",borderRadius:20,border:"none",background:allLocked?"#FEE2E2":someLocked?"#FFF8E7":"transparent",color:allLocked?"#991B1B":someLocked?"#7A5500":"#aaa",fontSize:12,cursor:"pointer",flexShrink:0,lineHeight:1 }}>
                                {allLocked?"🔒":someLocked?"🔒︎":"🔓"}
                              </button>
                            )}
                            {isGM && (<>
                              <button title="Rename folder" onClick={e=>{e.stopPropagation();setFolderForm({folder,name:folder.name});setMovingPOI(null);}}
                                style={{ padding:"3px 8px",borderRadius:6,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,fontSize:11,cursor:"pointer",flexShrink:0,lineHeight:1 }}>✎</button>
                              <button title="Delete folder (POIs stay)" onClick={e=>{e.stopPropagation();setFolderForm({folder,name:folder.name,confirmDelete:true});setMovingPOI(null);}}
                                style={{ padding:"3px 7px",borderRadius:6,border:`1px solid ${T.danger}55`,background:"transparent",color:T.danger,fontSize:11,cursor:"pointer",flexShrink:0,lineHeight:1 }}>🗑</button>
                            </>)}
                          </div>
                          {/* Children */}
                          {!isCollapsed && children.length===0 && (
                            <div style={{ padding:"10px 14px",fontSize:12,color:T.muted,fontStyle:"italic" }}>No POIs in this folder yet.</div>
                          )}
                          {!isCollapsed && children.map(p=>renderPOIRow(p,true))}
                        </div>
                      );
                    })}

                    {/* Unfiled section */}
                    {(()=>{
                      const unfiled = pois.filter(p=>!p.folder_id);
                      if (unfiled.length===0 && poiFolders.length>0) return null;
                      const isCollapsed = folderCollapsed["__unfiled"] ?? false;
                      return (
                        <div style={{ marginBottom:8,border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden" }}>
                          <div style={{ display:"flex",alignItems:"center",gap:8,padding:"9px 12px",background:T.surface,cursor:"pointer",userSelect:"none" }}
                            onClick={()=>setFolderCollapsed(prev=>({...prev,"__unfiled":!prev["__unfiled"]}))}>
                            <span style={{ fontSize:11,color:T.muted,display:"inline-block",transition:"transform 0.18s",transform:isCollapsed?"rotate(-90deg)":"rotate(0deg)",lineHeight:1 }}>▾</span>
                            <div style={{ flex:1,fontFamily:T.fHead,fontWeight:500,fontSize:13,color:T.muted,fontStyle:"italic" }}>Unfiled</div>
                            <span style={{ fontSize:11,color:T.muted,flexShrink:0 }}>{unfiled.length}</span>
                          </div>
                          {!isCollapsed && unfiled.length===0 && (
                            <div style={{ padding:"10px 14px",fontSize:12,color:T.muted,fontStyle:"italic" }}>All POIs are organised into folders.</div>
                          )}
                          {!isCollapsed && unfiled.map(p=>renderPOIRow(p,true))}
                        </div>
                      );
                    })()}
                  </>}

                  {/* ── BY NAME VIEW ── */}
                  {poiLibView==="name" && (
                    <div style={{ border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden" }}>
                      {[...pois].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map((p,i)=>(
                        <div key={p.id} style={{ borderTop:i>0?`0.5px solid ${T.border}`:"none" }}>{renderPOIRow(p,false)}</div>
                      ))}
                    </div>
                  )}

                  {/* ── BY TYPE VIEW ── */}
                  {poiLibView==="type" && (()=>{
                    const grouped = {};
                    [...pois].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).forEach(p=>{
                      const k=p.category||"other"; if(!grouped[k]) grouped[k]=[]; grouped[k].push(p);
                    });
                    return Object.entries(grouped).map(([cat,items])=>(
                      <div key={cat} style={{ marginBottom:10,border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden" }}>
                        <div style={{ padding:"8px 12px",background:T.surface,display:"flex",alignItems:"center",gap:8 }}>
                          <div style={{ width:8,height:8,borderRadius:"50%",background:getCatColor(cat),flexShrink:0 }} />
                          <div style={{ fontFamily:T.fHead,fontWeight:600,fontSize:12,color:T.ink }}>{getCatLabel(cat)}</div>
                          <span style={{ fontSize:11,color:T.muted }}>{items.length}</span>
                        </div>
                        {items.map((p,i)=>(
                          <div key={p.id} style={{ borderTop:`0.5px solid ${T.border}` }}>{renderPOIRow(p,false)}</div>
                        ))}
                      </div>
                    ));
                  })()}
                </>
              );
            })()}

            {/* ── ZONES ── */}
            {/* ── TEXTS ── */}
            {libSubTab==="texts" && <>
              <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:8 }}>
                <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:14,color:T.ink,flex:1 }}>Text Overlays</div>
                {isGM && <Btn size="sm" variant="primary" onClick={()=>{ setTextForm({text:null,content:"New Text",font_size:28,color:"#FFFFFF",font_weight:"700",fade_enabled:false,fade_invert:false,locked:false,x:Math.round(imgSize.w/2),y:Math.round(imgSize.h/2)}); setTab("map"); }}>＋ Text</Btn>}
              </div>
              {mapTexts.filter(t=>t.map_id===activeMapId).length===0 && <p style={{ color:T.muted,fontSize:13,fontStyle:"italic" }}>No text overlays on this map yet.</p>}
              {mapTexts.filter(t=>t.map_id===activeMapId).map(t=>(
                <div key={t.id} style={{ display:"flex",alignItems:"center",gap:8,padding:"10px 12px",background:T.surface,borderRadius:10,marginBottom:8,border:`1px solid ${T.border}` }}>
                  {/* Colour swatch */}
                  <div style={{ width:28,height:28,borderRadius:6,background:t.color,border:`1px solid ${T.border}`,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center" }}>
                    <span style={{ fontSize:11,fontWeight:700,color:t.color==="#FFFFFF"?"#333":"#fff",fontFamily:T.fMap }}>A</span>
                  </div>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontSize:13,fontWeight:600,color:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{t.content.split("\n")[0]||"(empty)"}</div>
                    <div style={{ fontSize:11,color:T.muted }}>{t.font_size}px{t.fade_enabled?` · fade ${t.fade_invert?"in":"out"}`:""}  {t.locked?"· 🔒":""}</div>
                  </div>
                  {isGM && <>
                    <button title={t.locked?"Unlock":"Lock"} onClick={async()=>{
                      const nl=!t.locked;
                      await dbUpdate(session.access_token,"map_texts",t.id,{locked:nl}).catch(()=>{});
                      setMapTexts(prev=>prev.map(x=>x.id===t.id?{...x,locked:nl}:x));
                    }} style={{ padding:"4px 8px",borderRadius:20,border:"none",background:t.locked?"#FEE2E2":"transparent",color:t.locked?"#991B1B":"#aaa",fontSize:13,cursor:"pointer",flexShrink:0,lineHeight:1 }}>
                      {t.locked?"🔒":"🔓"}
                    </button>
                    <Btn size="sm" onClick={()=>setTextForm({text:t,content:t.content,font_size:t.font_size,color:t.color,font_weight:t.font_weight,fade_enabled:t.fade_enabled,fade_invert:t.fade_invert,locked:t.locked})}>Edit</Btn>
                  </>}
                </div>
              ))}
            </>}

            {libSubTab==="zones" && <>
              <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:8 }}>
                <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:14,color:T.ink,flex:1 }}>Zones</div>
                <Btn size="sm" variant="primary" onClick={()=>{ setPlacingMode("zone"); setPlacingZonePoints([]); setTab("map"); }}>＋ New Zone</Btn>
              </div>
              {/* Instruction text moved to Tutorial button (coming soon) */}
              {mapZones.length===0 && <p style={{ color:T.muted,fontSize:13,fontStyle:"italic" }}>No zones on this map yet.</p>}
              {mapZones.map(z=>(
                <div key={z.id} style={{ display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:T.surface,borderRadius:10,marginBottom:8,border:`1px solid ${T.border}` }}>
                  <div style={{ width:32,height:32,borderRadius:8,background:z.fill_color,opacity:z.opacity/100,flexShrink:0,border:`1px solid ${T.border}` }} />
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontSize:13,fontWeight:600,color:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{z.name||"Unnamed Zone"}</div>
                    <div style={{ fontSize:11,color:T.muted }}>{z.points.length} points · {z.opacity}% opacity</div>
                  </div>
                  <button onClick={()=>toggleZoneReveal(z.id,z.revealed)}
                    style={{ padding:"4px 10px",borderRadius:20,border:"none",background:z.revealed?"#EAF3DE":"#FEF3E2",color:z.revealed?"#3B6D11":"#854F0B",fontSize:11,fontWeight:600,cursor:"pointer",flexShrink:0 }}>
                    {z.revealed?"Shown":"Hidden"}
                  </button>
                  <Btn size="sm" onClick={()=>setZoneForm({zone:z,name:z.name,fill_color:z.fill_color,opacity:z.opacity,revealed:z.revealed,points:[...z.points]})}>Edit</Btn>
                </div>
              ))}
            </>}

          </div>
        </div>
      )}

      {/* PROFILE TAB */}
      {tab==="profile" && (
        <div style={{ flex:1,overflowY:"auto",padding:"20px 16px",animation:"tabFadeIn 0.2s ease" }}>
          <ProfileTab
            user={user}
            members={members}
            myColor={myColor}
            takenColors={takenColors}
            isGM={isGM}
            onColorChange={chooseColor}
            onSaveDisplayName={saveDisplayName}
            soundVolume={soundVolume}
            onVolumeChange={setSoundVolume}
            markers={markers}
            activeMapId={activeMapId}
            markerLimit={markerLimit}
            onMarkerLimitChange={v=>{ setMarkerLimit(v); updateMarkerLimit(v); }}
            onKickPlayer={kickPlayer}
            onLeaveCampaign={leaveCampaign}
          />
        </div>
      )}

      {/* Modals */}
      {zoneForm && <ZoneFormModal form={zoneForm}
        onSave={saveZone} onDelete={deleteZone}
        onAddPoint={zId=>{ setZoneForm(null); addPointZoneRef.current=zId; setPlacingMode("addpoint"); setTab("map"); }}
        onMovePoints={zone=>startZonePointEdit(zone)}
        onClose={()=>setZoneForm(null)} />}
      {poiForm && <POIFormModal form={poiForm} categoryIcons={categoryIcons} maps={maps} onSave={savePOI} onDelete={deletePOI} onDuplicate={duplicatePOI} onClose={()=>setPoiForm(null)} />}
      {markerForm && <MarkerFormModal form={markerForm} onSave={saveMarker} onEdit={editMarker} onCancel={()=>setMarkerForm(null)} />}

      {/* Folder form modal — rename OR confirm-delete */}
      {folderForm && (
        <div style={{ position:"fixed",inset:0,zIndex:9000,display:"flex",alignItems:"center",justifyContent:"center",padding:16,background:"rgba(10,5,20,0.75)" }} onClick={()=>setFolderForm(null)}>
          <div style={{ background:T.surface,borderRadius:16,padding:"22px 22px 18px",maxWidth:340,width:"100%",boxShadow:"0 8px 40px rgba(0,0,0,0.5)",border:`1px solid ${T.border}` }} onClick={e=>e.stopPropagation()}>
            {folderForm.confirmDelete ? (<>
              {/* Delete confirmation */}
              <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:15,color:T.ink,marginBottom:8 }}>Delete Folder?</div>
              <div style={{ fontSize:13,color:T.muted,marginBottom:20,lineHeight:1.5 }}>
                "<strong style={{ color:T.ink }}>{folderForm.folder.name}</strong>" will be removed.
                All {pois.filter(p=>p.folder_id===folderForm.folder.id).length} POI{pois.filter(p=>p.folder_id===folderForm.folder.id).length!==1?"s":""} inside will be moved to <em>Unfiled</em> — nothing is deleted from the map.
              </div>
              <div style={{ display:"flex",gap:8 }}>
                <button onClick={()=>deleteFolder(folderForm.folder.id)}
                  style={{ flex:1,padding:"9px 0",borderRadius:20,border:"none",background:T.danger,color:"#fff",fontFamily:T.fHead,fontSize:13,fontWeight:700,cursor:"pointer" }}>
                  Delete Folder
                </button>
                <button onClick={()=>setFolderForm(null)}
                  style={{ padding:"9px 14px",borderRadius:20,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,fontSize:13,cursor:"pointer" }}>
                  Cancel
                </button>
              </div>
            </>) : (<>
              {/* Create / rename */}
              <div style={{ fontFamily:T.fHead,fontWeight:700,fontSize:15,color:T.ink,marginBottom:14 }}>
                {folderForm.folder?"Rename Folder":"New Folder"}
              </div>
              <input
                autoFocus={!isTouchDevice}
                value={folderForm.name}
                onChange={e=>setFolderForm(f=>({...f,name:e.target.value}))}
                onKeyDown={e=>{ if(e.key==="Enter"&&folderForm.name.trim()) saveFolder(folderForm.name.trim(),folderForm.folder); if(e.key==="Escape") setFolderForm(null); }}
                placeholder="Folder name…"
                style={{ ...IS,width:"100%",boxSizing:"border-box",marginBottom:14 }}
              />
              <div style={{ display:"flex",gap:8 }}>
                <button onClick={()=>{ if(folderForm.name.trim()) saveFolder(folderForm.name.trim(),folderForm.folder); }}
                  style={{ flex:1,padding:"9px 0",borderRadius:20,border:"none",background:T.purple,color:T.headerFg,fontFamily:T.fHead,fontSize:13,fontWeight:700,cursor:"pointer",opacity:folderForm.name.trim()?1:0.5 }}>
                  {folderForm.folder?"Save":"Create"}
                </button>
                <button onClick={()=>setFolderForm(null)}
                  style={{ padding:"9px 14px",borderRadius:20,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,fontSize:13,cursor:"pointer" }}>
                  Cancel
                </button>
              </div>
            </>)}
          </div>
        </div>
      )}

      {/* Move-to-folder dropdown — fixed position to escape overflow:hidden containers */}
      {movingPOI && moveDropdownPos && (()=>{
        const mp = pois.find(p=>p.id===movingPOI);
        if (!mp) return null;
        return (
          <div style={{ position:"fixed",...(moveDropdownPos.bottom!=null?{bottom:moveDropdownPos.bottom}:{top:moveDropdownPos.top}),right:moveDropdownPos.right,zIndex:9100,background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"4px 0",minWidth:160,maxWidth:220,maxHeight:220,overflowY:"auto",boxShadow:"0 8px 28px rgba(0,0,0,0.3)" }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ fontSize:10,color:T.muted,padding:"4px 12px 5px",fontWeight:700,letterSpacing:"0.07em",position:"sticky",top:0,background:T.bg,borderBottom:`0.5px solid ${T.border}` }}>MOVE TO FOLDER</div>
            {poiFolders.map(f=>(
              <button key={f.id} onClick={()=>movePOIToFolder(mp.id,f.id)}
                style={{ display:"block",width:"100%",textAlign:"left",padding:"6px 12px",border:"none",background:mp.folder_id===f.id?`${T.purple}18`:"transparent",color:mp.folder_id===f.id?T.purple:T.ink,fontSize:12,cursor:"pointer",fontWeight:mp.folder_id===f.id?600:400,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                {mp.folder_id===f.id?"✓ ":""}{f.name}
              </button>
            ))}
            {poiFolders.length===0 && <div style={{ padding:"6px 12px",fontSize:12,color:T.muted,fontStyle:"italic" }}>No folders yet.</div>}
            {mp.folder_id && (
              <button onClick={()=>movePOIToFolder(mp.id,null)}
                style={{ display:"block",width:"100%",textAlign:"left",padding:"6px 12px",border:"none",borderTop:`0.5px solid ${T.border}`,background:"transparent",color:T.danger,fontSize:12,cursor:"pointer" }}>
                ✕ Remove from folder
              </button>
            )}
          </div>
        );
      })()}

      {/* Bell — notification history panel */}
      {showBell && (
        <div style={{ position:"fixed",top:56,right:8,zIndex:3000,width:Math.min(340,window.innerWidth-16),background:T.bg,border:`1.5px solid ${T.border}`,borderRadius:12,boxShadow:"0 12px 40px rgba(26,16,53,0.3)",overflow:"hidden",display:"flex",flexDirection:"column",maxHeight:"75vh" }}>
          <div style={{ display:"flex",alignItems:"center",padding:"10px 14px",borderBottom:`1px solid ${T.border}`,background:T.header,flexShrink:0 }}>
            <span style={{ fontFamily:T.fHead,fontSize:13,fontWeight:600,color:T.headerFg,flex:1 }}>Notifications</span>
            <button onClick={()=>setShowBell(false)} style={{ background:"none",border:"none",color:T.headerFg,cursor:"pointer",fontSize:16,padding:0,lineHeight:1 }}>✕</button>
          </div>
          {isGM && (
            <div style={{ display:"flex",alignItems:"center",gap:8,padding:"6px 14px",borderBottom:`0.5px solid ${T.border}`,background:T.surface,flexShrink:0 }}>
              <span style={{ fontSize:11,color:T.muted,whiteSpace:"nowrap" }}>Keep last</span>
              <input type="range" min={5} max={40} step={1} value={notifLimit} onChange={e=>{ const v=Number(e.target.value); setNotifLimit(v); dbUpdate(session.access_token,"campaigns",activeCampaign.id,{notif_limit:v}).catch(()=>{}); }} style={{ flex:1 }} />
              <span style={{ fontSize:11,color:T.muted,minWidth:24,textAlign:"right" }}>{notifLimit}</span>
            </div>
          )}
          <div style={{ overflowY:"auto",flex:1,padding:"4px 0" }}>
            {notifLog.length===0 && <p style={{ padding:"10px 14px",color:T.muted,fontSize:13,fontStyle:"italic" }}>No notifications yet.</p>}
            {notifLog.map(n=>{
              const icon = n.type==="announcement"?"📜":n.type==="poi_revealed"||n.type==="poi_batch_revealed"?"📍":n.type==="poi_hidden"||n.type==="poi_batch_hidden"?"🙈":n.type==="npc_moved"?"👤":n.type==="marker_placed"?"📌":"🔔";
              const canFocus = n.x!=null && n.y!=null;
              return (
                <div key={n.id}
                  onClick={canFocus ? ()=>focusOnNotif(n) : undefined}
                  style={{ display:"flex",gap:10,padding:"9px 14px",borderBottom:`0.5px solid ${T.border}`,cursor:canFocus?"pointer":"default",background:"transparent",transition:"background 0.12s" }}
                  onMouseEnter={e=>{if(canFocus)e.currentTarget.style.background=T.surface}}
                  onMouseLeave={e=>{e.currentTarget.style.background="transparent"}}>
                  <span style={{ fontSize:16,flexShrink:0,lineHeight:1.4 }}>{icon}</span>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ display:"flex",alignItems:"center",gap:6,flexWrap:"wrap" }}>
                      <span style={{ fontSize:12,fontWeight:600,color:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{n.title||"Notification"}</span>
                      {n.category && n.type==="poi_revealed" && (
                        <span style={{ fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:10,background:getCatColor(n.category)+"22",color:getCatColor(n.category),border:`1px solid ${getCatColor(n.category)}55`,letterSpacing:"0.04em",flexShrink:0 }}>
                          {getCatLabel(n.category)}
                        </span>
                      )}
                    </div>
                    {n.message && <div style={{ fontSize:11,color:T.muted,marginTop:1,lineHeight:1.4 }}>{n.message}</div>}
                    <div style={{ fontSize:10,color:T.muted,marginTop:3 }}>{new Date(n.created_at).toLocaleDateString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}{canFocus&&<span style={{ marginLeft:6,color:T.gold,fontSize:9 }}>tap to focus</span>}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Toast notifications */}
      <div style={{ position:"fixed",bottom:16,right:16,zIndex:8000,display:"flex",flexDirection:"column-reverse",gap:8,maxWidth:Math.min(280,window.innerWidth-32),pointerEvents:"none" }}>
        {toasts.map(t=>(
          <div key={t.id} style={{ background:T.header,color:T.headerFg,borderRadius:10,padding:"10px 14px",boxShadow:"0 4px 16px rgba(0,0,0,0.35)",border:`1px solid ${T.gold}55`,fontSize:12,display:"flex",gap:8,alignItems:"flex-start",pointerEvents:"all",animation:"toastSlide 0.22s ease" }}>
            <span style={{ flex:1,lineHeight:1.4 }}>{t.msg}</span>
            <button onClick={()=>setToasts(p=>p.filter(x=>x.id!==t.id))} style={{ background:"none",border:"none",color:T.headerFg,cursor:"pointer",padding:0,fontSize:14,flexShrink:0 }}>✕</button>
          </div>
        ))}
      </div>

      {/* Portal travel is now handled inline inside the POI popup card */}

      {/* ── Map delete confirmation modal ── */}
      {mapDeleteConfirm && (()=>{ const mName = maps.find(m=>m.id===mapDeleteConfirm)?.name || "this map"; return (
        <div style={{ position:"fixed",inset:0,zIndex:9000,display:"flex",alignItems:"center",justifyContent:"center",padding:16,background:"rgba(10,5,20,0.75)" }} onClick={()=>setMapDeleteConfirm(null)}>
          <div onClick={e=>e.stopPropagation()} style={{ background:T.bg,border:`2px solid ${T.danger}`,borderRadius:14,padding:"24px 24px 20px",maxWidth:360,width:"100%",boxShadow:"0 12px 48px rgba(0,0,0,0.6)" }}>
            <div style={{ fontFamily:T.fHead,fontSize:15,fontWeight:700,color:T.danger,marginBottom:8 }}>⚠️ Delete Map</div>
            <div style={{ fontSize:13,color:T.ink,marginBottom:6 }}>Delete <strong>"{mName}"</strong>?</div>
            <div style={{ fontSize:12,color:T.muted,marginBottom:18,lineHeight:1.5 }}>All POIs, zones, overlays, and NPCs on this map will be permanently removed.</div>
            <div style={{ display:"flex",gap:10 }}>
              <button onClick={()=>deleteMap(mapDeleteConfirm)} style={{ flex:1,padding:"9px 0",borderRadius:20,border:"none",background:T.danger,color:"#fff",fontFamily:T.fHead,fontSize:13,fontWeight:700,cursor:"pointer" }}>Delete Forever</button>
              <button onClick={()=>setMapDeleteConfirm(null)} style={{ flex:1,padding:"9px 0",borderRadius:20,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,fontSize:13,cursor:"pointer" }}>Cancel</button>
            </div>
          </div>
        </div>
      ); })()}

      {/* ── Campaign delete confirmation modal ── */}
      {campDeleteConfirm && (
        <div style={{ position:"fixed",inset:0,zIndex:9000,display:"flex",alignItems:"center",justifyContent:"center",padding:16,background:"rgba(10,5,20,0.75)" }} onClick={()=>setCampDeleteConfirm(null)}>
          <div onClick={e=>e.stopPropagation()} style={{ background:T.bg,border:`2px solid ${T.danger}`,borderRadius:14,padding:"28px 28px 24px",maxWidth:400,width:"100%",boxShadow:"0 12px 48px rgba(0,0,0,0.6)" }}>
            {/* Header */}
            <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:16 }}>
              <div style={{ fontSize:28,lineHeight:1 }}>⚠️</div>
              <div>
                <div style={{ fontFamily:T.fHead,fontSize:16,fontWeight:700,color:T.danger,letterSpacing:"0.03em" }}>Delete Campaign Forever</div>
                <div style={{ fontSize:11,color:"#cc8888",marginTop:2 }}>This action cannot be undone — ever.</div>
              </div>
            </div>
            {/* Campaign name */}
            <div style={{ background:"#1a0808",border:`1px solid ${T.danger}44`,borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:14,fontFamily:T.fHead,color:T.danger,fontWeight:600 }}>
              "{campDeleteConfirm.name}"
            </div>
            {/* What gets deleted */}
            <div style={{ fontSize:12,color:T.muted,lineHeight:1.7,marginBottom:18 }}>
              <strong style={{ color:T.danger,display:"block",marginBottom:4 }}>Everything inside will be permanently destroyed:</strong>
              All maps · All POIs & NPCs · All zones & overlays · All player markers · All announcements · All member data
            </div>
            {/* Buttons */}
            <div style={{ display:"flex",gap:10 }}>
              <button
                onClick={()=>deleteCampaign(campDeleteConfirm)}
                style={{ flex:1,padding:"10px 0",borderRadius:20,border:"none",background:T.danger,color:"#fff",fontFamily:T.fHead,fontSize:13,fontWeight:700,cursor:"pointer",letterSpacing:"0.04em" }}>
                🗑 Delete Forever
              </button>
              <button
                onClick={()=>setCampDeleteConfirm(null)}
                style={{ flex:1,padding:"10px 0",borderRadius:20,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,fontFamily:T.fBody,fontSize:13,cursor:"pointer" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* NPC form modal */}
      {npcForm && <NpcFormModal form={npcForm} onSave={saveNPC} onDelete={deleteNPC} onClose={()=>setNpcForm(null)} />}

      {/* Text overlay form modal */}
      {textForm && (() => {
        const isEdit = !!textForm.text;
        return (
          <Modal title={isEdit ? "Edit Text Overlay" : "New Text Overlay"} onClose={()=>setTextForm(null)} width={380}>
            <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
              <Field label="Content (Enter for new line)">
                <textarea value={textForm.content} rows={4}
                  onChange={e=>setTextForm(f=>({...f,content:e.target.value}))}
                  style={{ ...IS, resize:"vertical", fontFamily:T.fMap, fontSize:14, lineHeight:1.5 }} />
              </Field>
              <div style={{ display:"flex",gap:10 }}>
                <Field label="Font Size">
                  <input type="number" min={8} max={200} value={textForm.font_size}
                    onChange={e=>setTextForm(f=>({...f,font_size:Number(e.target.value)}))}
                    style={{ ...IS, width:80 }} />
                </Field>
                <Field label="Weight">
                  <select value={textForm.font_weight} onChange={e=>setTextForm(f=>({...f,font_weight:e.target.value}))} style={{ ...IS }}>
                    <option value="400">Regular</option>
                    <option value="600">Semi-Bold</option>
                    <option value="700">Bold</option>
                    <option value="800">Extra Bold</option>
                  </select>
                </Field>
                <Field label="Colour">
                  <input type="color" value={textForm.color}
                    onChange={e=>setTextForm(f=>({...f,color:e.target.value}))}
                    style={{ width:44,height:36,border:"none",borderRadius:6,cursor:"pointer",padding:2 }} />
                </Field>
              </div>
              {/* Fade settings */}
              <div style={{ background:T.surface,borderRadius:10,padding:"12px 14px",border:`1px solid ${T.border}` }}>
                <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:textForm.fade_enabled?10:0 }}>
                  <input type="checkbox" id="tf-fade" checked={textForm.fade_enabled}
                    onChange={e=>setTextForm(f=>({...f,fade_enabled:e.target.checked}))} style={{ width:16,height:16,cursor:"pointer" }} />
                  <label htmlFor="tf-fade" style={{ fontSize:13,cursor:"pointer",fontWeight:600,color:T.ink }}>Enable zoom fade</label>
                </div>
                {textForm.fade_enabled && (
                  <div style={{ display:"flex",alignItems:"center",gap:10,marginTop:8,paddingLeft:2 }}>
                    <input type="checkbox" id="tf-invert" checked={textForm.fade_invert}
                      onChange={e=>setTextForm(f=>({...f,fade_invert:e.target.checked}))} style={{ width:16,height:16,cursor:"pointer" }} />
                    <label htmlFor="tf-invert" style={{ fontSize:12,cursor:"pointer",color:T.muted }}>
                      {textForm.fade_invert ? "Fades when zooming IN (visible at low zoom — good for region labels)" : "Fades when zooming OUT (visible at high zoom — like POIs)"}
                    </label>
                  </div>
                )}
              </div>
              {/* Preview */}
              <div style={{ background:"#1a1a2e",borderRadius:10,padding:"14px 16px",minHeight:60,display:"flex",alignItems:"center" }}>
                <span style={{ fontFamily:T.fMap,fontSize:Math.min(textForm.font_size,36),fontWeight:textForm.font_weight,color:textForm.color,whiteSpace:"pre-wrap",lineHeight:1.4,textShadow:"0 0 4px #000,0 0 10px #000" }}>
                  {textForm.content||"Preview…"}
                </span>
              </div>
              {/* Lock */}
              <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                <input type="checkbox" id="tf-lock" checked={!!textForm.locked}
                  onChange={e=>setTextForm(f=>({...f,locked:e.target.checked}))} style={{ width:16,height:16,cursor:"pointer" }} />
                <label htmlFor="tf-lock" style={{ fontSize:13,cursor:"pointer",color:T.ink }}>🔒 Lock position (prevent accidental drag)</label>
              </div>
              <div style={{ display:"flex",gap:8,marginTop:4 }}>
                <Btn variant="primary" onClick={()=>saveText(textForm)} style={{ flex:1 }}>{isEdit?"Save Changes":"Place Text"}</Btn>
                {isEdit && <Btn variant="danger" onClick={()=>deleteText(textForm.text.id)}>🗑 Delete</Btn>}
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* Announcement form modal */}
      {announceForm && <AnnouncementModal form={announceForm} onSave={saveAnnouncement} onClose={()=>setAnnounceForm(null)} />}

      {/* Colour picker modal (still shown on first join if no colour set) */}
      {showColorPicker && (
        <Modal title="Choose your colour" onClose={()=>myColor&&setShowColorPicker(false)} width={340}>
          <p style={{ fontSize:13,color:"#666",marginBottom:12 }}>Pick a colour to represent you on the map. Each player must have a unique colour.</p>
          {error && <div style={{ background:"#fee",color:"#A32D2D",padding:"6px 10px",borderRadius:8,marginBottom:10,fontSize:12 }}>{error}</div>}
          <div style={{ display:"flex",flexWrap:"wrap",gap:10,marginBottom:16 }}>
            {PLAYER_COLORS.map(c=>{
              const isTaken = takenColors.includes(c);
              const isSelected = myColor === c;
              return (
                <div key={c} onClick={()=>!isTaken&&chooseColor(c)}
                  title={isTaken?"Taken by another player":c}
                  style={{ width:36,height:36,borderRadius:"50%",background:c,border:isSelected?"3px solid #3C3489":isTaken?"2px dashed #ccc":"2px solid #ddd",cursor:isTaken?"not-allowed":"pointer",opacity:isTaken?0.35:1,boxSizing:"border-box",position:"relative" }}>
                  {isTaken && <div style={{ position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,color:"rgba(0,0,0,0.4)" }}>✕</div>}
                </div>
              );
            })}
          </div>
          {myColor && <Btn variant="primary" onClick={()=>setShowColorPicker(false)} style={{ width:"100%" }}>Confirm</Btn>}
        </Modal>
      )}
      {/* Version footer */}
      <div style={{ padding:"4px 14px",paddingBottom:"max(8px, env(safe-area-inset-bottom))",background:T.surface,borderTop:`1px solid ${T.border}`,fontSize:10,color:T.muted,textAlign:"center",flexShrink:0,fontFamily:T.fBody }}>
        {buildVersion}
      </div>
      {(tutMode === "player" || tutMode === "gm") && <TutorialOverlay steps={tutMode === "gm" ? GM_STEPS : PLAYER_STEPS} stepIndex={tutStep} onNext={tutNext} onPrev={tutPrev} onExit={tutDone} />}
    </div>
  );
}

const ZONE_COLORS = ["#E74C3C","#E67E22","#F1C40F","#2ECC71","#1ABC9C","#3498DB","#9B59B6","#E91E63","#FFFFFF","#222222"];

function ZoneFormModal({ form, onSave, onDelete, onAddPoint, onMovePoints, onClose }) {
  const isEdit = !!form.zone;
  const [name, setName] = useState(form.name || "");
  const [fillColor, setFillColor] = useState(form.fill_color || "#3498DB");
  const [opacity, setOpacity] = useState(form.opacity ?? 80);
  const [revealed, setRevealed] = useState(form.revealed || false);
  const [points, setPoints] = useState(form.points || []);
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(form.zone?.image_url || "");
  const [clearImage, setClearImage] = useState(false);
  const [imageScale, setImageScale] = useState(form.zone?.image_scale ?? 100);
  const [imageRepeat, setImageRepeat] = useState(form.zone?.image_repeat ?? false);
  const [animateScroll, setAnimateScroll] = useState(form.zone?.animate_scroll ?? false);
  const [scrollSpeed, setScrollSpeed] = useState(form.zone?.scroll_speed ?? 20);
  const [broadcastLocation, setBroadcastLocation] = useState(form.zone?.broadcast_location ?? true);
  async function handleImage(f) { setImageFile(f); setClearImage(false); setImagePreview(await readFile(f)); }
  function removePoint(i) { if (points.length <= 3) return; setPoints(prev => prev.filter((_,idx) => idx !== i)); }
  return (
    <Modal title={isEdit ? "Edit Zone" : "New Zone"} onClose={onClose} width={440}>
      <Field label="Name">
        <input value={name} onChange={e=>setName(e.target.value)} style={IS} placeholder="e.g. Merchant Quarter" autoFocus={!isTouchDevice} />
      </Field>
      <Field label="Fill Colour">
        <div style={{ display:"flex",flexWrap:"wrap",gap:8,marginTop:4,alignItems:"center" }}>
          {ZONE_COLORS.map(c=>(
            <div key={c} onClick={()=>setFillColor(c)}
              style={{ width:28,height:28,borderRadius:6,background:c,border:fillColor===c?"3px solid #3C3489":"2px solid #ddd",cursor:"pointer",boxSizing:"border-box",flexShrink:0 }} />
          ))}
          <input type="color" value={fillColor} onChange={e=>setFillColor(e.target.value)}
            title="Custom colour" style={{ width:28,height:28,padding:2,border:"2px solid #ddd",borderRadius:6,cursor:"pointer",background:"none" }} />
        </div>
      </Field>
      <Field label={`Opacity: ${opacity}%`}>
        <input type="range" min={1} max={100} value={opacity} onChange={e=>setOpacity(Number(e.target.value))} style={{ width:"100%" }} />
        <div style={{ fontSize:11,color:"#888",marginTop:3 }}>Applies to both the fill colour and any assigned image.</div>
      </Field>
      <Field label="Zone Image (optional)">
        <div style={{ display:"flex",alignItems:"center",gap:10 }}>
          {imagePreview && !clearImage && <img src={imagePreview} alt="" style={{ width:48,height:48,objectFit:"cover",borderRadius:6,border:"0.5px solid #ddd",flexShrink:0 }} />}
          <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
            <FilePicker label={imagePreview && !clearImage ? "Replace" : "Upload"} onFile={handleImage} />
            {imagePreview && !clearImage && <Btn size="sm" variant="danger" onClick={()=>{setClearImage(true);setImagePreview("");setImageFile(null);}}>Remove</Btn>}
          </div>
        </div>
        {(imagePreview && !clearImage) && (
          <div style={{ marginTop:10 }}>
            <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:6 }}>
              <input type="checkbox" checked={imageRepeat} onChange={e=>{ setImageRepeat(e.target.checked); if(!e.target.checked) setAnimateScroll(false); }} id="zrep" />
              <label htmlFor="zrep" style={{ fontSize:13,cursor:"pointer" }}>Seamless repeat (tile)</label>
            </div>
            <div style={{ display:"flex",alignItems:"center",gap:8 }}>
              <span style={{ fontSize:12,color:"#666",minWidth:80 }}>{imageRepeat ? "Tile size" : "Image zoom"}: {imageScale}%</span>
              <input type="range" min={10} max={300} step={5} value={imageScale}
                onChange={e=>setImageScale(Number(e.target.value))} style={{ flex:1 }} />
            </div>
            <div style={{ fontSize:11,color:"#888",marginTop:3 }}>
              {imageRepeat ? "Smaller % = more tiles, larger % = fewer larger tiles." : "100% fills the zone. Lower = zoomed out, higher = zoomed in."}
            </div>
            {/* Scroll animation — only when repeat is on */}
            {imageRepeat && (
              <div style={{ marginTop:10,padding:"10px 12px",background:T.surface,borderRadius:8,border:`1px solid ${T.border}` }}>
                <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:animateScroll?8:0 }}>
                  <input type="checkbox" checked={animateScroll} onChange={e=>setAnimateScroll(e.target.checked)} id="zanim" />
                  <label htmlFor="zanim" style={{ fontSize:13,cursor:"pointer",fontWeight:600,color:T.ink }}>✦ Animate scroll (diagonal)</label>
                </div>
                {animateScroll && (
                  <div>
                    <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                      <span style={{ fontSize:12,color:T.muted,minWidth:80 }}>Speed: {scrollSpeed} px/s</span>
                      <input type="range" min={2} max={120} step={2} value={scrollSpeed}
                        onChange={e=>setScrollSpeed(Number(e.target.value))} style={{ flex:1 }} />
                    </div>
                    <div style={{ fontSize:11,color:T.muted,marginTop:3 }}>Slow (2) → Fast (120). Scrolls diagonally on the live map.</div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Field>
      <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:14 }}>
        <input type="checkbox" checked={revealed} onChange={e=>setRevealed(e.target.checked)} id="zrev" />
        <label htmlFor="zrev" style={{ fontSize:13 }}>Visible to players</label>
      </div>
      <Field label={`Waypoints (${points.length} — minimum 3)`}>
        <div style={{ maxHeight:150,overflowY:"auto",border:"0.5px solid #eee",borderRadius:8,marginBottom:6 }}>
          {points.map((p,i)=>(
            <div key={i} style={{ display:"flex",alignItems:"center",gap:8,padding:"5px 10px",borderBottom:i<points.length-1?"0.5px solid #f0f0f0":undefined }}>
              <span style={{ fontSize:12,color:"#666",flex:1 }}>Point {i+1} — ({Math.round(p.x)}, {Math.round(p.y)})</span>
              <button onClick={()=>removePoint(i)} disabled={points.length<=3}
                style={{ padding:"2px 8px",fontSize:11,borderRadius:6,border:"none",background:points.length<=3?"#f5f5f5":"#fee",color:points.length<=3?"#bbb":"#A32D2D",cursor:points.length<=3?"not-allowed":"pointer" }}>
                Remove
              </button>
            </div>
          ))}
        </div>
        {isEdit && (
          <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
            <Btn size="sm" onClick={()=>onAddPoint(form.zone.id)}>+ Add Point</Btn>
            <Btn size="sm" onClick={()=>onMovePoints(form.zone)}>✥ Move Points</Btn>
          </div>
        )}
      </Field>
      <label style={{ display:"flex",alignItems:"center",gap:8,fontSize:12,marginBottom:12,cursor:"pointer" }}>
        <input type="checkbox" checked={broadcastLocation} onChange={e=>setBroadcastLocation(e.target.checked)} />
        <span>
          <strong>Broadcast as location</strong>
          <span style={{ color:"#888",fontWeight:400 }}> — notifications will say "in [this zone]" when items appear here</span>
        </span>
      </label>
      <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
        <Btn variant="primary" onClick={()=>onSave({...form,name,fill_color:fillColor,opacity,revealed,points,clearImage,image_scale:imageScale,image_repeat:imageRepeat,animate_scroll:animateScroll,scroll_speed:scrollSpeed,broadcast_location:broadcastLocation},imageFile)} style={{ flex:1 }}>Save</Btn>
        {isEdit && <Btn variant="danger" onClick={()=>onDelete(form.zone.id)}>Delete Zone</Btn>}
      </div>
    </Modal>
  );
}

function POIFormModal({ form, categoryIcons, maps, onSave, onDelete, onDuplicate, onClose }) {
  const [name, setName] = useState(form.poi?.name||"");
  const [description, setDescription] = useState(form.poi?.description||"");
  const [revealed, setRevealed] = useState(form.poi?.revealed||false);
  const [category, setCategory] = useState(form.poi?.category||"other");
  const [size, setSize] = useState(form.poi?.size||"large");
  const [poiType, setPoiType] = useState(form.poi?.poi_type||"standard");
  const [linkedMapId, setLinkedMapId] = useState(form.poi?.linked_map_id||"");
  const [locked, setLocked] = useState(form.poi?.locked||false);
  const [iconFile, setIconFile] = useState(null);
  const [iconPreview, setIconPreview] = useState(form.poi?.icon_url||"");
  const [clearIcon, setClearIcon] = useState(false);
  const cc = getCatColor(category);
  const catIconUrl = categoryIcons[category] || "";
  const displayIcon = clearIcon ? "" : (iconPreview || catIconUrl);
  async function handleIcon(f) { setIconFile(f); setClearIcon(false); setIconPreview(await readFile(f)); }
  return (
    <Modal title={form.poi?"Edit POI":"New POI"} onClose={onClose} width={420}>
      <Field label="Name"><input value={name} onChange={e=>setName(e.target.value)} style={IS} placeholder="e.g. The Rusty Flagon" /></Field>
      <Field label="Category">
        <div style={{ display:"flex",flexWrap:"wrap",gap:5 }}>
          {CATEGORIES.map(c=>(
            <button key={c.id} onClick={()=>setCategory(c.id)}
              style={{ padding:"3px 8px",fontSize:11,borderRadius:20,border:`2px solid ${c.color}`,background:category===c.id?c.color:"transparent",color:category===c.id?(["#EEEEEE","#C0C0C0","#FFD700"].includes(c.color)?"#333":"white"):"#333",cursor:"pointer",fontWeight:category===c.id?600:400 }}>
              {c.label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Size on map">
        <div style={{ display:"flex",gap:8 }}>
          {POI_SIZES.map(s=>(
            <button key={s.id} onClick={()=>setSize(s.id)}
              style={{ flex:1,padding:"4px 0",borderRadius:8,border:`2px solid ${size===s.id?cc:"#ccc"}`,background:size===s.id?cc+"22":"transparent",cursor:"pointer",fontSize:12,fontWeight:size===s.id?600:400,color:size===s.id?cc:"#555" }}>
              {s.label} ({Math.round(s.scale*100)}%)
            </button>
          ))}
        </div>
      </Field>
      <Field label="Icon">
        <div style={{ display:"flex",alignItems:"center",gap:10 }}>
          <div style={{ width:48,height:48,borderRadius:"50%",border:`2px solid ${cc}`,overflow:"hidden",background:cc+"33",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
            {displayIcon?<img src={displayIcon} alt="" draggable={false} style={{ width:"100%",height:"100%",objectFit:"contain" }} />:<span style={{ fontSize:16,fontWeight:700,color:cc }}>?</span>}
          </div>
          <div style={{ flex:1 }}>
            <div style={{ display:"flex",gap:6,flexWrap:"wrap",marginBottom:4 }}>
              <FilePicker label="Custom upload" onFile={handleIcon} />
              {iconPreview&&!clearIcon&&<Btn size="sm" variant="danger" onClick={()=>{setClearIcon(true);setIconPreview("");setIconFile(null);}}>Remove custom</Btn>}
            </div>
            {catIconUrl && !iconPreview && <div style={{ fontSize:11,color:"#888" }}>Using category default icon</div>}
          </div>
        </div>
      </Field>
      <Field label="Description"><textarea value={description} onChange={e=>setDescription(e.target.value)} rows={3} style={IS} placeholder="What players see when they tap this POI..." /></Field>
      <Field label="Type">
        <div style={{ display:"flex",gap:8 }}>
          {[["standard","Standard"],["portal","⛩ Portal"]].map(([val,lbl])=>(
            <button key={val} onClick={()=>setPoiType(val)}
              style={{ flex:1,padding:"4px 0",borderRadius:8,border:`2px solid ${poiType===val?T.gold:T.border}`,background:poiType===val?`${T.gold}22`:"transparent",cursor:"pointer",fontSize:12,fontWeight:poiType===val?600:400,color:poiType===val?T.goldDim:T.muted }}>
              {lbl}
            </button>
          ))}
        </div>
        {poiType==="portal" && (
          <div style={{ marginTop:8 }}>
            <select value={linkedMapId} onChange={e=>setLinkedMapId(e.target.value)} style={{ ...IS,marginTop:0 }}>
              <option value="">— Select destination map —</option>
              {(maps||[]).map(m=><option key={m.id} value={m.id}>{m.name}{m.is_main?" (Main)":""}</option>)}
            </select>
            <div style={{ fontSize:11,color:T.muted,marginTop:3 }}>Players who tap this POI will travel to the selected map.</div>
          </div>
        )}
      </Field>
      <div style={{ display:"flex",alignItems:"center",gap:16,marginBottom:16,flexWrap:"wrap" }}>
        <label style={{ display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer" }}>
          <input type="checkbox" checked={revealed} onChange={e=>setRevealed(e.target.checked)} id="rev" />
          Revealed to players
        </label>
        <button onClick={()=>setLocked(l=>!l)} title={locked?"Unlock position (allow dragging)":"Lock position (prevent accidental moves)"}
          style={{ display:"flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:20,border:`1px solid ${locked?"#FCA5A5":"#ddd"}`,background:locked?"#FEE2E2":"transparent",color:locked?"#991B1B":"#888",fontSize:12,cursor:"pointer",fontWeight:locked?600:400 }}>
          {locked?"🔒 Locked":"🔓 Unlocked"}
        </button>
      </div>
      <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
        <Btn variant="primary" onClick={()=>onSave({...form,name,description,revealed,locked,category,size,clearIcon,poi_type:poiType,linked_map_id:linkedMapId||null},iconFile)} style={{ flex:1 }}>Save</Btn>
        {form.poi&&<Btn onClick={()=>onDuplicate(form.poi)}>Duplicate</Btn>}
        {form.poi&&<Btn variant="danger" onClick={()=>onDelete(form.poi.id)}>Delete</Btn>}
      </div>
    </Modal>
  );
}

function MarkerFormModal({ form, onSave, onEdit, onCancel }) {
  const isEdit = !!form.marker;
  const [label, setLabel] = useState(form.marker?.label||"");
  const [description, setDescription] = useState(form.marker?.description||"");
  const [locked, setLocked] = useState(form.marker?.locked||false);
  return (
    <Modal title={isEdit?"Edit Marker":"Place Marker"} onClose={onCancel} width={320}>
      <Field label="Title"><input value={label} onChange={e=>setLabel(e.target.value)} style={IS} placeholder="e.g. Camp site" autoFocus={!isTouchDevice} /></Field>
      <Field label="Description (optional)"><textarea value={description} onChange={e=>setDescription(e.target.value)} rows={3} style={IS} placeholder="Add a note..." /></Field>
      {isEdit && (
        <div style={{ marginBottom:12 }}>
          <button onClick={()=>setLocked(l=>!l)} title={locked?"Unlock position":"Lock position"}
            style={{ display:"flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:20,border:`1px solid ${locked?"#FCA5A5":"#ddd"}`,background:locked?"#FEE2E2":"transparent",color:locked?"#991B1B":"#888",fontSize:12,cursor:"pointer",fontWeight:locked?600:400 }}>
            {locked?"🔒 Locked":"🔓 Unlocked"}
          </button>
        </div>
      )}
      <div style={{ display:"flex",gap:8 }}>
        {isEdit
          ? <Btn variant="primary" onClick={()=>onEdit(form.marker,label,description,locked)} style={{ flex:1 }}>Save</Btn>
          : <Btn variant="primary" onClick={()=>onSave(label,description)} style={{ flex:1 }}>Place Marker</Btn>
        }
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </Modal>
  );
}

// ── Global CSS injections ──────────────────────────────────────────────────────
(function injectStyles() {
  const s = document.createElement("style");
  s.textContent = `
    @keyframes portalPulse {
      0%   { transform: scale(1);   opacity: 0.8; }
      50%  { transform: scale(1.4); opacity: 0.2; }
      100% { transform: scale(1);   opacity: 0.8; }
    }
    /* NPC sonar-ping ring: expands outward and fades, staggered per-NPC */
    @keyframes npcRipple {
      0%   { transform: scale(0.75); opacity: 0.85; }
      100% { transform: scale(2.4);  opacity: 0; }
    }
    /* Popup card entrance / exit */
    @keyframes popupFadeIn {
      from { opacity: 0; transform: translateY(8px) scale(0.95); }
      to   { opacity: 1; transform: translateY(0)   scale(1); }
    }
    @keyframes popupFadeOut {
      from { opacity: 1; transform: translateY(0)   scale(1); }
      to   { opacity: 0; transform: translateY(6px) scale(0.96); }
    }
    /* Map-switch overlay covering / revealing */
    @keyframes mapOverlayIn  { from { opacity: 0; } to { opacity: 1; } }
    @keyframes mapOverlayOut { from { opacity: 1; } to { opacity: 0; } }
    @keyframes searchPing {
      0%   { transform: translate(-50%,-50%) scale(0.5); opacity: 0.9; }
      100% { transform: translate(-50%,-50%) scale(2.5); opacity: 0; }
    }
    /* Tab panel content fade */
    @keyframes tabFadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    /* Toast slide-in from right */
    @keyframes toastSlide {
      from { opacity: 0; transform: translateX(36px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #B8A88A; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #7A5C10; }
    button:focus-visible { outline: 2px solid #C9A84C; outline-offset: 2px; }
    input:focus, textarea:focus, select:focus { outline: 2px solid #C9A84C; outline-offset: 0; border-color: #C9A84C !important; }
    * { box-sizing: border-box; }
  `;
  document.head.appendChild(s);
})();

const NPC_STATUSES = ["Alive","Dead","Missing","Hidden"];
const NPC_COLORS = ["#C9A84C","#E74C3C","#3498DB","#2ECC71","#9B59B6","#E67E22","#1ABC9C","#E91E63","#FFFFFF","#555555"];

function NpcFormModal({ form, onSave, onDelete, onClose }) {
  const isEdit = !!form.npc;
  const [name, setName] = useState(form.name||"");
  const [status, setStatus] = useState(form.status||"Alive");
  const [borderColor, setBorderColor] = useState(form.border_color||"#C9A84C");
  const [auraRadius, setAuraRadius] = useState(form.aura_radius??80);
  const [showName, setShowName] = useState(form.show_name??true);
  const [showStatus, setShowStatus] = useState(form.show_status??true);
  const [showAura, setShowAura] = useState(form.show_aura??true);
  const [visToPlayers, setVisToPlayers] = useState(form.is_visible_to_players??false);
  const [locked, setLocked] = useState(form.npc?.locked??false);
  return (
    <Modal title={isEdit?"Edit NPC":"New NPC"} onClose={onClose} width={400}>
      <Field label="Name">
        <input value={name} onChange={e=>setName(e.target.value)} style={IS} placeholder="e.g. The Hooded Stranger" autoFocus={!isTouchDevice} />
      </Field>
      <Field label="Status">
        <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
          {NPC_STATUSES.map(s=>(
            <button key={s} onClick={()=>setStatus(s)}
              style={{ padding:"3px 10px",fontSize:12,borderRadius:20,border:`2px solid ${s==="Alive"?"#2ECC71":s==="Dead"?"#E74C3C":s==="Missing"?"#E67E22":"#888"}`,background:status===s?(s==="Alive"?"#2ECC71":s==="Dead"?"#E74C3C":s==="Missing"?"#E67E22":"#888"):"transparent",color:status===s?"#fff":"#333",cursor:"pointer",fontWeight:status===s?600:400 }}>
              {s}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Border Colour">
        <div style={{ display:"flex",flexWrap:"wrap",gap:6,alignItems:"center" }}>
          {NPC_COLORS.map(c=>(
            <div key={c} onClick={()=>setBorderColor(c)}
              style={{ width:24,height:24,borderRadius:"50%",background:c,border:borderColor===c?"3px solid #3C3489":"2px solid #ddd",cursor:"pointer",boxSizing:"border-box" }} />
          ))}
          <input type="color" value={borderColor} onChange={e=>setBorderColor(e.target.value)} style={{ width:24,height:24,padding:1,border:"2px solid #ddd",borderRadius:"50%",cursor:"pointer",background:"none" }} />
        </div>
        <div style={{ marginTop:8,display:"flex",alignItems:"center",gap:8 }}>
          <div style={{ width:36,height:36,borderRadius:"50%",background:`${borderColor}33`,border:`2px solid ${borderColor}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16 }}>👤</div>
          <span style={{ fontSize:11,color:"#888" }}>Preview</span>
        </div>
      </Field>
      <Field label={`Aura Radius: ${auraRadius}px`}>
        <input type="range" min={0} max={300} step={5} value={auraRadius} onChange={e=>setAuraRadius(Number(e.target.value))} style={{ width:"100%" }} />
        <div style={{ fontSize:11,color:"#888",marginTop:2 }}>Set to 0 to hide the aura. Shows the uncertainty range around the NPC's location.</div>
      </Field>
      <div style={{ background:T.surface,borderRadius:8,padding:"10px 12px",marginBottom:12,border:`1px solid ${T.border}` }}>
        <div style={{ fontSize:12,fontWeight:500,marginBottom:8,color:T.ink }}>Visibility to Players</div>
        <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
          {[["show_name","Show name (hides as \"???\")"],["show_status","Show status"],["show_aura","Show aura radius"]].map(([key,label])=>{
            const val = key==="show_name"?showName:key==="show_status"?showStatus:showAura;
            const set = key==="show_name"?setShowName:key==="show_status"?setShowStatus:setShowAura;
            return (
              <label key={key} style={{ display:"flex",alignItems:"center",gap:8,fontSize:12,cursor:"pointer" }}>
                <input type="checkbox" checked={val} onChange={e=>set(e.target.checked)} />
                {label}
              </label>
            );
          })}
          <label style={{ display:"flex",alignItems:"center",gap:8,fontSize:12,cursor:"pointer",marginTop:4,paddingTop:8,borderTop:`0.5px solid ${T.border}` }}>
            <input type="checkbox" checked={visToPlayers} onChange={e=>setVisToPlayers(e.target.checked)} />
            <span style={{ fontWeight:500 }}>Visible to players</span>
          </label>
        </div>
      </div>
      <div style={{ marginBottom:12 }}>
        <button onClick={()=>setLocked(l=>!l)} title={locked?"Unlock position":"Lock position"}
          style={{ display:"flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:20,border:`1px solid ${locked?"#FCA5A5":"#ddd"}`,background:locked?"#FEE2E2":"transparent",color:locked?"#991B1B":"#888",fontSize:12,cursor:"pointer",fontWeight:locked?600:400 }}>
          {locked?"🔒 Locked":"🔓 Unlocked"}
        </button>
      </div>
      <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
        <Btn variant="primary" style={{ flex:1 }} onClick={()=>onSave({...form,name,status,border_color:borderColor,aura_radius:auraRadius,show_name:showName,show_status:showStatus,show_aura:showAura,is_visible_to_players:visToPlayers,locked})}>Save</Btn>
        {isEdit && <Btn variant="danger" onClick={()=>onDelete(form.npc.id)}>Delete</Btn>}
      </div>
    </Modal>
  );
}

function AnnouncementModal({ form, onSave, onClose }) {
  const isEdit = !!form.announcement;
  const [title, setTitle] = useState(form.title||"");
  const [subHeader, setSubHeader] = useState(form.sub_header||"");
  const [message, setMessage] = useState(form.message||"");
  return (
    <Modal title={isEdit?"Edit Announcement":"New Announcement"} onClose={onClose} width={420}>
      <Field label="Title">
        <input value={title} onChange={e=>setTitle(e.target.value)} style={IS} placeholder="e.g. Session Update" autoFocus={!isTouchDevice} />
      </Field>
      <Field label="Sub Header (optional)">
        <input value={subHeader} onChange={e=>setSubHeader(e.target.value)} style={IS} placeholder="e.g. An urgent missive from the crown..." />
      </Field>
      <Field label="Message (optional)">
        <textarea value={message} onChange={e=>setMessage(e.target.value)} rows={5} style={{ ...IS,resize:"vertical",lineHeight:1.6 }} placeholder="Write your announcement here..." />
      </Field>
      <div style={{ display:"flex",gap:8 }}>
        <Btn variant="primary" style={{ flex:1 }} onClick={()=>onSave({...form,title,sub_header:subHeader,message})}>{isEdit?"Save Changes":"Broadcast"}</Btn>
        <Btn onClick={onClose}>Cancel</Btn>
      </div>
    </Modal>
  );
}

createRoot(document.getElementById("root")).render(<App />);
