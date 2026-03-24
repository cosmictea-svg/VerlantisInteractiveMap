import { useState, useRef, useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";

const SUPA_URL = "https://iqmaumupuftguhurnsdt.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlxbWF1bXVwdWZ0Z3VodXJuc2R0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyNTQ5MjEsImV4cCI6MjA4OTgzMDkyMX0.m7lg88RD_3M3OAqt0g17voz_jbZ0f02w-LocREn5Ffg";

// ── Supabase helpers ──────────────────────────────────────────────────────────
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
}

// ── Realtime via Supabase WebSocket ───────────────────────────────────────────
function createRealtimeChannel(token, campaignId, handlers) {
  const wsUrl = `${SUPA_URL.replace("https://", "wss://")}/realtime/v1/websocket?apikey=${SUPA_KEY}&vsn=1.0.0`;
  let ws, heartbeatTimer, reconnectTimer;
  let closed = false;

  function connect() {
    if (closed) return;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      const tables = ["pois", "markers", "annotations"];
      tables.forEach((table, i) => {
        ws.send(JSON.stringify({
          topic: `realtime:public:${table}:campaign_id=eq.${campaignId}`,
          event: "phx_join",
          payload: {
            config: {
              postgres_changes: [{ event: "*", schema: "public", table, filter: `campaign_id=eq.${campaignId}` }]
            },
            user_token: token
          },
          ref: String(i + 1)
        }));
      });
      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: "hb" }));
        }
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
      } catch {}
    };

    ws.onclose = () => {
      clearInterval(heartbeatTimer);
      if (!closed) reconnectTimer = setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();
  }

  connect();

  return {
    unsubscribe() {
      closed = true;
      clearInterval(heartbeatTimer);
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    }
  };
}

// ── Supabase Storage upload ───────────────────────────────────────────────────
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
function getCatColor(id) { return CATEGORIES.find(c => c.id === id)?.color || "#95A5A6"; }
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

