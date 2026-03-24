import { useState, useRef, useEffect } from "react";
import { createRoot } from "react-dom/client";

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
async function uploadToStorage(token, file) {
  const ext = file.name.split(".").pop() || "png";
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const r = await fetch(`${SUPA_URL}/storage/v1/object/poi-icons/${path}`, {
    method: "POST",
    headers: { "apikey": SUPA_KEY, "Authorization": `Bearer ${token}`, "Content-Type": file.type || "image/png" },
    body: file
  });
  if (!r.ok) throw new Error(await r.text());
  return `${SUPA_URL}/storage/v1/object/public/poi-icons/${path}`;
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
        { table: "annotations",      filter: `campaign_id=eq.${campaignId}` },
        { table: "campaign_members", filter: `campaign_id=eq.${campaignId}` },
        { table: "campaigns",        filter: `id=eq.${campaignId}` },
        { table: "overlays",         filter: `campaign_id=eq.${campaignId}` },
        { table: "zones",            filter: `campaign_id=eq.${campaignId}` },
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
        const { table, type: eventType, record, old_record } = payload;
        const mapped = { eventType, new: record, old: old_record };
        if (table === "pois") handlers.onPOI(mapped);
        if (table === "markers") handlers.onMarker(mapped);
        if (table === "annotations") handlers.onAnnotation(mapped);
        if (table === "campaign_members") handlers.onMember?.(mapped);
        if (table === "campaigns") handlers.onCampaign?.(mapped);
        if (table === "overlays") handlers.onOverlay?.(mapped);
        if (table === "zones") handlers.onZone?.(mapped);
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
  { id: "inn",        label: "Inns / Taverns",    color: "#2ECC71" },
  { id: "craft",      label: "Craftsmen",         color: "#E67E22" },
  { id: "government", label: "Government",        color: "#3498DB" },
  { id: "public",     label: "Public Services",   color: "#EEEEEE" },
  { id: "security",   label: "Security",          color: "#E74C3C" },
  { id: "religion",   label: "Religion",          color: "#00BCD4" },
  { id: "landmark",   label: "Landmark / Nature", color: "#444444" },
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
];

function getCatColor(id) { return CATEGORIES.find(c => c.id === id)?.color || "#95A5A6"; }
function getZoneBBox(points) {
  if (!points?.length) return { x: 0, y: 0, w: 100, h: 100 };
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX || 1, h: Math.max(...ys) - minY || 1 };
}
function getCatLabel(id) { return CATEGORIES.find(c => c.id === id)?.label || "Others"; }
function getSizeScale(id) { return POI_SIZES.find(s => s.id === id)?.scale ?? 1.0; }

const IS = { width: "100%", padding: "6px 10px", borderRadius: 8, border: "0.5px solid #aaa", fontSize: 13, background: "#f5f5f5", color: "#111", boxSizing: "border-box" };

function Btn({ style, variant, size, onClick, children, disabled }) {
  const base = { padding: size === "sm" ? "4px 10px" : "6px 14px", fontSize: size === "sm" ? 12 : 13, borderRadius: 8, border: "0.5px solid #aaa", background: "transparent", cursor: "pointer", fontWeight: 500, color: "#111" };
  const v = variant === "primary" ? { background: "#3C3489", color: "#fff", border: "none" }
          : variant === "danger"  ? { background: "#A32D2D", color: "#fff", border: "none" } : {};
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...v, ...style, opacity: disabled ? 0.4 : 1 }}>{children}</button>;
}
function Modal({ title, onClose, children, width = 420 }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#fff", borderRadius: 12, border: "0.5px solid #ccc", width, maxWidth: "96%", maxHeight: "90vh", overflow: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontWeight: 500, fontSize: 15 }}>{title}</span>
          {onClose && <Btn size="sm" onClick={onClose}>Close</Btn>}
        </div>
        {children}
      </div>
    </div>
  );
}
function Field({ label, children }) {
  return <div style={{ marginBottom: 12 }}><label style={{ fontSize: 12, color: "#666", display: "block", marginBottom: 4 }}>{label}</label>{children}</div>;
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
      onTouchStart={e => { if (isOwner) { e.stopPropagation(); onDragStart(e, marker); } }}
      onClick={e => { e.stopPropagation(); onTap(marker); }}
      style={{ position: "absolute", left: marker.x - size/2, top: marker.y - size, width: size, height: size, cursor: isOwner ? "grab" : "pointer", zIndex: 25 }}
    >
      <div style={{ width: size, height: size, borderRadius: "50% 50% 50% 0", transform: "rotate(-45deg)", background: color, border: `${Math.max(1.5, 2/scale)}px solid white`, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ transform: "rotate(45deg)", color: "white", fontWeight: 700, fontSize, lineHeight: 1, textShadow: "0 0 2px rgba(0,0,0,0.5)" }}>{initial}</span>
      </div>
    </div>
  );
}

// ── POI Pin ───────────────────────────────────────────────────────────────────
function POIPin({ poi, scale, isGM, onTap, onDragStart, resolvedIconUrl, poiOpacity = 1 }) {
  const ss = getSizeScale(poi.size);
  const size = Math.max(28 * ss, (36 / scale) * ss);
  const bw = Math.max(1.5, 3 / scale);
  const cc = getCatColor(poi.category);
  const borderStyle = (isGM && !poi.revealed) ? "dashed" : "solid";
  const iconUrl = poi.icon_url || resolvedIconUrl || "";
  return (
    <div
      onMouseDown={e => { if (isGM) { e.stopPropagation(); onDragStart(e, poi); } }}
      onTouchStart={e => { if (isGM) { e.stopPropagation(); onDragStart(e, poi); } }}
      onClick={e => { e.stopPropagation(); onTap(poi); }}
      style={{ position: "absolute", left: poi.x - size/2, top: poi.y - size, width: size, height: size, cursor: isGM ? "grab" : "pointer", zIndex: 20, borderRadius: "50%", border: `${bw}px ${borderStyle} ${cc}`, boxSizing: "border-box", overflow: "hidden", background: cc + "59", opacity: poiOpacity, transition: "opacity 0.15s ease" }}
    >
      {iconUrl
        ? <img src={iconUrl} alt={poi.name} draggable={false} onDragStart={e => e.preventDefault()} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", pointerEvents: "none" }} />
        : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "white", fontWeight: 700, fontSize: Math.max(8, 14 * ss / scale), lineHeight: 1 }}>?</span>
          </div>
      }
    </div>
  );
}

