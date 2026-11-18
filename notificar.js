// AgroClima · aviso automático (lo corre GitHub Actions todos los días).
// 1) Hace una consulta a Supabase para que el proyecto gratis no se pause.
// 2) Los lunes, miércoles, viernes y domingo (o si FORZAR=1) calcula el resumen y manda la notificación
//    a los teléfonos que activaron los avisos en la app.
// Usa el mismo código de cálculo que la app: lo baja de la página publicada.
const vm = require('vm');
let webpush = null;

const APP = process.env.APP_URL || 'https://carlojaq.github.io/agroclima/';
const SB_URL = 'https://gdrnstimuliiyxsmvujq.supabase.co';
const VAPID_PUB = process.env.VAPID_PUBLIC;
const VAPID_PRIV = process.env.VAPID_PRIVATE;
const DIAS_AVISO = [0, 1, 3, 5]; // domingo, lunes, miércoles, viernes

const pad = n => String(n).padStart(2, '0');
const hoyStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const ahoraStr = () => `${hoyStr()}T${pad(new Date().getHours())}:00`;
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const fCorta = s => { const [y, m, d] = s.split('-').map(Number); return `${DIAS[new Date(y, m - 1, d).getDay()]} ${d}/${m}`; };

async function main() {
  const html = await (await fetch(APP + 'index.html?x=' + Date.now())).text();
  const KEY = (html.match(/sb_publishable_[A-Za-z0-9_-]+/) || [])[0];
  if (!KEY) throw new Error('No encontré la clave pública en la app publicada.');
  const sb = async (method, path, body) => {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers: { apikey: KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return method === 'GET' ? r.json() : null;
  };
  // 1) mantener activo
  const lotesTodos = await sb('GET', 'ac_lotes?select=*');
  console.log(`Supabase activo: ${lotesTodos.length} lotes.`);

  const dia = new Date().getDay();
  if (process.env.FORZAR !== '1' && !DIAS_AVISO.includes(dia)) { console.log('Hoy no toca aviso.'); return; }
  if (!VAPID_PRIV) { console.log('Falta el secreto VAPID_PRIVATE: no se envían avisos.'); return; }

  // 2) cargar el código de cálculo de la app (modelos + contenido + calendario)
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const mod = scripts.find(s => s.includes('const M = (() =>'));
  const con = scripts.find(s => s.includes('const G = (() =>'));
  const ctx = vm.createContext({ console, Math, Date, JSON, Intl, Object, Array, String, Number, RegExp, Set, Map, isFinite, isNaN });
  vm.runInContext(mod + '\n' + con + '\nglobalThis.__X = { M, G, CAL };', ctx);
  const { M, G, CAL } = ctx.__X;

  const [apps, cfgs, subs] = await Promise.all([sb('GET', 'ac_aplicaciones?select=*'), sb('GET', 'ac_config?id=eq.general&select=datos'), sb('GET', 'ac_push?select=*&activo=eq.true')]);
  const prods = await sb('GET', 'ac_productos?select=*').catch(() => []);
  if (!subs.length) { console.log('Nadie activó las notificaciones todavía.'); return; }
  const CFG = Object.assign(JSON.parse(JSON.stringify(M.CONFIG)), (cfgs[0] && cfgs[0].datos) || {});
  const CULT = { papa: 1, trigo: 1, avena: 1, cebada: 1 };
  const lotes = lotesTodos.filter(l => l.activo !== false && l.fecha_plantacion && CULT[l.cultivo] && l.lat != null);
  lotes.forEach(l => { l.fecha_plantacion = String(l.fecha_plantacion).slice(0, 10); });
  const hoy = hoyStr();

  // clima: un pronóstico por punto (redondeado ~1 km) desde la plantación más antigua del grupo
  const grupos = {};
  lotes.forEach(l => { const k = `${(+l.lat).toFixed(2)},${(+l.lon).toFixed(2)}`; (grupos[k] = grupos[k] || []).push(l); });
  const base = (lat, lon) => `latitude=${lat}&longitude=${lon}&hourly=${CAL.VARS}&timezone=America%2FSantiago&wind_speed_unit=kmh`;
  const aSerie = j => { const h = { time: j.hourly.time }; for (const k in CAL.CLAVES) h[CAL.CLAVES[k]] = j.hourly[k] || []; return h; };
  async function clima(lat, lon, desde) {
    const atras = Math.max(1, M.difDias(desde, hoy) + 1);
    const F = aSerie(await (await fetch(`https://api.open-meteo.com/v1/forecast?${base(lat, lon)}&past_days=${Math.min(92, atras)}&forecast_days=7`)).json());
    if (atras <= 92) return F;
    const A = aSerie(await (await fetch(`https://archive-api.open-meteo.com/v1/archive?${base(lat, lon)}&start_date=${desde}&end_date=${M.sumarDias(hoy, -91)}`)).json());
    const set = new Set(F.time), h = { time: [] }; Object.values(CAL.CLAVES).forEach(k => h[k] = []);
    A.time.forEach((t, i) => { if (set.has(t)) return; h.time.push(t); Object.values(CAL.CLAVES).forEach(k => h[k].push(A[k][i])); });
    F.time.forEach((t, i) => { h.time.push(t); Object.values(CAL.CLAVES).forEach(k => h[k].push(F[k][i])); });
    return h;
  }
  const res = []; let refH = null;
  for (const k in grupos) {
    const g = grupos[k], desde = g.map(l => l.fecha_plantacion).sort()[0];
    let h; try { h = await clima(g[0].lat, g[0].lon, desde); } catch (e) { console.log('Clima falló en', k, e.message); continue; }
    if (!refH) refH = h;
    const dias = M.diario(h, CFG);
    for (const l of g) {
      const S = M.serie(dias, l, CFG), ap = apps.filter(a => a.lote_id === l.id).map(a => Object.assign({}, a, { fecha: String(a.fecha).slice(0, 10) }));
      const dec = M.decidir(S.dias, l, ap, hoy, CFG);
      const pas = S.dias.filter(d => d.fecha <= hoy), fut = S.dias.filter(d => d.fecha > hoy), hd = pas[pas.length - 1];
      const prom = pas.slice(-7).concat(fut.slice(0, 7)); const gdProm = prom.length ? prom.reduce((t, d) => t + d.gd, 0) / prom.length : 0;
      const fechaGD = gd => { const d = S.dias.find(x => x.gdAc >= gd); if (d) return d.fecha; if (!hd || gdProm <= 0.3) return null; return M.sumarDias(hoy, Math.ceil((gd - hd.gdAc) / gdProm)); };
      const et = (CFG[l.cultivo] || CFG.papa).etapas, gdE = re => (et.find(e => re.test(e.n)) || {}).gd;
      const r = { l, dec: dec.global, prox: [], pend: [], insp: [] };
      if (l.cultivo === 'papa') {
        const ev = CAL.eventos((l.norma || {}).prog || 'lp'); CAL.cruzar(l, ev, ap);
        r.prox = ev.filter(e => !e.app && e.fecha >= hoy && e.fecha <= M.sumarDias(hoy, 2));
        r.pend = ev.filter(e => !e.app && e.fecha < hoy && e.fecha >= M.sumarDias(hoy, -7));
      }
      if (l.categoria) {
        const ws = l.cultivo === 'papa' ? [['1ª insp.', /Emergencia/, /Floraci/], ['2ª insp.', /Floraci/, /Desarrollo de tub/]] : [['insp.', /Z75/, /Z85/]];
        ws.forEach(([t, a, b]) => { const fa = fechaGD(gdE(a)), fb = fechaGD(gdE(b)); if (fa && fb && fb >= hoy && fa <= M.sumarDias(hoy, 7)) r.insp.push({ t, fa, fb }); });
      }
      res.push(r);
    }
  }
  if (!refH) throw new Error('No se pudo bajar el pronóstico.');
  const Sm = CAL.semana(refH, hoy, CFG), ven = M.ventanas(refH, ahoraStr(), CFG, 72);
  const corto = n => String(n).split(' · ')[0].replace(/\b(\w)(\w*)/g, (m, a, b) => a + b.toLowerCase());
  const aplicar = res.filter(r => r.prox.length || r.pend.length || r.dec === 'APLICAR');
  const partes = [];
  if (aplicar.length) {
    const nPend = aplicar.filter(r => r.pend.length).length, nHoy = aplicar.filter(r => !r.pend.length && r.prox.some(e => e.fecha === hoy)).length;
    const nTiz = aplicar.filter(r => r.dec === 'APLICAR').length;
    const prods = {}; aplicar.forEach(r => r.pend.concat(r.prox).forEach(e => { const p = String(e.prod).split(/ \(| o |,/)[0].trim(); (prods[p] = prods[p] || new Set()).add(r.l.id); }));
    const top = Object.entries(prods).sort((a, b) => b[1].size - a[1].size).slice(0, 3).map(([p, s]) => `${p} (${s.size})`);
    const det = [nPend && `${nPend} atrasado${nPend > 1 ? 's' : ''}`, nHoy && `${nHoy} para hoy`, nTiz && `${nTiz} por tizón`].filter(Boolean).join(', ');
    partes.push(`Aplicar en ${aplicar.length} lote${aplicar.length > 1 ? 's' : ''}${det ? ' (' + det + ')' : ''}${top.length ? ': ' + top.join(', ') : ''}`);
  }
  else partes.push('Sin aplicaciones del calendario para hoy y mañana');
  if (prods.some(p => p.stock != null)) {
    const Bd = CAL.balance(lotes, apps.map(a => Object.assign({}, a, { fecha: String(a.fecha).slice(0, 10) })), prods, hoy, M.sumarDias(hoy, 3));
    const fb = Bd.filas.filter(f => (f.estado === 'sin' || f.estado === 'falta') && f.n);
    if (fb.length) partes.push('Falta en bodega: ' + fb.slice(0, 3).map(f => f.estado === 'sin' ? f.nombre : `${f.nombre} (faltan ${Math.ceil(f.falta)} ${f.U})`).join(', '));
  }
  const ins = res.filter(r => r.insp.length);
  if (ins.length) partes.push(`Inspección SAG esta semana: ${ins.length} lote${ins.length > 1 ? 's' : ''}`);
  partes.push(`Sin lluvia: ${Sm.secos.map(d => fCorta(d.f).split(' ')[0]).join(', ') || 'ningún día'}`);
  if (Sm.ventosos.length) partes.push(`Viento ≥${CFG.aplicacion.vientoMax}: ${Sm.ventosos.map(d => fCorta(d.f).split(' ')[0]).join(', ')}`);
  const v = ven.lista[0]; if (v) partes.push(`Ventana: ${fCorta(v.ini.slice(0, 10))} ${v.ini.slice(11, 16)}–${pad(+v.fin.slice(11, 13) + 1)}:00`);
  const msg = { title: `AgroClima · ${fCorta(hoy)}`, body: partes.join(' · '), url: './#hoy', tag: 'agroclima-' + hoy };
  console.log('Aviso:', JSON.stringify(msg));

  webpush = require('web-push');
  webpush.setVapidDetails('mailto:agroclima@carlojaq.github.io', VAPID_PUB, VAPID_PRIV);
  let ok = 0;
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 6 * 3600 }); ok++; }
    catch (e) { console.log('Falló un teléfono:', e.statusCode || e.message); if (e.statusCode === 404 || e.statusCode === 410) await sb('DELETE', `ac_push?id=eq.${encodeURIComponent(s.id)}`); }
  }
  console.log(`Enviado a ${ok} de ${subs.length} teléfonos.`);
}
main().catch(e => { console.error(e); process.exit(1); });