function POIPin({ poi, scale, isGM, onTap, onDragStart }) {
  const ss = getSizeScale(poi.size);
  const size = Math.max(28 * ss, (36 / scale) * ss);
  const bw = Math.max(1.5, 3 / scale);
  const cc = getCatColor(poi.category);
  return (
    <div
      onMouseDown={e => { if (isGM) { e.stopPropagation(); onDragStart(e, poi); } }}
      onTouchStart={e => { if (isGM) { e.stopPropagation(); onDragStart(e, poi); } }}
      onClick={e => { e.stopPropagation(); onTap(poi); }}
      style={{ position: "absolute", left: poi.x - size/2, top: poi.y - size, width: size, height: size, cursor: isGM ? "grab" : "pointer", zIndex: 20, borderRadius: "50%", border: `${bw}px solid ${cc}`, boxSizing: "border-box", overflow: "hidden", background: cc + "59" }}
    >
      {poi.icon_url
        ? <img src={poi.icon_url} alt={poi.name} draggable={false} onDragStart={e => e.preventDefault()} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", pointerEvents: "none" }} />
        : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "white", fontWeight: 700, fontSize: Math.max(8, 14 * ss / scale), lineHeight: 1 }}>?</span>
          </div>
      }
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
function App() {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [campaigns, setCampaigns] = useState([]);
  const [activeCampaign, setActiveCampaign] = useState(null);
  const [memberRole, setMemberRole] = useState(null);
  const [maps, setMaps] = useState([]);
  const [activeMapId, setActiveMapId] = useState(null);
  const [mapStack, setMapStack] = useState([]);
  const [pois, setPois] = useState([]);
  const [markers, setMarkers] = useState([]);
  const [annotations, setAnnotations] = useState([]);
  const [tab, setTab] = useState("map");
  const [placingMode, setPlacingMode] = useState(null);
  const [poiForm, setPoiForm] = useState(null);
  const [markerForm, setMarkerForm] = useState(null);
  const [annotationForm, setAnnotationForm] = useState(null);
  const [openPOICard, setOpenPOICard] = useState(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [scrollSens, setScrollSens] = useState(5);
  const [libSort, setLibSort] = useState("name");
  const [showCampaignModal, setShowCampaignModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [newCampaignName, setNewCampaignName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState("");

  const mapRef = useRef(null);
  const dragRef = useRef({ active: false, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false });
  const placingRef = useRef(null);
  const transformRef = useRef(transform);
  const imgSizeRef = useRef(imgSize);
  const scrollSensRef = useRef(scrollSens);
  const poiDragState = useRef(null);
  const realtimeRef = useRef(null);
  const sessionRef = useRef(session);

  useEffect(() => { placingRef.current = placingMode; }, [placingMode]);
  useEffect(() => { transformRef.current = transform; }, [transform]);
  useEffect(() => { imgSizeRef.current = imgSize; }, [imgSize]);
  useEffect(() => { scrollSensRef.current = scrollSens; }, [scrollSens]);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // ── Auth init + token refresh ──
  useEffect(() => {
    async function init() {
      let sess = parseHashSession();
      if (sess) {
        localStorage.setItem("sb_session", JSON.stringify(sess));
        window.history.replaceState(null, "", window.location.pathname);
      } else {
        sess = getStoredSession();
      }
      if (sess) {
        // Try refreshing token immediately
        const refreshed = await refreshSession(sess.refresh_token);
        if (refreshed?.access_token) {
          sess = { access_token: refreshed.access_token, refresh_token: refreshed.refresh_token || sess.refresh_token };
          localStorage.setItem("sb_session", JSON.stringify(sess));
        }
        const u = await getUser(sess.access_token);
        if (u) { setSession(sess); setUser(u); }
        else { localStorage.removeItem("sb_session"); }
      }
      setLoading(false);
    }
    init();

    // Refresh token every 50 minutes
    const refreshTimer = setInterval(async () => {
      const stored = getStoredSession();
      if (!stored?.refresh_token) return;
      const refreshed = await refreshSession(stored.refresh_token);
      if (refreshed?.access_token) {
        const newSess = { access_token: refreshed.access_token, refresh_token: refreshed.refresh_token || stored.refresh_token };
        localStorage.setItem("sb_session", JSON.stringify(newSess));
        setSession(newSess);
      }
    }, 50 * 60 * 1000);

    return () => clearInterval(refreshTimer);
  }, []);

  useEffect(() => { if (user && session) loadCampaigns(); }, [user]);

  // ── Realtime subscriptions ──
  useEffect(() => {
    if (!activeCampaign || !session) return;

    if (realtimeRef.current) realtimeRef.current.unsubscribe();

    realtimeRef.current = createRealtimeChannel(session.access_token, activeCampaign.id, {
      onPOI: (payload) => {
        if (payload.eventType === "INSERT") setPois(p => { if (p.find(x => x.id === payload.new.id)) return p; return [...p, payload.new]; });
        if (payload.eventType === "UPDATE") setPois(p => p.map(x => x.id === payload.new.id ? payload.new : x));
        if (payload.eventType === "DELETE") setPois(p => p.filter(x => x.id !== (payload.old?.id || payload.old_record?.id)));
      },
      onMarker: (payload) => {
        if (payload.eventType === "INSERT") setMarkers(m => { if (m.find(x => x.id === payload.new.id)) return m; return [...m, payload.new]; });
        if (payload.eventType === "UPDATE") setMarkers(m => m.map(x => x.id === payload.new.id ? payload.new : x));
        if (payload.eventType === "DELETE") setMarkers(m => m.filter(x => x.id !== (payload.old?.id || payload.old_record?.id)));
      },
      onAnnotation: (payload) => {
        if (payload.eventType === "INSERT") setAnnotations(a => { if (a.find(x => x.id === payload.new.id)) return a; return [...a, payload.new]; });
        if (payload.eventType === "UPDATE") setAnnotations(a => a.map(x => x.id === payload.new.id ? payload.new : x));
        if (payload.eventType === "DELETE") setAnnotations(a => a.filter(x => x.id !== (payload.old?.id || payload.old_record?.id)));
      },
    });

    return () => { if (realtimeRef.current) realtimeRef.current.unsubscribe(); };
  }, [activeCampaign?.id, session?.access_token]);

  async function loadCampaigns() {
    try {
      const members = await dbSelect(session.access_token, "campaign_members", `user_id=eq.${user.id}&select=campaign_id,role`);
      if (!members.length) { setCampaigns([]); return; }
      const ids = members.map(m => m.campaign_id).join(",");
      const camps = await dbSelect(session.access_token, "campaigns", `id=in.(${ids})`);
      setCampaigns(camps.map(c => ({ ...c, myRole: members.find(m => m.campaign_id === c.id)?.role })));
    } catch(e) { setError(e.message); }
  }

  async function loadCampaignData(camp, role) {
    setActiveCampaign(camp); setMemberRole(role);
    try {
      const [mapsData, poisData, markersData, annsData] = await Promise.all([
        dbSelect(session.access_token, "maps", `campaign_id=eq.${camp.id}&order=created_at`),
        dbSelect(session.access_token, "pois", `campaign_id=eq.${camp.id}`),
        dbSelect(session.access_token, "markers", `campaign_id=eq.${camp.id}`),
        dbSelect(session.access_token, "annotations", `campaign_id=eq.${camp.id}`),
      ]);
      setMaps(mapsData); setPois(poisData); setMarkers(markersData); setAnnotations(annsData);
      const main = mapsData.find(m => m.is_main) || mapsData[0];
      if (main) setActiveMapId(main.id);
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
  function resetView() { setTransform(fitToContainer(imgSize.w, imgSize.h)); }
  function onImgLoad(e) {
    const w = e.target.naturalWidth, h = e.target.naturalHeight;
    setImgSize({ w, h }); setTransform(fitToContainer(w, h));
  }
  function toMapCoords(cx, cy) {
    const rect = getContainerRect(); const t = transformRef.current;
    return { x: (cx - rect.left - t.x) / t.scale, y: (cy - rect.top - t.y) / t.scale };
  }

  // POI drag
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

  // Map pan
  function onPointerDown(e) {
    if (poiDragState.current) return;
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
      if (!dragRef.current.moved && placingRef.current) {
        const cx2 = ev.changedTouches ? ev.changedTouches[0].clientX : (ev.clientX ?? dragRef.current.startX);
        const cy2 = ev.changedTouches ? ev.changedTouches[0].clientY : (ev.clientY ?? dragRef.current.startY);
        const coords = toMapCoords(cx2, cy2);
        const mode = placingRef.current; setPlacingMode(null);
        if (mode === "poi") setPoiForm({ poi: null, x: coords.x, y: coords.y, name: "", description: "", revealed: false, category: "other", size: "large" });
        if (mode === "marker") setMarkerForm({ x: coords.x, y: coords.y });
        if (mode === "annotation") setAnnotationForm({ ann: null, x: coords.x, y: coords.y });
      }
    }
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: true }); window.addEventListener("touchend", onUp);
  }

  // ── Attach wheel + pinch once map is ready ──
  useEffect(() => {
    if (tab !== "map") return;
    let wheelCleanup = null, pinchCleanup = null;
    let attempts = 0;

    function attachAll() {
      const el = mapRef.current;
      if (!el) {
        if (attempts++ < 30) { setTimeout(attachAll, 100); return; }
        return;
      }

      // Wheel zoom — uses ref so sensitivity changes work without re-attaching
      function onWheel(e) {
        e.preventDefault();
        const sens = scrollSensRef.current / 10;
        const factor = 1 + (e.deltaY < 0 ? 1 : -1) * 0.08 * sens * 10;
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        setTransform(t => {
          const ns = Math.min(8, Math.max(0.1, t.scale * factor));
          const sr = ns / t.scale;
          const next = { scale: ns, x: mx - sr * (mx - t.x), y: my - sr * (my - t.y) };
          return clamp(next, rect.width, rect.height, imgSizeRef.current.w, imgSizeRef.current.h);
        });
      }
      el.addEventListener("wheel", onWheel, { passive: false });
      wheelCleanup = () => el.removeEventListener("wheel", onWheel);

      // Pinch zoom
      let lastDist = null, isPinching = false;
      function getDist(t) { const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx*dx+dy*dy); }
      function getMid(t) { return { x: (t[0].clientX+t[1].clientX)/2, y: (t[0].clientY+t[1].clientY)/2 }; }
      function onTS(e) { if (e.touches.length === 2) { isPinching = true; lastDist = getDist(e.touches); dragRef.current.active = false; setIsDragging(false); } }
      function onTM(e) {
        if (e.touches.length !== 2 || !isPinching) return;
        e.preventDefault();
        const dist = getDist(e.touches); if (!lastDist) { lastDist = dist; return; }
        const factor = Math.min(Math.max(dist / lastDist, 0.5), 2); lastDist = dist;
        const mid = getMid(e.touches); const rect = el.getBoundingClientRect();
        const mx = mid.x - rect.left, my = mid.y - rect.top;
        setTransform(t => {
          const ns = Math.min(8, Math.max(0.1, t.scale * factor));
          const sr = ns / t.scale;
          const next = { scale: ns, x: mx - sr * (mx - t.x), y: my - sr * (my - t.y) };
          return clamp(next, rect.width, rect.height, imgSizeRef.current.w, imgSizeRef.current.h);
        });
      }
      function onTE(e) { if (e.touches.length < 2) { isPinching = false; lastDist = null; } }
      el.addEventListener("touchstart", onTS, { passive: true });
      el.addEventListener("touchmove", onTM, { passive: false });
      el.addEventListener("touchend", onTE, { passive: true });
      pinchCleanup = () => { el.removeEventListener("touchstart", onTS); el.removeEventListener("touchmove", onTM); el.removeEventListener("touchend", onTE); };
    }

    const t = setTimeout(attachAll, 80);
    return () => {
      clearTimeout(t);
      wheelCleanup && wheelCleanup();
      pinchCleanup && pinchCleanup();
    };
  }, [tab, activeCampaign]);

  // CRUD
  async function savePOI(form, iconFile) {
    let icon_url = form.clearIcon ? "" : (form.poi?.icon_url || "");
    if (iconFile) {
      try {
        icon_url = await uploadToStorage(session.access_token, iconFile);
      } catch(e) {
        // Fallback to base64 if storage upload fails
        icon_url = await readFile(iconFile);
      }
    }
    const body = { name: form.name||"Unnamed POI", description: form.description||"", revealed: form.revealed, category: form.category||"other", size: form.size||"large", icon_url };
    try {
      if (form.poi) {
        await dbUpdate(session.access_token, "pois", form.poi.id, body);
        setPois(prev => prev.map(p => p.id === form.poi.id ? { ...p, ...body } : p));
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
    dbInsert(session.access_token, "pois", {
      name: poi.name+" (copy)", description: poi.description, revealed: false,
      category: poi.category, size: poi.size, icon_url: poi.icon_url,
      campaign_id: poi.campaign_id, map_id: poi.map_id, x: poi.x+30, y: poi.y+30
    }).then(([np]) => {
      // Add locally immediately — realtime will handle other clients
      setPois(prev => prev.find(x => x.id === np.id) ? prev : [...prev, np]);
    }).catch(e => setError(e.message));
    setPoiForm(null);
  }
  async function togglePOIReveal(id, current) {
    try { await dbUpdate(session.access_token, "pois", id, { revealed: !current }); setPois(prev=>prev.map(p=>p.id===id?{...p,revealed:!current}:p)); } catch(e) { setError(e.message); }
  }
  async function saveMarker(label) {
    if (!markerForm) return;
    try {
      const [nm] = await dbInsert(session.access_token, "markers", { campaign_id: activeCampaign.id, map_id: activeMapId, user_id: user.id, user_name: user.user_metadata?.full_name||user.email, label, x: markerForm.x, y: markerForm.y });
      setMarkers(prev => [...prev, nm]); setMarkerForm(null);
    } catch(e) { setError(e.message); }
  }
  async function deleteMarker(id) {
    try { await dbDelete(session.access_token, "markers", id); setMarkers(prev=>prev.filter(m=>m.id!==id)); } catch(e) { setError(e.message); }
  }
  async function saveAnnotation(form, type, content) {
    try {
      if (form.ann) {
        await dbUpdate(session.access_token, "annotations", form.ann.id, { type, content });
        setAnnotations(prev=>prev.map(a=>a.id===form.ann.id?{...a,type,content}:a));
      } else {
        const [na] = await dbInsert(session.access_token, "annotations", { campaign_id: activeCampaign.id, map_id: activeMapId, type, content, visible: false, x: form.x, y: form.y });
        setAnnotations(prev=>[...prev,na]);
      }
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
    try {
      for (const m of maps) await dbUpdate(session.access_token, "maps", m.id, { is_main: m.id===id });
      setMaps(prev=>prev.map(m=>({...m,is_main:m.id===id})));
    } catch(e) { setError(e.message); }
  }
  async function deleteMap(id) {
    if (!window.confirm("Delete this map?")) return;
    try {
      await dbDelete(session.access_token, "maps", id);
      const remaining = maps.filter(m=>m.id!==id); setMaps(remaining);
      if (activeMapId===id) setActiveMapId(remaining[0]?.id||null);
    } catch(e) { setError(e.message); }
  }
  function goBack() { const prev=mapStack[mapStack.length-1]; setMapStack(s=>s.slice(0,-1)); setActiveMapId(prev||null); setTransform({x:0,y:0,scale:1}); setImgSize({w:0,h:0}); }

  const openPOI = mapPOIs.find(p=>p.id===openPOICard);
  const poiCardPos = openPOI ? (() => {
    const rect=getContainerRect();
    const sx=openPOI.x*transform.scale+transform.x, sy=openPOI.y*transform.scale+transform.y;
    const cardW=210,cardH=240,pad=8;
    let left=sx+16,top=sy-cardH/2;
    if(left+cardW>rect.width-pad) left=sx-cardW-16;
    left=Math.max(pad,Math.min(rect.width-cardW-pad,left));
    top=Math.max(pad,Math.min(rect.height-cardH-pad,top));
    return {left,top,cardW};
  })() : null;

  const sortedLibPOIs = [...pois].sort((a,b)=>libSort==="name"?(a.name||"").localeCompare(b.name||""):(a.category||"").localeCompare(b.category||""));
  const tabs = ["map",...(isGM?["library","overlays"]:[])];

  // ── Render ──
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
      <div style={{ display:"flex",alignItems:"center",gap:8,padding:"8px 14px",borderBottom:"0.5px solid #ddd",flexWrap:"wrap",background:"#fff" }}>
        <button onClick={()=>{setActiveCampaign(null);if(realtimeRef.current)realtimeRef.current.unsubscribe();}} style={{ background:"none",border:"none",cursor:"pointer",fontSize:18,padding:0,color:"#555" }}>←</button>
        <span style={{ fontWeight:500,fontSize:14,flex:1 }}>{activeCampaign.name}</span>
        {mapStack.length>0 && <Btn size="sm" onClick={goBack}>↩ Back</Btn>}
        <span style={{ fontSize:11,padding:"2px 8px",borderRadius:20,background:isGM?"#EAF3DE":"#E6F1FB",color:isGM?"#3B6D11":"#185FA5",fontWeight:500 }}>{isGM?"GM":"Player"}</span>
        <span style={{ fontSize:11,color:"#888",maxWidth:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{user.user_metadata?.full_name||user.email}</span>
      </div>
      {error && <div style={{ background:"#fee",color:"#A32D2D",padding:"5px 14px",fontSize:12 }}>{error}<button onClick={()=>setError("")} style={{ marginLeft:8,border:"none",background:"none",cursor:"pointer" }}>✕</button></div>}
      {isGM && <div style={{ padding:"3px 14px",background:"#f0f0ff",fontSize:11,color:"#555",borderBottom:"0.5px solid #ddd" }}>Campaign ID for players: <strong>{activeCampaign.id}</strong></div>}
      <div style={{ display:"flex",borderBottom:"0.5px solid #ddd",padding:"0 14px" }}>
        {tabs.map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{ padding:"7px 12px",border:"none",borderBottom:tab===t?"2px solid #3C3489":"2px solid transparent",background:"transparent",cursor:"pointer",fontSize:12,fontWeight:tab===t?500:400,color:tab===t?"#3C3489":"#888",textTransform:"capitalize" }}>{t}</button>
        ))}
      </div>

      {tab==="map" && (
        <div style={{ flex:1,display:"flex",flexDirection:"column",minHeight:0 }}>
          <div style={{ display:"flex",gap:6,padding:"7px 14px",borderBottom:"0.5px solid #ddd",flexWrap:"wrap",alignItems:"center" }}>
            {isGM && <>
              <Btn size="sm" onClick={()=>setPlacingMode(p=>p==="poi"?null:"poi")} style={{ background:placingMode==="poi"?"#EAF3DE":undefined }}>+ POI</Btn>
              <Btn size="sm" onClick={()=>setPlacingMode(p=>p==="annotation"?null:"annotation")} style={{ background:placingMode==="annotation"?"#EAF3DE":undefined }}>+ Note</Btn>
            </>}
            <Btn size="sm" onClick={()=>setPlacingMode(p=>p==="marker"?null:"marker")} style={{ background:placingMode==="marker"?"#dce8fa":undefined }}>+ Marker</Btn>
            <Btn size="sm" onClick={resetView}>Fit</Btn>
            {placingMode && <span style={{ fontSize:11,color:"#185FA5",padding:"2px 8px",background:"#E6F1FB",borderRadius:20 }}>Tap map to place {placingMode}</span>}
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:8,padding:"4px 14px",borderBottom:"0.5px solid #ddd",background:"#f9f9f9" }}>
            <span style={{ fontSize:11,color:"#888",whiteSpace:"nowrap" }}>Zoom speed</span>
            <input type="range" min={1} max={10} step={1} value={scrollSens} onChange={e=>setScrollSens(Number(e.target.value))} style={{ flex:1,maxWidth:120 }} />
            <span style={{ fontSize:11,color:"#888",minWidth:12 }}>{scrollSens}</span>
          </div>
          <div style={{ flex:1,minHeight:0,position:"relative" }}>
            <div ref={mapRef} style={{ position:"absolute",inset:0,overflow:"hidden",background:"#1a1a2e",cursor:placingMode?"crosshair":isDragging?"grabbing":"grab",touchAction:"none",userSelect:"none" }}
              onMouseDown={onPointerDown} onTouchStart={onPointerDown}
              onClick={()=>{ if(!dragRef.current.moved) setOpenPOICard(null); }}>
              {!currentMap ? (
                <div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",color:"#aaa",gap:8 }}>
                  <span style={{ fontSize:40 }}>🗺</span>
                  <span style={{ fontSize:13 }}>{isGM?"Go to Library to upload a map.":"Waiting for GM to load a map."}</span>
                </div>
              ) : (
                <div style={{ position:"absolute",transform:`translate(${transform.x}px,${transform.y}px) scale(${transform.scale})`,transformOrigin:"0 0" }}>
                  <img src={currentMap.src} alt="map" style={{ display:"block",maxWidth:"none" }} draggable={false} onLoad={onImgLoad} />
                  {mapPOIs.map(p=>(
                    <POIPin key={p.id} poi={p} scale={transform.scale} isGM={isGM}
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
                  {mapMarkers.map(m=>(
                    <div key={m.id} onClick={e=>{e.stopPropagation();if(dragRef.current.moved)return;if(isGM||m.user_id===user.id)deleteMarker(m.id);}}
                      style={{ position:"absolute",left:m.x-8,top:m.y-20,cursor:"pointer",zIndex:25 }}>
                      <div style={{ width:16,height:16,background:m.user_id===user.id?"#378ADD":"#E67E22",borderRadius:"50% 50% 50% 0",transform:"rotate(-45deg)",border:"2px solid white" }} />
                      <div style={{ position:"absolute",top:18,left:-24,fontSize:9,background:"white",padding:"1px 4px",borderRadius:4,whiteSpace:"nowrap",border:"0.5px solid #ccc",color:"#111",maxWidth:80,overflow:"hidden",textOverflow:"ellipsis" }}>
                        {m.user_name?.split(" ")[0]||"?"}{m.label?`: ${m.label}`:""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {openPOI && poiCardPos && (
              <div onMouseDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()}
                style={{ position:"absolute",left:poiCardPos.left,top:poiCardPos.top,width:poiCardPos.cardW,background:"white",borderRadius:10,border:`2px solid ${getCatColor(openPOI.category)}`,zIndex:100,overflow:"hidden",boxSizing:"border-box" }}>
                <div style={{ display:"flex",alignItems:"center",gap:8,padding:"8px 10px 6px",borderBottom:"0.5px solid #eee" }}>
                  <div style={{ width:32,height:32,borderRadius:"50%",border:`2px solid ${getCatColor(openPOI.category)}`,overflow:"hidden",flexShrink:0,background:getCatColor(openPOI.category)+"33",display:"flex",alignItems:"center",justifyContent:"center" }}>
                    {openPOI.icon_url?<img src={openPOI.icon_url} alt="" style={{ width:"100%",height:"100%",objectFit:"contain" }} />:<span style={{ fontSize:14,fontWeight:700,color:getCatColor(openPOI.category) }}>?</span>}
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
          </div>
          <div style={{ padding:"4px 14px",borderTop:"0.5px solid #ddd",display:"flex",gap:12,fontSize:10,color:"#888",flexWrap:"wrap" }}>
            <span>Tap POI to view</span>
            {isGM && <span style={{ color:"#185FA5" }}>GM: drag pin to move, tap to edit</span>}
            <span><span style={{ display:"inline-block",width:7,height:7,background:"#378ADD",borderRadius:"50%",marginRight:3,verticalAlign:"middle" }} />Your markers</span>
            <span><span style={{ display:"inline-block",width:7,height:7,background:"#E67E22",borderRadius:"50%",marginRight:3,verticalAlign:"middle" }} />Others</span>
          </div>
        </div>
      )}

      {tab==="library" && isGM && (
        <div style={{ padding:14,overflowY:"auto",flex:1 }}>
          <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:12 }}>
            <span style={{ fontWeight:500 }}>Maps</span>
            <FilePicker label="+ Upload" onFile={uploadMap} />
          </div>
          {maps.length===0 && <p style={{ color:"#888",fontSize:13 }}>No maps yet.</p>}
          <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10,marginBottom:20 }}>
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
          <div style={{ borderTop:"0.5px solid #ddd",paddingTop:12 }}>
            <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap" }}>
              <span style={{ fontWeight:500 }}>POIs</span>
              <button onClick={()=>setLibSort("name")} style={{ fontSize:11,padding:"2px 8px",borderRadius:20,border:"0.5px solid #aaa",background:libSort==="name"?"#3C3489":"transparent",color:libSort==="name"?"white":"#333",cursor:"pointer" }}>Name</button>
              <button onClick={()=>setLibSort("type")} style={{ fontSize:11,padding:"2px 8px",borderRadius:20,border:"0.5px solid #aaa",background:libSort==="type"?"#3C3489":"transparent",color:libSort==="type"?"white":"#333",cursor:"pointer" }}>Type</button>
            </div>
            {sortedLibPOIs.length===0 && <p style={{ color:"#888",fontSize:12 }}>No POIs yet.</p>}
            {sortedLibPOIs.map(p=>{
              const cc=getCatColor(p.category);
              return (
                <div key={p.id} style={{ display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:"#f5f5f5",borderRadius:8,marginBottom:6 }}>
                  <div style={{ width:30,height:30,borderRadius:"50%",border:`2px solid ${cc}`,overflow:"hidden",flexShrink:0,background:cc+"33",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}
                    onClick={()=>setPoiForm({poi:p,name:p.name,description:p.description,revealed:p.revealed,category:p.category||"other",size:p.size||"large"})}>
                    {p.icon_url?<img src={p.icon_url} alt="" style={{ width:"100%",height:"100%",objectFit:"contain" }} />:<span style={{ fontSize:12,fontWeight:700,color:cc }}>?</span>}
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
          </div>
        </div>
      )}

      {tab==="overlays" && isGM && (
        <div style={{ padding:14,flex:1 }}>
          <div style={{ fontWeight:500,marginBottom:8 }}>Overlays</div>
          <p style={{ color:"#888",fontSize:13 }}>Faction overlays, fog of war and road types coming soon.</p>
        </div>
      )}

      {poiForm && <POIFormModal form={poiForm} onSave={savePOI} onDelete={deletePOI} onDuplicate={duplicatePOI} onClose={()=>setPoiForm(null)} />}
      {markerForm && <MarkerModal onSave={saveMarker} onCancel={()=>setMarkerForm(null)} />}
      {annotationForm && <AnnotationModal form={annotationForm} onSave={saveAnnotation} onDelete={deleteAnnotation} onCancel={()=>setAnnotationForm(null)} />}
    </div>
  );
}

function POIFormModal({ form, onSave, onDelete, onDuplicate, onClose }) {
  const [name, setName] = useState(form.poi?.name||"");
  const [description, setDescription] = useState(form.poi?.description||"");
  const [revealed, setRevealed] = useState(form.poi?.revealed||false);
  const [category, setCategory] = useState(form.poi?.category||"other");
  const [size, setSize] = useState(form.poi?.size||"large");
  const [iconFile, setIconFile] = useState(null);
  const [iconPreview, setIconPreview] = useState(form.poi?.icon_url||"");
  const [clearIcon, setClearIcon] = useState(false);
  const cc = getCatColor(category);
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
            {iconPreview&&!clearIcon?<img src={iconPreview} alt="" style={{ width:"100%",height:"100%",objectFit:"contain" }} />:<span style={{ fontSize:16,fontWeight:700,color:cc }}>?</span>}
          </div>
          <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
            <FilePicker label="Upload" onFile={handleIcon} />
            {iconPreview&&!clearIcon&&<Btn size="sm" variant="danger" onClick={()=>{setClearIcon(true);setIconPreview("");setIconFile(null);}}>Remove</Btn>}
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

function MarkerModal({ onSave, onCancel }) {
  const [label, setLabel] = useState("");
  return (
    <Modal title="Place Marker" onClose={onCancel} width={300}>
      <Field label="Label (optional)"><input value={label} onChange={e=>setLabel(e.target.value)} style={IS} placeholder="e.g. We camped here" autoFocus onKeyDown={e=>{if(e.key==="Enter")onSave(label);}} /></Field>
      <div style={{ display:"flex",gap:8 }}>
        <Btn variant="primary" onClick={()=>onSave(label)} style={{ flex:1 }}>Place Marker</Btn>
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