// ── Profile Tab ───────────────────────────────────────────────────────────────
function ProfileTab({ user, members, myColor, takenColors, isGM, onColorChange, onSaveDisplayName }) {
  const me = members.find(m => m.user_id === user.id);
  const [displayName, setDisplayName] = useState(me?.display_name || "");
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    await onSaveDisplayName(displayName);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div style={{ maxWidth: 460 }}>
      <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 16 }}>Your Profile</div>

      <Field label="Display Name">
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={displayName}
            onChange={e => { setDisplayName(e.target.value); setSaved(false); }}
            style={{ ...IS, flex: 1 }}
            placeholder={user.user_metadata?.full_name || user.email}
            onKeyDown={e => { if (e.key === "Enter") handleSave(); }}
          />
          <Btn variant="primary" onClick={handleSave}>{saved ? "Saved ✓" : "Save"}</Btn>
        </div>
        <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>Shown on your map markers and in the players list.</div>
      </Field>

      {!isGM && (
        <Field label="Your Colour">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
            {PLAYER_COLORS.map(c => {
              const isTaken = takenColors.includes(c);
              const isSelected = myColor === c;
              return (
                <div key={c} onClick={() => !isTaken && onColorChange(c)}
                  title={isTaken ? "Taken by another player" : c}
                  style={{ width: 34, height: 34, borderRadius: "50%", background: c, border: isSelected ? "3px solid #3C3489" : isTaken ? "2px dashed #ccc" : "2px solid #ddd", cursor: isTaken ? "not-allowed" : "pointer", opacity: isTaken ? 0.35 : 1, boxSizing: "border-box", position: "relative" }}>
                  {isTaken && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "rgba(0,0,0,0.4)" }}>✕</div>}
                  {isSelected && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: "white", textShadow: "0 0 3px rgba(0,0,0,0.6)" }}>✓</div>}
                </div>
              );
            })}
          </div>
          {myColor && <div style={{ fontSize: 11, color: "#888", marginTop: 6 }}>Current colour: <span style={{ fontWeight: 600, color: myColor === "#FFFFFF" ? "#aaa" : myColor }}>{myColor}</span></div>}
        </Field>
      )}

      <div style={{ marginTop: 20, padding: "12px 14px", background: "#f5f5f5", borderRadius: 10, fontSize: 12, color: "#666" }}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Account</div>
        <div>{user.user_metadata?.full_name || "—"}</div>
        <div style={{ color: "#999" }}>{user.email}</div>
        <div style={{ fontSize: 11, color: "#bbb", marginTop: 4 }}>{isGM ? "Game Master" : "Player"}</div>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
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
  const [annotations, setAnnotations] = useState([]);
  const [categoryIcons, setCategoryIcons] = useState({});
  const [tab, setTab] = useState("map");
  const [libSubTab, setLibSubTab] = useState("maps");
  const [placingMode, setPlacingMode] = useState(null);
  const [poiForm, setPoiForm] = useState(null);
  const [markerForm, setMarkerForm] = useState(null);
  const [annotationForm, setAnnotationForm] = useState(null);
  const [openPOICard, setOpenPOICard] = useState(null);
  const [openMarkerCard, setOpenMarkerCard] = useState(null);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [scrollSens, setScrollSens] = useState(1.0);
  const [libSort, setLibSort] = useState("name");
  const [showCampaignModal, setShowCampaignModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [newCampaignName, setNewCampaignName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [markerLimit, setMarkerLimit] = useState(10);
  const [error, setError] = useState("");
  const [overlays, setOverlays] = useState([]);
  const [zones, setZones] = useState([]);
  const [overlaySettings, setOverlaySettings] = useState({});
  const [ovSubTab, setOvSubTab] = useState("layers");
  const [placingZonePoints, setPlacingZonePoints] = useState(null);
  const [zoneForm, setZoneForm] = useState(null);
  const [masterZoneOpacity, setMasterZoneOpacity] = useState(100);
  const [showLayerControls, setShowLayerControls] = useState(false);
  const [editingZonePoints, setEditingZonePoints] = useState(null); // { zoneId, points, originalPoints }
  const [fitScale, setFitScale] = useState(1);
  const [copiedCode, setCopiedCode] = useState(false);
  const [visFilter, setVisFilter] = useState({ categories: {}, players: {}, zones: {} });
  const [showFilter, setShowFilter] = useState(false);

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

  useEffect(() => { placingRef.current = placingMode; }, [placingMode]);
  useEffect(() => { transformRef.current = transform; }, [transform]);
  useEffect(() => { imgSizeRef.current = imgSize; }, [imgSize]);
  useEffect(() => { scrollSensRef.current = scrollSens; }, [scrollSens]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { zonesRef.current = zones; }, [zones]);
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
        if (payload.eventType === "UPDATE") setPois(p => p.map(x => x.id === payload.new.id ? payload.new : x));
        if (payload.eventType === "DELETE") setPois(p => p.filter(x => x.id !== (payload.old?.id || payload.old_record?.id)));
      },
      onMarker: (payload) => {
        if (payload.eventType === "INSERT") setMarkers(m => m.find(x => x.id === payload.new.id) ? m : [...m, payload.new]);
        if (payload.eventType === "UPDATE") setMarkers(m => m.map(x => x.id === payload.new.id ? { ...payload.new, player_color: payload.new.player_color } : x));
        if (payload.eventType === "DELETE") setMarkers(m => m.filter(x => x.id !== (payload.old?.id || payload.old_record?.id)));
      },
      onAnnotation: (payload) => {
        if (payload.eventType === "INSERT") setAnnotations(a => a.find(x => x.id === payload.new.id) ? a : [...a, payload.new]);
        if (payload.eventType === "UPDATE") setAnnotations(a => a.map(x => x.id === payload.new.id ? payload.new : x));
        if (payload.eventType === "DELETE") setAnnotations(a => a.filter(x => x.id !== (payload.old?.id || payload.old_record?.id)));
      },
      // Real-time campaign changes: GM updating marker_limit propagates instantly to all players
      onCampaign: (payload) => {
        if (payload.eventType === "UPDATE") {
          setMarkerLimit(payload.new.marker_limit ?? 10);
          setActiveCampaign(prev => prev ? { ...prev, marker_limit: payload.new.marker_limit } : prev);
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
          // If it's the current user, sync their colour state too
          setUser(u => {
            if (u && payload.new.user_id === u.id) setMyColor(payload.new.player_color);
            return u;
          });
        }
        if (payload.eventType === "INSERT") setMembers(m => m.find(x => x.user_id === payload.new.user_id) ? m : [...m, payload.new]);
      },
    });
    return () => { if (realtimeRef.current) realtimeRef.current.unsubscribe(); };
  }, [activeCampaign?.id, session?.access_token]);

  async function loadCampaigns() {
    try {
      const memberData = await dbSelect(session.access_token, "campaign_members", `user_id=eq.${user.id}&select=campaign_id,role,player_color`);
      if (!memberData.length) { setCampaigns([]); return; }
      const ids = memberData.map(m => m.campaign_id).join(",");
      const camps = await dbSelect(session.access_token, "campaigns", `id=in.(${ids})`);
      const loaded = camps.map(c => ({
        ...c,
        myRole: memberData.find(m => m.campaign_id === c.id)?.role,
        myColor: memberData.find(m => m.campaign_id === c.id)?.player_color
      }));
      setCampaigns(loaded);
      // Auto-load last campaign so players land straight back in after a page refresh
      const lastId = localStorage.getItem("sb_last_campaign");
      if (lastId) {
        const last = loaded.find(c => c.id === lastId);
        if (last) loadCampaignData(last, last.myRole);
      }
    } catch(e) { setError(e.message); }
  }

  async function loadCampaignData(camp, role) {
    localStorage.setItem("sb_last_campaign", camp.id); // persist so refresh auto-returns here
    setActiveCampaign(camp); setMemberRole(role);
    setMarkerLimit(camp.marker_limit || 10);
    try {
      const [mapsData, poisData, markersData, annsData, catIconsData, membersData, overlaysData, zonesData] = await Promise.all([
        dbSelect(session.access_token, "maps", `campaign_id=eq.${camp.id}&order=created_at`),
        dbSelect(session.access_token, "pois", `campaign_id=eq.${camp.id}`),
        dbSelect(session.access_token, "markers", `campaign_id=eq.${camp.id}`),
        dbSelect(session.access_token, "annotations", `campaign_id=eq.${camp.id}`),
        dbSelect(session.access_token, "category_icons", `campaign_id=eq.${camp.id}`),
        dbSelect(session.access_token, "campaign_members", `campaign_id=eq.${camp.id}&select=user_id,role,player_color,joined_at,display_name`),
        dbSelect(session.access_token, "overlays", `campaign_id=eq.${camp.id}&order=z_order`),
        dbSelect(session.access_token, "zones", `campaign_id=eq.${camp.id}`),
      ]);
      setMaps(mapsData); setPois(poisData); setMarkers(markersData); setAnnotations(annsData);
      setMembers(membersData); setOverlays(overlaysData); setZones(zonesData);
      const catMap = {};
      catIconsData.forEach(ci => { catMap[ci.category_id] = ci.icon_url; });
      setCategoryIcons(catMap);
      const me = membersData.find(m => m.user_id === user.id);
      setMyColor(me?.player_color || null);
      const main = mapsData.find(m => m.is_main) || mapsData[0];
      if (main) setActiveMapId(main.id);
      // Only show colour picker if player has genuinely never chosen one
      if (!me?.player_color && role !== "gm") setShowColorPicker(true);
    } catch(e) { setError(e.message); }
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
    setVisFilter({ categories: cats, players: players, zones: zns });
    mapOverlays.forEach(ov => setOverlaySetting(ov.id, "visible", show));
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
    const body = { name: form.name || "Zone", points: form.points, fill_color: form.fill_color || "#3498DB", image_url, opacity: form.opacity ?? 80, revealed: form.revealed || false, image_scale: form.image_scale ?? 100, image_repeat: form.image_repeat ?? false };
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
      const [camp] = await dbInsert(session.access_token, "campaigns", { name: newCampaignName.trim(), gm_id: user.id });
      await dbInsert(session.access_token, "campaign_members", { campaign_id: camp.id, user_id: user.id, role: "gm" });
      setNewCampaignName(""); setShowCampaignModal(false);
      await loadCampaigns(); loadCampaignData(camp, "gm");
    } catch(e) { setError(e.message); }
  }

  async function joinCampaign() {
    if (!joinCode.trim()) return;
    try {
      const camps = await dbSelect(session.access_token, "campaigns", `id=eq.${joinCode.trim()}`);
      if (!camps.length) { setError("Campaign not found."); return; }
      await dbInsert(session.access_token, "campaign_members", { campaign_id: camps[0].id, user_id: user.id, role: "player" });
      setJoinCode(""); setShowJoinModal(false);
      await loadCampaigns(); loadCampaignData(camps[0], "player");
    } catch(e) { setError("Could not join — you may already be a member."); }
  }

  const isGM = memberRole === "gm";
  const currentMap = maps.find(m => m.id === activeMapId);
  const mapPOIs = pois.filter(p => p.map_id === activeMapId && (isGM || p.revealed));
  const mapMarkers = markers.filter(m => m.map_id === activeMapId);
  const mapAnnotations = annotations.filter(a => a.map_id === activeMapId && (isGM || a.visible));
  const myMarkers = markers.filter(m => m.map_id === activeMapId && m.user_id === user?.id);
  const takenColors = members.filter(m => m.user_id !== user?.id && m.player_color).map(m => m.player_color);
  const mapOverlays = overlays.filter(o => o.map_id === activeMapId);
  const mapZones = zones.filter(z => z.map_id === activeMapId);
  // POIs fade out as user zooms toward the fit scale; fully visible at 2× fit zoom
  const poiOpacity = fitScale > 0 ? Math.min(1, Math.max(0, (transform.scale / fitScale) - 1)) : 1;

  function fitToContainer(iw, ih) {
    const rect = mapRef.current?.getBoundingClientRect();
    if (!rect || !iw || !ih) return { x: 0, y: 0, scale: 1 };
    const scale = Math.min(rect.width / iw, rect.height / ih, 1);
    return { scale, x: (rect.width - iw * scale) / 2, y: (rect.height - ih * scale) / 2 };
  }
  function clamp(t, cw, ch, iw, ih) {
    if (!iw || !ih) return t;
    const sw = iw * t.scale, sh = ih * t.scale;
    const minX = Math.min(0, cw - sw), maxX = Math.max(0, cw - sw);
    const minY = Math.min(0, ch - sh), maxY = Math.max(0, ch - sh);
    return { ...t, x: Math.min(maxX, Math.max(minX, t.x)), y: Math.min(maxY, Math.max(minY, t.y)) };
  }
  function getContainerRect() { return mapRef.current?.getBoundingClientRect() || { width: 800, height: 500, left: 0, top: 0 }; }
  function resetView() { const fit = fitToContainer(imgSize.w, imgSize.h); setTransform(fit); setFitScale(fit.scale); }
  function onImgLoad(e) {
    const w = e.target.naturalWidth, h = e.target.naturalHeight;
    setImgSize({ w, h }); const fit = fitToContainer(w, h); setTransform(fit); setFitScale(fit.scale);
  }
  function toMapCoords(cx, cy) {
    const rect = getContainerRect(); const t = transformRef.current;
    return { x: (cx - rect.left - t.x) / t.scale, y: (cy - rect.top - t.y) / t.scale };
  }

  // ── POI drag ──
  function startPOIDrag(e, poi) {
    e.stopPropagation();
    const startCx = e.touches ? e.touches[0].clientX : e.clientX;
    const startCy = e.touches ? e.touches[0].clientY : e.clientY;
    const scaleAtStart = transformRef.current.scale;
    poiDragState.current = { poiId: poi.id, originX: poi.x, originY: poi.y, startCx, startCy, scaleAtStart, moved: false, mapX: poi.x, mapY: poi.y };
    function onMove(ev) {
      if (!poiDragState.current) return;
      const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
      const dx = cx - poiDragState.current.startCx, dy = cy - poiDragState.current.startCy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) poiDragState.current.moved = true;
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
        dbUpdate(session.access_token, "pois", poiId, { x: mapX, y: mapY }).catch(console.error);
      }
    }
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: true }); window.addEventListener("touchend", onUp);
  }

  // ── Marker drag (owner only) ──
  // Fixed: uses distance threshold (>8px) so a clean tap reliably opens the card
  function startMarkerDrag(e, marker) {
    e.stopPropagation();
    const startCx = e.touches ? e.touches[0].clientX : e.clientX;
    const startCy = e.touches ? e.touches[0].clientY : e.clientY;
    const scaleAtStart = transformRef.current.scale;
    markerDragState.current = { markerId: marker.id, originX: marker.x, originY: marker.y, startCx, startCy, scaleAtStart, moved: false, mapX: marker.x, mapY: marker.y };
    function onMove(ev) {
      if (!markerDragState.current) return;
      const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
      const dx = cx - markerDragState.current.startCx, dy = cy - markerDragState.current.startCy;
      // Distance threshold (8px) rather than per-axis so diagonal micro-movements don't cancel taps
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
        setOpenMarkerCard(openMarkerCard === markerId ? null : markerId);
      } else {
        dbUpdate(session.access_token, "markers", markerId, { x: mapX, y: mapY }).catch(console.error);
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
      dragRef.current.moved = true; setIsDragging(true);
      const dx = Math.max(-80, Math.min(80, mx - dragRef.current.lastX));
      const dy = Math.max(-80, Math.min(80, my - dragRef.current.lastY));
      dragRef.current.lastX = mx; dragRef.current.lastY = my;
      setTransform(t => { const rect = getContainerRect(); return clamp({ ...t, x: t.x+dx, y: t.y+dy }, rect.width, rect.height, imgSizeRef.current.w, imgSizeRef.current.h); });
    }
    function onUp(ev) {
      dragRef.current.active = false; setIsDragging(false);
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
        if (mode === "annotation") setAnnotationForm({ ann: null, x: coords.x, y: coords.y });
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
      function onTS(e) { if(e.touches.length===2){isPinching=true;lastDist=getDist(e.touches);dragRef.current.active=false;setIsDragging(false);} }
      function onTM(e) {
        if(e.touches.length!==2||!isPinching)return; e.preventDefault();
        const dist=getDist(e.touches); if(!lastDist){lastDist=dist;return;}
        const factor=Math.min(Math.max(dist/lastDist,0.5),2); lastDist=dist;
        const mid=getMid(e.touches); const rect=el.getBoundingClientRect();
        setTransform(t=>{const ns=Math.min(8,Math.max(0.1,t.scale*factor));const sr=ns/t.scale;const mx=mid.x-rect.left,my=mid.y-rect.top;return clamp({scale:ns,x:mx-sr*(mx-t.x),y:my-sr*(my-t.y)},rect.width,rect.height,imgSizeRef.current.w,imgSizeRef.current.h);});
      }
      function onTE(e){if(e.touches.length<2){isPinching=false;lastDist=null;}}
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
    const body = { name: form.name||"Unnamed POI", description: form.description||"", revealed: form.revealed, category: form.category||"other", size: form.size||"large", icon_url };
    try {
      if (form.poi) { await dbUpdate(session.access_token, "pois", form.poi.id, body); setPois(prev => prev.map(p => p.id === form.poi.id ? { ...p, ...body } : p)); }
      else { const [np] = await dbInsert(session.access_token, "pois", { ...body, campaign_id: activeCampaign.id, map_id: activeMapId, x: form.x, y: form.y }); setPois(prev => [...prev, np]); }
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
    try { await dbUpdate(session.access_token, "pois", id, { revealed: !current }); setPois(prev=>prev.map(p=>p.id===id?{...p,revealed:!current}:p)); } catch(e) { setError(e.message); }
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
    } catch(e) { setError(e.message); }
  }
  async function editMarker(marker, label, description) {
    try {
      await dbUpdate(session.access_token, "markers", marker.id, { label, description });
      setMarkers(prev=>prev.map(m=>m.id===marker.id?{...m,label,description}:m));
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
  async function saveAnnotation(form, type, content) {
    try {
      if (form.ann) { await dbUpdate(session.access_token, "annotations", form.ann.id, { type, content }); setAnnotations(prev=>prev.map(a=>a.id===form.ann.id?{...a,type,content}:a)); }
      else { const [na] = await dbInsert(session.access_token, "annotations", { campaign_id: activeCampaign.id, map_id: activeMapId, type, content, visible: false, x: form.x, y: form.y }); setAnnotations(prev=>[...prev,na]); }
      setAnnotationForm(null);
    } catch(e) { setError(e.message); }
  }
  async function toggleAnnotation(id, current) {
    try { await dbUpdate(session.access_token, "annotations", id, { visible: !current }); setAnnotations(prev=>prev.map(a=>a.id===id?{...a,visible:!current}:a)); } catch(e) { setError(e.message); }
  }
  async function deleteAnnotation(id) {
    try { await dbDelete(session.access_token, "annotations", id); setAnnotations(prev=>prev.filter(a=>a.id!==id)); setAnnotationForm(null); } catch(e) { setError(e.message); }
  }
  async function uploadMap(file) {
    const src = await readFile(file); const isFirst = maps.length === 0;
    try {
      const [nm] = await dbInsert(session.access_token, "maps", { campaign_id: activeCampaign.id, name: file.name.replace(/\.[^.]+$/,""), src, is_main: isFirst });
      setMaps(prev=>[...prev,nm]); if (isFirst) setActiveMapId(nm.id);
    } catch(e) { setError(e.message); }
  }
  async function setMainMap(id) {
    try { for (const m of maps) await dbUpdate(session.access_token, "maps", m.id, { is_main: m.id===id }); setMaps(prev=>prev.map(m=>({...m,is_main:m.id===id}))); } catch(e) { setError(e.message); }
  }
  async function deleteMap(id) {
    if (!window.confirm("Delete this map?")) return;
    try { await dbDelete(session.access_token, "maps", id); const remaining = maps.filter(m=>m.id!==id); setMaps(remaining); if (activeMapId===id) setActiveMapId(remaining[0]?.id||null); } catch(e) { setError(e.message); }
  }
  function goBack() { const prev=mapStack[mapStack.length-1]; setMapStack(s=>s.slice(0,-1)); setActiveMapId(prev||null); setTransform({x:0,y:0,scale:1}); setImgSize({w:0,h:0}); }

  // Card positions
  const openPOI = mapPOIs.find(p=>p.id===openPOICard);
  const openMarker = mapMarkers.find(m=>m.id===openMarkerCard);
  const openMarkerMember = openMarker ? members.find(m => m.user_id === openMarker.user_id) : null;

  function getCardPos(x, y) {
    const rect = getContainerRect();
    const sx = x * transform.scale + transform.x, sy = y * transform.scale + transform.y;
    const cardW = 210, cardH = 200, pad = 8;
    let left = sx + 16, top = sy - cardH / 2;
    if (left + cardW > rect.width - pad) left = sx - cardW - 16;
    left = Math.max(pad, Math.min(rect.width - cardW - pad, left));
    top = Math.max(pad, Math.min(rect.height - cardH - pad, top));
    return { left, top, cardW };
  }

  const poiCardPos = openPOI ? getCardPos(openPOI.x, openPOI.y) : null;
  const markerCardPos = openMarker ? getCardPos(openMarker.x, openMarker.y) : null;
  const sortedLibPOIs = [...pois].sort((a,b)=>libSort==="name"?(a.name||"").localeCompare(b.name||""):(a.category||"").localeCompare(b.category||""));
  // Profile tab is available to everyone; library and overlays are GM-only
  const tabs = ["map", ...(isGM ? ["library", "overlays"] : []), "profile"];
  const buildVersion = (typeof __BUILD_DATE__ !== "undefined" && typeof __COMMIT__ !== "undefined") ? `v${__BUILD_DATE__}-${__COMMIT__}` : "vdev";

  if (loading) return <div style={{ display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",fontFamily:"sans-serif",color:"#888",fontSize:16 }}>Loading...</div>;

  if (!user) return (
    <div style={{ fontFamily:"sans-serif",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"100vh",gap:16,padding:32,background:"#f5f5f5" }}>
      <div style={{ fontSize:52 }}>🗺</div>
      <div style={{ fontWeight:600,fontSize:22 }}>Verlantis Interactive Map</div>
      <div style={{ color:"#666",fontSize:14,textAlign:"center",maxWidth:320 }}>Sign in with your Google account to access your campaigns.</div>
      <button onClick={signInWithGoogle} style={{ display:"flex",alignItems:"center",gap:10,padding:"12px 24px",fontSize:15,borderRadius:10,border:"1px solid #ddd",background:"#fff",cursor:"pointer",fontWeight:500 }}>
        <img src="https://www.google.com/favicon.ico" width={18} height={18} alt="" />
        Sign in with Google
      </button>
    </div>
  );

  if (!activeCampaign) return (
    <div style={{ fontFamily:"sans-serif",padding:24,maxWidth:520,margin:"0 auto",minHeight:"100vh" }}>
      <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:24 }}>
        <span style={{ fontWeight:600,fontSize:18,flex:1 }}>Your Campaigns</span>
        <span style={{ fontSize:12,color:"#888" }}>{user.user_metadata?.full_name||user.email}</span>
        <Btn size="sm" onClick={async()=>{await signOut(session.access_token);setUser(null);setSession(null);}}>Sign out</Btn>
      </div>
      {error && <div style={{ background:"#fee",color:"#A32D2D",padding:"8px 12px",borderRadius:8,marginBottom:12,fontSize:13 }}>{error}<button onClick={()=>setError("")} style={{ marginLeft:8,border:"none",background:"none",cursor:"pointer" }}>✕</button></div>}
      {campaigns.length===0 && <p style={{ color:"#888",fontSize:13,marginBottom:16 }}>No campaigns yet. Create one or join with a campaign ID.</p>}
      {campaigns.map(c=>(
        <div key={c.id} onClick={()=>loadCampaignData(c,c.myRole)} style={{ padding:"14px 16px",background:"#f5f5f5",borderRadius:10,marginBottom:8,cursor:"pointer",border:"0.5px solid #ddd" }}>
          <div style={{ fontWeight:500,fontSize:15 }}>{c.name}</div>
          <div style={{ fontSize:11,color:"#888",marginTop:3 }}>{c.myRole==="gm"?"Game Master":"Player"} · ID: {c.id.slice(0,8)}...</div>
        </div>
      ))}
      <div style={{ display:"flex",gap:8,marginTop:16 }}>
        <Btn variant="primary" onClick={()=>setShowCampaignModal(true)} style={{ flex:1 }}>+ Create Campaign</Btn>
        <Btn onClick={()=>setShowJoinModal(true)} style={{ flex:1 }}>Join Campaign</Btn>
      </div>
      {showCampaignModal && (
        <Modal title="Create Campaign" onClose={()=>setShowCampaignModal(false)} width={340}>
          <Field label="Campaign Name"><input value={newCampaignName} onChange={e=>setNewCampaignName(e.target.value)} style={IS} placeholder="e.g. Verlantis Saga" autoFocus onKeyDown={e=>{if(e.key==="Enter")createCampaign();}} /></Field>
          <Btn variant="primary" onClick={createCampaign} style={{ width:"100%" }}>Create</Btn>
        </Modal>
      )}
      {showJoinModal && (
        <Modal title="Join Campaign" onClose={()=>setShowJoinModal(false)} width={340}>
          <Field label="Campaign ID (ask your GM)"><input value={joinCode} onChange={e=>setJoinCode(e.target.value)} style={IS} placeholder="Paste campaign UUID here" autoFocus /></Field>
          <Btn variant="primary" onClick={joinCampaign} style={{ width:"100%" }}>Join</Btn>
        </Modal>
      )}
    </div>
  );

  return (
    <div style={{ fontFamily:"sans-serif",fontSize:14,color:"#111",display:"flex",flexDirection:"column",height:"100vh",background:"#fff" }}>
      {/* Header */}
      <div style={{ display:"flex",alignItems:"center",gap:8,padding:"8px 14px",borderBottom:"0.5px solid #ddd",background:"#fff",flexWrap:"wrap" }}>
        <button onClick={()=>{setActiveCampaign(null);localStorage.removeItem("sb_last_campaign");if(realtimeRef.current)realtimeRef.current.unsubscribe();}} style={{ background:"none",border:"none",cursor:"pointer",fontSize:18,padding:0,color:"#555" }}>←</button>
        <span style={{ fontWeight:500,fontSize:14,flex:1 }}>{activeCampaign.name}</span>
        {mapStack.length>0 && <Btn size="sm" onClick={goBack}>↩ Back</Btn>}
        <span style={{ fontSize:11,padding:"2px 8px",borderRadius:20,background:isGM?"#EAF3DE":"#E6F1FB",color:isGM?"#3B6D11":"#185FA5",fontWeight:500 }}>{isGM?"GM":"Player"}</span>
        {!isGM && (
          <div onClick={()=>setTab("profile")} title="Edit your profile"
            style={{ width:18,height:18,borderRadius:"50%",background:myColor||"#ccc",border:"2px solid #aaa",cursor:"pointer",flexShrink:0 }} />
        )}
        <span style={{ fontSize:11,color:"#888",maxWidth:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{user.user_metadata?.full_name||user.email}</span>
        <span style={{ fontSize:10,color:"#bbb",whiteSpace:"nowrap" }}>{buildVersion}</span>
      </div>

      {error && <div style={{ background:"#fee",color:"#A32D2D",padding:"5px 14px",fontSize:12 }}>{error}<button onClick={()=>setError("")} style={{ marginLeft:8,border:"none",background:"none",cursor:"pointer" }}>✕</button></div>}
      {isGM && (
        <div style={{ display:"flex",alignItems:"center",gap:8,padding:"3px 14px",background:"#f0f0ff",fontSize:11,color:"#555",borderBottom:"0.5px solid #ddd" }}>
          <span>Campaign ID for players: <strong>{activeCampaign.id}</strong></span>
          <button onClick={()=>{
            const copy = () => { navigator.clipboard.writeText(activeCampaign.id).catch(()=>{}); };
            try { copy(); } catch {
              const el = document.createElement("textarea"); el.value = activeCampaign.id;
              el.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(el);
              el.select(); document.execCommand("copy"); document.body.removeChild(el);
            }
            setCopiedCode(true); setTimeout(()=>setCopiedCode(false), 2000);
          }} style={{ padding:"1px 8px",borderRadius:6,border:"0.5px solid #aaa",background:copiedCode?"#EAF3DE":"#fff",color:copiedCode?"#3B6D11":"#555",fontSize:11,cursor:"pointer",flexShrink:0,fontWeight:copiedCode?500:400 }}>
            {copiedCode ? "Copied ✓" : "Copy"}
          </button>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:"flex",borderBottom:"0.5px solid #ddd",padding:"0 14px" }}>
        {tabs.map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{ padding:"7px 12px",border:"none",borderBottom:tab===t?"2px solid #3C3489":"2px solid transparent",background:"transparent",cursor:"pointer",fontSize:12,fontWeight:tab===t?500:400,color:tab===t?"#3C3489":"#888",textTransform:"capitalize" }}>{t}</button>
        ))}
      </div>

      {/* MAP TAB */}
      {tab==="map" && (
        <div style={{ flex:1,display:"flex",flexDirection:"column",minHeight:0,position:"relative" }}>
          <div style={{ display:"flex",gap:6,padding:"7px 14px",borderBottom:"0.5px solid #ddd",flexWrap:"wrap",alignItems:"center" }}>
            {isGM && <>
              <Btn size="sm" onClick={()=>setPlacingMode(p=>p==="poi"?null:"poi")} style={{ background:placingMode==="poi"?"#EAF3DE":undefined }}>+ POI</Btn>
              <Btn size="sm" onClick={()=>setPlacingMode(p=>p==="annotation"?null:"annotation")} style={{ background:placingMode==="annotation"?"#EAF3DE":undefined }}>+ Note</Btn>
            </>}
            <Btn size="sm" onClick={()=>{
              if (!myColor && !isGM) { setShowColorPicker(true); return; }
              setPlacingMode(p=>p==="marker"?null:"marker");
            }} style={{ background:placingMode==="marker"?"#dce8fa":undefined }}>
              + Marker {!isGM && myMarkers.length >= markerLimit ? `(${myMarkers.length}/${markerLimit} full)` : !isGM ? `(${myMarkers.length}/${markerLimit})` : ""}
            </Btn>
            <Btn size="sm" onClick={resetView}>Fit</Btn>
            {placingMode && placingMode !== "zone" && placingMode !== "addpoint" && <span style={{ fontSize:11,color:"#185FA5",padding:"2px 8px",background:"#E6F1FB",borderRadius:20 }}>Tap map to place {placingMode}</span>}
            {placingMode === "zone" && (
              <span style={{ display:"flex",alignItems:"center",gap:6,flexWrap:"wrap" }}>
                <span style={{ fontSize:11,color:"#185FA5",padding:"2px 8px",background:"#E6F1FB",borderRadius:20 }}>Zone: {placingZonePoints?.length || 0} points</span>
                {(placingZonePoints?.length || 0) >= 3 && (
                  <Btn size="sm" variant="primary" onClick={()=>{ setPlacingMode(null); setZoneForm({ zone:null, name:"", fill_color:"#3498DB", opacity:80, revealed:false, points:placingZonePoints }); setPlacingZonePoints(null); }}>Close Zone ✓</Btn>
                )}
                <Btn size="sm" onClick={()=>{ setPlacingMode(null); setPlacingZonePoints(null); }}>Cancel</Btn>
              </span>
            )}
            {placingMode === "addpoint" && (
              <span style={{ display:"flex",alignItems:"center",gap:6 }}>
                <span style={{ fontSize:11,color:"#E67E22",padding:"2px 8px",background:"#FEF3E2",borderRadius:20 }}>Click map to add point</span>
                <Btn size="sm" onClick={()=>{ setPlacingMode(null); addPointZoneRef.current = null; }}>Cancel</Btn>
              </span>
            )}
            {editingZonePoints && (
              <span style={{ display:"flex",alignItems:"center",gap:6 }}>
                <span style={{ fontSize:11,color:"#9B59B6",padding:"2px 8px",background:"#F5EEF8",borderRadius:20 }}>Drag waypoints to reposition</span>
                <Btn size="sm" variant="primary" onClick={saveZonePoints}>Save</Btn>
                <Btn size="sm" onClick={cancelZonePointEdit}>Cancel</Btn>
              </span>
            )}
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:8,padding:"4px 14px",borderBottom:"0.5px solid #ddd",background:"#f9f9f9" }}>
            <span style={{ fontSize:11,color:"#888",whiteSpace:"nowrap" }}>Zoom speed</span>
            <input type="range" min={0.1} max={2} step={0.1} value={scrollSens} onChange={e=>setScrollSens(Number(e.target.value))} style={{ flex:1,maxWidth:120 }} />
            <span style={{ fontSize:11,color:"#888",minWidth:24 }}>{scrollSens.toFixed(1)}</span>
            <button onClick={()=>setShowFilter(f=>!f)} style={{ marginLeft:"auto",padding:"2px 10px",borderRadius:6,border:`1px solid ${showFilter?"#3C3489":"#ccc"}`,background:showFilter?"#3C3489":"#fff",color:showFilter?"#fff":"#555",fontSize:11,cursor:"pointer",flexShrink:0 }}>
              ☰ Filter
            </button>
          </div>
          {/* ── Personal visibility filter dropdown ── */}
          {showFilter && (()=>{
            const allVisible =
              CATEGORIES.every(c => isVisible("categories", c.id)) &&
              members.every(m => isVisible("players", m.user_id)) &&
              mapZones.every(z => isVisible("zones", z.id)) &&
              mapOverlays.every(ov => (overlaySettings[ov.id]?.visible ?? true));
            const rowStyle = { display:"flex",alignItems:"center",gap:8,padding:"4px 14px",cursor:"pointer" };
            const headStyle = { fontSize:10,fontWeight:600,color:"#888",textTransform:"uppercase",padding:"6px 14px 2px",letterSpacing:"0.05em" };
            return (
              <div style={{ position:"absolute",top:80,right:14,zIndex:300,background:"#fff",border:"1px solid #ddd",borderRadius:10,boxShadow:"0 4px 18px rgba(0,0,0,0.13)",minWidth:220,maxHeight:340,overflowY:"auto",paddingBottom:6 }}>
                {/* Toggle All */}
                <label style={{ ...rowStyle, borderBottom:"0.5px solid #eee",paddingBottom:8,marginBottom:2,fontWeight:500,fontSize:12 }}>
                  <input type="checkbox" checked={allVisible} onChange={()=>setAllVisible(!allVisible)} />
                  <span>Toggle All</span>
                </label>
                {/* POI Categories */}
                {CATEGORIES.length > 0 && <div style={headStyle}>POI Categories</div>}
                {CATEGORIES.map(cat => (
                  <label key={cat.id} style={{ ...rowStyle, fontSize:12 }}>
                    <input type="checkbox" checked={isVisible("categories", cat.id)} onChange={e=>setVis("categories", cat.id, e.target.checked)} />
                    <span style={{ width:10,height:10,borderRadius:"50%",background:cat.color,display:"inline-block",flexShrink:0 }} />
                    <span>{cat.label}</span>
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

          {/* ── Layers & Zones quick controls — visible to everyone on the map page ── */}
          {(mapOverlays.length > 0 || mapZones.filter(z => isGM || z.revealed).length > 0) && (
            <div style={{ borderBottom:"0.5px solid #ddd",background:"#fafafa" }}>
              <button onClick={()=>setShowLayerControls(p=>!p)}
                style={{ display:"flex",alignItems:"center",gap:6,width:"100%",padding:"4px 14px",background:"none",border:"none",cursor:"pointer",fontSize:11,color:"#555",fontWeight:500,textAlign:"left" }}>
                <span style={{ flex:1 }}>Layers &amp; Zones</span>
                <span>{showLayerControls ? "▲" : "▼"}</span>
              </button>
              {showLayerControls && (
                <div style={{ padding:"4px 14px 10px" }}>
                  {/* Master zone opacity — affects ALL zones for this user only */}
                  {mapZones.filter(z => isGM || z.revealed).length > 0 && (
                    <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:8,paddingBottom:8,borderBottom:mapOverlays.length>0?"0.5px solid #eee":"none" }}>
                      <span style={{ fontSize:11,color:"#555",minWidth:72,fontWeight:500,whiteSpace:"nowrap" }}>All Zones</span>
                      <input type="range" min={0} max={100} value={masterZoneOpacity}
                        onChange={e=>{ const v=Number(e.target.value); setMasterZoneOpacity(v); if(activeCampaign) localStorage.setItem(`zone_master_${activeCampaign.id}`,String(v)); }}
                        style={{ flex:1,maxWidth:160 }} />
                      <span style={{ fontSize:11,color:"#888",minWidth:32 }}>{masterZoneOpacity}%</span>
                    </div>
                  )}
                  {/* Per-layer opacity + visibility */}
                  {mapOverlays.map(ov=>{
                    const s = overlaySettings[ov.id] || { opacity:80, visible:true };
                    return (
                      <div key={ov.id} style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                        <span style={{ fontSize:11,color:"#555",minWidth:72,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{ov.name}</span>
                        <input type="range" min={1} max={100} value={s.opacity}
                          onChange={e=>setOverlaySetting(ov.id,"opacity",Number(e.target.value))}
                          style={{ flex:1,maxWidth:160 }} />
                        <span style={{ fontSize:11,color:"#888",minWidth:32 }}>{s.opacity}%</span>
                        <button onClick={()=>setOverlaySetting(ov.id,"visible",!s.visible)}
                          style={{ fontSize:11,padding:"2px 8px",borderRadius:6,border:"none",background:s.visible?"#EAF3DE":"#f0f0f0",color:s.visible?"#3B6D11":"#888",cursor:"pointer",flexShrink:0 }}>
                          {s.visible?"On":"Off"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div style={{ flex:1,minHeight:0,position:"relative" }}>
            <div ref={mapRef} style={{ position:"absolute",inset:0,overflow:"hidden",background:"#1a1a2e",cursor:placingMode?"crosshair":isDragging?"grabbing":"grab",touchAction:"none",userSelect:"none" }}
              onMouseDown={onPointerDown} onTouchStart={onPointerDown}
              onClick={()=>{ if(!dragRef.current.moved){ setOpenPOICard(null); setOpenMarkerCard(null); } }}>
              {!currentMap ? (
                <div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",color:"#aaa",gap:8 }}>
                  <span style={{ fontSize:40 }}>🗺</span>
                  <span style={{ fontSize:13 }}>{isGM?"Go to Library to upload a map.":"Waiting for GM to load a map."}</span>
                </div>
              ) : (
                <div style={{ position:"absolute",transform:`translate(${transform.x}px,${transform.y}px) scale(${transform.scale})`,transformOrigin:"0 0" }}>
                  <img src={currentMap.src} alt="map" style={{ display:"block",maxWidth:"none" }} draggable={false} onLoad={onImgLoad} />
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
                            return (
                              <pattern key={z.id} id={`zpat-${z.id}`} patternUnits="userSpaceOnUse"
                                x={bbox.x} y={bbox.y} width={tile} height={tile}>
                                <image href={z.image_url} width={tile} height={tile} preserveAspectRatio="xMidYMid slice" />
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
                            onClick={e=>{ e.stopPropagation(); if(isGM && placingMode !== "zone" && placingMode !== "addpoint") setZoneForm({zone:z,name:z.name,fill_color:z.fill_color,opacity:z.opacity,revealed:z.revealed,points:[...z.points]}); }}
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
                  {mapPOIs.filter(p=>isVisible("categories", p.category)).map(p=>(
                    <POIPin key={p.id} poi={p} scale={transform.scale} isGM={isGM}
                      resolvedIconUrl={categoryIcons[p.category]||""}
                      poiOpacity={poiOpacity}
                      onTap={poi=>{ if(!isGM) setOpenPOICard(openPOICard===poi.id?null:poi.id); }}
                      onDragStart={startPOIDrag} />
                  ))}
                  {mapAnnotations.map(a=>(
                    <div key={a.id} onClick={e=>{e.stopPropagation();if(dragRef.current.moved)return;if(isGM)toggleAnnotation(a.id,a.visible);}}
                      style={{ position:"absolute",left:Math.min(a.x,(imgSize.w||800)-210),top:Math.max(0,a.y),maxWidth:200,background:"rgba(255,255,255,0.95)",border:`1.5px solid ${a.visible?"#1D9E75":"#BA7517"}`,borderRadius:8,padding:"6px 8px",cursor:isGM?"pointer":"default",fontSize:12,zIndex:30 }}>
                      <div style={{ color:"#111" }}>{a.content}</div>
                      {isGM && <div style={{ fontSize:10,color:a.visible?"#0F6E56":"#854F0B",marginTop:3 }}>{a.visible?"Visible — tap to hide":"Hidden — tap to show"}</div>}
                    </div>
                  ))}
                  {mapMarkers.filter(m=>isVisible("players", m.user_id)).map(m => {
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
                </div>
              )}
            </div>

            {/* POI popup */}
            {openPOI && poiCardPos && (
              <div onMouseDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()}
                style={{ position:"absolute",left:poiCardPos.left,top:poiCardPos.top,width:poiCardPos.cardW,background:"white",borderRadius:10,border:`2px solid ${getCatColor(openPOI.category)}`,zIndex:100,overflow:"hidden",boxSizing:"border-box" }}>
                <div style={{ display:"flex",alignItems:"center",gap:8,padding:"8px 10px 6px",borderBottom:"0.5px solid #eee" }}>
                  <div style={{ width:32,height:32,borderRadius:"50%",border:`2px solid ${getCatColor(openPOI.category)}`,overflow:"hidden",flexShrink:0,background:getCatColor(openPOI.category)+"33",display:"flex",alignItems:"center",justifyContent:"center" }}>
                    {(openPOI.icon_url||categoryIcons[openPOI.category])?<img src={openPOI.icon_url||categoryIcons[openPOI.category]} alt="" draggable={false} style={{ width:"100%",height:"100%",objectFit:"contain" }} />:<span style={{ fontSize:14,fontWeight:700,color:getCatColor(openPOI.category) }}>?</span>}
                  </div>
                  <div style={{ flex:1,overflow:"hidden" }}>
                    <div style={{ fontWeight:500,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{openPOI.name}</div>
                    <div style={{ fontSize:10,color:getCatColor(openPOI.category),fontWeight:500 }}>{getCatLabel(openPOI.category)}</div>
                  </div>
                </div>
                <div onMouseDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()}
                  style={{ padding:"7px 10px",fontSize:12,color:"#555",lineHeight:1.5,maxHeight:110,overflowY:"auto",touchAction:"pan-y" }}>
                  {openPOI.description||<span style={{ color:"#aaa",fontStyle:"italic" }}>No description.</span>}
                </div>
                <div style={{ padding:"4px 10px 8px",textAlign:"right" }}>
                  <Btn size="sm" onClick={()=>setOpenPOICard(null)}>Close</Btn>
                </div>
              </div>
            )}

            {/* Marker popup */}
            {openMarker && markerCardPos && (() => {
              const openMarkerColor = openMarkerMember?.player_color || openMarker.player_color || "#378ADD";
              return (
              <div onMouseDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()}
                style={{ position:"absolute",left:markerCardPos.left,top:markerCardPos.top,width:markerCardPos.cardW,background:"white",borderRadius:10,border:`2px solid ${openMarkerColor}`,zIndex:100,overflow:"hidden",boxSizing:"border-box" }}>
                <div style={{ display:"flex",alignItems:"center",gap:8,padding:"8px 10px 6px",borderBottom:"0.5px solid #eee" }}>
                  <div style={{ width:28,height:28,borderRadius:"50% 50% 50% 0",transform:"rotate(-45deg)",background:openMarkerColor,border:"2px solid #eee",flexShrink:0 }} />
                  <div style={{ flex:1,overflow:"hidden" }}>
                    <div style={{ fontWeight:500,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{openMarker.label||"Marker"}</div>
                    <div style={{ fontSize:10,color:"#888" }}>{openMarkerMember?.display_name || openMarker.user_name?.split(" ")[0] || "Player"}</div>
                  </div>
                </div>
                {openMarker.description && (
                  <div onMouseDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()}
                    style={{ padding:"7px 10px",fontSize:12,color:"#555",lineHeight:1.5,maxHeight:80,overflowY:"auto",touchAction:"pan-y" }}>
                    {openMarker.description}
                  </div>
                )}
                <div style={{ padding:"4px 10px 8px",display:"flex",gap:6,justifyContent:"flex-end" }}>
                  {openMarker.user_id === user.id && <>
                    <Btn size="sm" onClick={()=>{ setMarkerForm({ marker: openMarker }); setOpenMarkerCard(null); }}>Edit</Btn>
                    <Btn size="sm" variant="danger" onClick={()=>deleteMarker(openMarker.id)}>Delete</Btn>
                  </>}
                  {isGM && openMarker.user_id !== user.id && <Btn size="sm" variant="danger" onClick={()=>deleteMarker(openMarker.id)}>Delete</Btn>}
                  <Btn size="sm" onClick={()=>setOpenMarkerCard(null)}>Close</Btn>
                </div>
              </div>
              );
            })()}
          </div>

          <div style={{ padding:"4px 14px",borderTop:"0.5px solid #ddd",display:"flex",gap:12,fontSize:10,color:"#888",flexWrap:"wrap" }}>
            <span>Tap POI or marker to view</span>
            {isGM && <span style={{ color:"#185FA5" }}>GM: drag POI to move · — — dashed = hidden</span>}
            <span>Drag your own marker to move it</span>
          </div>
        </div>
      )}

      {/* LIBRARY TAB */}
      {tab==="library" && isGM && (
        <div style={{ display:"flex",flexDirection:"column",flex:1,minHeight:0 }}>
          <div style={{ display:"flex",borderBottom:"0.5px solid #ddd",padding:"0 14px",background:"#fafafa" }}>
            {["maps","pois","categories","players"].map(st=>(
              <button key={st} onClick={()=>setLibSubTab(st)} style={{ padding:"6px 12px",border:"none",borderBottom:libSubTab===st?"2px solid #3C3489":"2px solid transparent",background:"transparent",cursor:"pointer",fontSize:12,fontWeight:libSubTab===st?500:400,color:libSubTab===st?"#3C3489":"#888",textTransform:"capitalize" }}>{st}</button>
            ))}
          </div>
          <div style={{ flex:1,overflowY:"auto",padding:14 }}>
            {libSubTab==="maps" && <>
              <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:12 }}>
                <span style={{ fontWeight:500 }}>Maps</span>
                <FilePicker label="+ Upload" onFile={uploadMap} />
              </div>
              {maps.length===0 && <p style={{ color:"#888",fontSize:13 }}>No maps yet.</p>}
              <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10 }}>
                {maps.map(m=>(
                  <div key={m.id} style={{ border:m.is_main?"2px solid #3C3489":"0.5px solid #ccc",borderRadius:10,overflow:"hidden",background:"#fafafa" }}>
                    <img src={m.src} alt={m.name} style={{ width:"100%",height:75,objectFit:"cover",display:"block" }} />
                    <div style={{ padding:"6px 8px" }}>
                      <div style={{ fontSize:12,fontWeight:500,marginBottom:5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{m.name}</div>
                      <div style={{ display:"flex",gap:4 }}>
                        {m.is_main?<span style={{ fontSize:10,color:"#3C3489",fontWeight:500 }}>Main</span>:<Btn size="sm" variant="primary" onClick={()=>setMainMap(m.id)}>Set Main</Btn>}
                        <Btn size="sm" variant="danger" onClick={()=>deleteMap(m.id)}>Del</Btn>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>}

            {libSubTab==="pois" && <>
              <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap" }}>
                <span style={{ fontWeight:500 }}>POIs</span>
                <button onClick={()=>setLibSort("name")} style={{ fontSize:11,padding:"2px 8px",borderRadius:20,border:"0.5px solid #aaa",background:libSort==="name"?"#3C3489":"transparent",color:libSort==="name"?"white":"#333",cursor:"pointer" }}>Name</button>
                <button onClick={()=>setLibSort("type")} style={{ fontSize:11,padding:"2px 8px",borderRadius:20,border:"0.5px solid #aaa",background:libSort==="type"?"#3C3489":"transparent",color:libSort==="type"?"white":"#333",cursor:"pointer" }}>Type</button>
              </div>
              {sortedLibPOIs.length===0 && <p style={{ color:"#888",fontSize:12 }}>No POIs yet.</p>}
              {sortedLibPOIs.map(p=>{
                const cc=getCatColor(p.category);
                const iconUrl = p.icon_url || categoryIcons[p.category] || "";
                return (
                  <div key={p.id} style={{ display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:"#f5f5f5",borderRadius:8,marginBottom:6 }}>
                    <div style={{ width:30,height:30,borderRadius:"50%",border:`2px ${p.revealed?"solid":"dashed"} ${cc}`,overflow:"hidden",flexShrink:0,background:cc+"33",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}
                      onClick={()=>setPoiForm({poi:p,name:p.name,description:p.description,revealed:p.revealed,category:p.category||"other",size:p.size||"large"})}>
                      {iconUrl?<img src={iconUrl} alt="" draggable={false} style={{ width:"100%",height:"100%",objectFit:"contain" }} />:<span style={{ fontSize:12,fontWeight:700,color:cc }}>?</span>}
                    </div>
                    <div style={{ flex:1,overflow:"hidden",cursor:"pointer" }} onClick={()=>setPoiForm({poi:p,name:p.name,description:p.description,revealed:p.revealed,category:p.category||"other",size:p.size||"large"})}>
                      <div style={{ fontSize:12,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{p.name}</div>
                      <div style={{ fontSize:10,color:cc,fontWeight:500 }}>{getCatLabel(p.category)}</div>
                    </div>
                    <button onClick={()=>togglePOIReveal(p.id,p.revealed)}
                      style={{ padding:"3px 8px",borderRadius:10,border:"none",background:p.revealed?"#EAF3DE":"#FEF3E2",color:p.revealed?"#3B6D11":"#854F0B",fontSize:11,fontWeight:500,cursor:"pointer",flexShrink:0 }}>
                      {p.revealed?"Shown":"Hidden"}
                    </button>
                  </div>
                );
              })}
            </>}

            {libSubTab==="categories" && <>
              <div style={{ marginBottom:12 }}>
                <span style={{ fontWeight:500 }}>Category Icons</span>
                <p style={{ fontSize:12,color:"#888",marginTop:4 }}>Assign a default icon per category. POIs without a custom icon use this automatically.</p>
              </div>
              {CATEGORIES.map(cat=>{
                const iconUrl = categoryIcons[cat.id];
                return (
                  <div key={cat.id} style={{ display:"flex",alignItems:"center",gap:10,padding:"8px 10px",background:"#f5f5f5",borderRadius:8,marginBottom:8 }}>
                    <div style={{ width:36,height:36,borderRadius:"50%",border:`2px solid ${cat.color}`,overflow:"hidden",flexShrink:0,background:cat.color+"33",display:"flex",alignItems:"center",justifyContent:"center" }}>
                      {iconUrl?<img src={iconUrl} alt="" draggable={false} style={{ width:"100%",height:"100%",objectFit:"contain" }} />:<span style={{ fontSize:13,fontWeight:700,color:cat.color==="#EEEEEE"?"#aaa":cat.color }}>?</span>}
                    </div>
                    <span style={{ flex:1,fontSize:13,fontWeight:500 }}>{cat.label}</span>
                    <div style={{ display:"flex",gap:6 }}>
                      <FilePicker label={iconUrl?"Replace":"Upload"} onFile={f=>saveCategoryIcon(cat.id,f)} />
                      {iconUrl && <Btn size="sm" variant="danger" onClick={()=>removeCategoryIcon(cat.id)}>Clear</Btn>}
                    </div>
                  </div>
                );
              })}
            </>}

            {libSubTab==="players" && <>
              <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:12,flexWrap:"wrap" }}>
                <span style={{ fontWeight:500 }}>Players</span>
                <div style={{ display:"flex",alignItems:"center",gap:8,marginLeft:"auto" }}>
                  <span style={{ fontSize:12,color:"#666" }}>Marker limit per player:</span>
                  <input type="number" min={0} max={50} value={markerLimit}
                    onChange={e=>setMarkerLimit(Number(e.target.value))}
                    onBlur={e=>updateMarkerLimit(Number(e.target.value))}
                    style={{ ...IS,width:60 }} />
                </div>
              </div>
              {members.length===0 && <p style={{ color:"#888",fontSize:13 }}>No members yet.</p>}
              {members.map(m=>(
                <div key={m.user_id} style={{ display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:"#f5f5f5",borderRadius:8,marginBottom:6 }}>
                  <div style={{ width:24,height:24,borderRadius:"50%",background:m.player_color||"#ddd",border:"2px solid #ccc",flexShrink:0 }} />
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13,fontWeight:500 }}>
                      {m.display_name || (m.role==="gm" ? "Game Master" : m.user_id===user.id ? "You" : "Unknown Player")}
                    </div>
                    <div style={{ fontSize:11,color:"#888" }}>{m.role} · {markers.filter(mk=>mk.user_id===m.user_id&&mk.map_id===activeMapId).length} markers placed</div>
                  </div>
                  {m.player_color && <div style={{ fontSize:11,padding:"2px 8px",borderRadius:10,background:m.player_color+"22",color:m.player_color==="#FFFFFF"?"#aaa":m.player_color,border:`1px solid ${m.player_color}`,fontWeight:500 }}>{m.player_color}</div>}
                </div>
              ))}
            </>}
          </div>
        </div>
      )}

      {/* OVERLAYS TAB — visible to all; GM gets Zones sub-tab too */}
      {tab==="overlays" && (
        <div style={{ display:"flex",flexDirection:"column",flex:1,minHeight:0 }}>
          <div style={{ display:"flex",borderBottom:"0.5px solid #ddd",padding:"0 14px",background:"#fafafa" }}>
            {["layers",...(isGM?["zones"]:[])].map(st=>(
              <button key={st} onClick={()=>setOvSubTab(st)} style={{ padding:"6px 12px",border:"none",borderBottom:ovSubTab===st?"2px solid #3C3489":"2px solid transparent",background:"transparent",cursor:"pointer",fontSize:12,fontWeight:ovSubTab===st?500:400,color:ovSubTab===st?"#3C3489":"#888",textTransform:"capitalize" }}>{st}</button>
            ))}
          </div>
          <div style={{ flex:1,overflowY:"auto",padding:14 }}>

            {/* LAYERS — GM management only; opacity/visibility lives on the map page */}
            {ovSubTab==="layers" && <>
              <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:8 }}>
                <span style={{ fontWeight:500 }}>Image Layers</span>
                <FilePicker label="+ Upload Layer" onFile={uploadOverlay} />
              </div>
              <p style={{ fontSize:12,color:"#888",marginBottom:12 }}>Opacity and visibility controls are on the Map tab (Layers &amp; Zones strip).</p>
              {mapOverlays.length===0 && <p style={{ color:"#888",fontSize:13 }}>No layers yet. Upload an image to overlay it above the map.</p>}
              {mapOverlays.map(ov=>(
                <div key={ov.id} style={{ display:"flex",alignItems:"center",gap:10,padding:"8px 10px",background:"#f5f5f5",borderRadius:8,marginBottom:8 }}>
                  <img src={ov.src} alt={ov.name} style={{ width:40,height:40,objectFit:"cover",borderRadius:4,flexShrink:0,border:"0.5px solid #ddd" }} />
                  <div style={{ flex:1,fontSize:13,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{ov.name}</div>
                  <Btn size="sm" variant="danger" onClick={()=>deleteOverlay(ov.id)}>✕ Delete</Btn>
                </div>
              ))}
            </>}

            {/* ZONES — GM only */}
            {ovSubTab==="zones" && isGM && <>
              <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:12 }}>
                <span style={{ fontWeight:500 }}>Zones</span>
                <Btn size="sm" variant="primary" onClick={()=>{ setPlacingMode("zone"); setPlacingZonePoints([]); setTab("map"); }}>+ New Zone</Btn>
              </div>
              {mapZones.length===0 && <p style={{ color:"#888",fontSize:13 }}>No zones yet. Click "+ New Zone" then tap waypoints on the map (min 3), then click "Close Zone ✓".</p>}
              {mapZones.map(z=>(
                <div key={z.id} style={{ display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:"#f5f5f5",borderRadius:8,marginBottom:6 }}>
                  <div style={{ width:28,height:28,borderRadius:6,background:z.fill_color,opacity:z.opacity/100,flexShrink:0,border:"1px solid #ccc" }} />
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontSize:13,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{z.name||"Unnamed Zone"}</div>
                    <div style={{ fontSize:11,color:"#888" }}>{z.points.length} points · opacity {z.opacity}%</div>
                  </div>
                  <button onClick={()=>toggleZoneReveal(z.id,z.revealed)}
                    style={{ padding:"3px 8px",borderRadius:10,border:"none",background:z.revealed?"#EAF3DE":"#FEF3E2",color:z.revealed?"#3B6D11":"#854F0B",fontSize:11,fontWeight:500,cursor:"pointer",flexShrink:0 }}>
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
        <div style={{ flex:1,overflowY:"auto",padding:14 }}>
          <ProfileTab
            user={user}
            members={members}
            myColor={myColor}
            takenColors={takenColors}
            isGM={isGM}
            onColorChange={chooseColor}
            onSaveDisplayName={saveDisplayName}
          />
        </div>
      )}

      {/* Modals */}
      {zoneForm && <ZoneFormModal form={zoneForm}
        onSave={saveZone} onDelete={deleteZone}
        onAddPoint={zId=>{ setZoneForm(null); addPointZoneRef.current=zId; setPlacingMode("addpoint"); setTab("map"); }}
        onMovePoints={zone=>startZonePointEdit(zone)}
        onClose={()=>setZoneForm(null)} />}
      {poiForm && <POIFormModal form={poiForm} categoryIcons={categoryIcons} onSave={savePOI} onDelete={deletePOI} onDuplicate={duplicatePOI} onClose={()=>setPoiForm(null)} />}
      {markerForm && <MarkerFormModal form={markerForm} onSave={saveMarker} onEdit={editMarker} onCancel={()=>setMarkerForm(null)} />}
      {annotationForm && <AnnotationModal form={annotationForm} onSave={saveAnnotation} onDelete={deleteAnnotation} onCancel={()=>setAnnotationForm(null)} />}

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
  async function handleImage(f) { setImageFile(f); setClearImage(false); setImagePreview(await readFile(f)); }
  function removePoint(i) { if (points.length <= 3) return; setPoints(prev => prev.filter((_,idx) => idx !== i)); }
  return (
    <Modal title={isEdit ? "Edit Zone" : "New Zone"} onClose={onClose} width={440}>
      <Field label="Name">
        <input value={name} onChange={e=>setName(e.target.value)} style={IS} placeholder="e.g. Merchant Quarter" autoFocus />
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
              <input type="checkbox" checked={imageRepeat} onChange={e=>setImageRepeat(e.target.checked)} id="zrep" />
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
      <div style={{ display:"flex",gap:8,flexWrap:"wrap",marginTop:8 }}>
        <Btn variant="primary" onClick={()=>onSave({...form,name,fill_color:fillColor,opacity,revealed,points,clearImage,image_scale:imageScale,image_repeat:imageRepeat},imageFile)} style={{ flex:1 }}>Save</Btn>
        {isEdit && <Btn variant="danger" onClick={()=>onDelete(form.zone.id)}>Delete Zone</Btn>}
      </div>
    </Modal>
  );
}

function POIFormModal({ form, categoryIcons, onSave, onDelete, onDuplicate, onClose }) {
  const [name, setName] = useState(form.poi?.name||"");
  const [description, setDescription] = useState(form.poi?.description||"");
  const [revealed, setRevealed] = useState(form.poi?.revealed||false);
  const [category, setCategory] = useState(form.poi?.category||"other");
  const [size, setSize] = useState(form.poi?.size||"large");
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
      <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:16 }}>
        <input type="checkbox" checked={revealed} onChange={e=>setRevealed(e.target.checked)} id="rev" />
        <label htmlFor="rev" style={{ fontSize:13 }}>Revealed to players</label>
      </div>
      <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
        <Btn variant="primary" onClick={()=>onSave({...form,name,description,revealed,category,size,clearIcon},iconFile)} style={{ flex:1 }}>Save</Btn>
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
  return (
    <Modal title={isEdit?"Edit Marker":"Place Marker"} onClose={onCancel} width={320}>
      <Field label="Title"><input value={label} onChange={e=>setLabel(e.target.value)} style={IS} placeholder="e.g. Camp site" autoFocus /></Field>
      <Field label="Description (optional)"><textarea value={description} onChange={e=>setDescription(e.target.value)} rows={3} style={IS} placeholder="Add a note..." /></Field>
      <div style={{ display:"flex",gap:8 }}>
        {isEdit
          ? <Btn variant="primary" onClick={()=>onEdit(form.marker,label,description)} style={{ flex:1 }}>Save</Btn>
          : <Btn variant="primary" onClick={()=>onSave(label,description)} style={{ flex:1 }}>Place Marker</Btn>
        }
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </Modal>
  );
}

function AnnotationModal({ form, onSave, onDelete, onCancel }) {
  const [content, setContent] = useState(form.ann?.content||"");
  return (
    <Modal title={form.ann?"Edit Note":"New Note"} onClose={onCancel} width={360}>
      <Field label="Note text"><textarea value={content} onChange={e=>setContent(e.target.value)} rows={4} style={IS} autoFocus placeholder="GM note visible on map..." /></Field>
      <div style={{ display:"flex",gap:8 }}>
        <Btn variant="primary" onClick={()=>onSave(form,form.ann?.type||"text",content)} style={{ flex:1 }}>Save</Btn>
        {form.ann&&<Btn variant="danger" onClick={()=>onDelete(form.ann.id)}>Delete</Btn>}
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </Modal>
  );
}

createRoot(document.getElementById("root")).render(<App />);
